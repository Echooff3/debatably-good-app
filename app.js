const createError = require('http-errors');
const http = require('http');
//const https = require('https'); // if we had a way to do secure content serving
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');

// session handling for 1 vote per user sessions
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const securityToken = require('uuid').v4();

const sessionParser = session({
	saveUninitialized: false,
	resave: false,
	store: new SQLiteStore,
	secret: '$eCuRiTy',
	cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
});

// pull in the debate app logic
const asm = require('./app/application-state-manager');

// create an instance of express to attach restful routes to
const app = express();

// Get a server instance, not the app instance, or express instance, 
// but the http server instance, which listens to the open port.
// We're passing the "app" express created to it for info purposes???
// I guess the app object has hooks the http service will pass info to.
const server = http.createServer(app);
// Get the lib for WebSocket so it can be used for const's later
const WebSocket = require('ws');
// Get the lib for creating a socket server instance
const SocketServer = WebSocket.Server;
// Give the socket server lib for the http server to use as its connection proxy
const wss = new SocketServer({
	verifyClient: (info, done) => {
		sessionParser(info.req, {}, () => {
			// We can reject the connection by returning false to done(). For example,
			// reject here if user is unknown.

			// Comment above (from sample code) probably means I should do real session validation
			// if this is expected to ever be used as a real auth process. This is just handling/parsing
			// sessions for the socket connections so we can get req.session.userId in them

			done(info.req.session.userId);
		});
	},
	server
});

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// manage 1 session per user middleware
app.use(sessionParser);
// initialize session data structure for all the routers to use
app.use((req, res, next) => {
	const session = req.session;
	// Session store of debate info is keyed off of sessionCodes, so i need a map for that
	if (!session.activeDebates) { session.activeDebates = {}; }
	next();
});

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// import route definitions
const addRouter = (app, name) => {
	const router = require('./routes/' + name);
	app.use('/' + name, router);
};

const indexRouter = require('./routes/index');
app.use('/', indexRouter);

addRouter(app, 'create-debate');
addRouter(app, 'moderate-debate');
addRouter(app, 'vote-on-debate');

// catch 404 and forward to error handler
app.use(function(req, res, next) {
	next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
	// set locals, only providing error in development
	res.locals.message = err.message;
	res.locals.error = req.app.get('env') === 'development' ? err : {};

	// render the error page
	res.status(err.status || 500);
	res.render('error');
});

let socketConnections = [];

/**
 * @param {WebSocket} ws 
 */
let SessionToSocketMap = function (ws, role) {
	this.ws = ws;
	this.role = role;
};

/**
 * @param {WebSocket} offendingWs 
 */
const removeDeadSockets = (offendingWs) => {
	socketConnections.forEach((s2sMap, index) => {
		if(s2sMap.ws === offendingWs) {
			delete socketConnections[index];
		}
	});
};


/**
 *  MANAGE ALL OUTBOUND COMMUNICATION
 * */
const updateSessions = () => {
	const runningSessions = asm.getRunningSessions();
	
	runningSessions.forEach(debate => {
		socketConnections.forEach(connectedUser => {
			const role = connectedUser.role;
			const socket = connectedUser.ws;
			if (role.isModerator && debate.getModeratorId() === role.moderatorId) {
				if (socket.readyState === WebSocket.OPEN) {
					const message = JSON.stringify({
						type: 'moderator-update', 
						data: { 
							chartData: debate.calculateDebateResults(),
							debateDetails: {
								allowedDuration: debate.allowedDuration,
								startTime: debate.startTime,
								started: debate.started,
								completed: debate.completed,
								timeRemaining: debate.getTimeRemaining(),
								duration: debate.getAllowedDuration()
							},
							audience: debate.getAudience().length > 0 ? 
								debate.getAudience() : 
								['nobody yet']
						}
					});
					socket.send(message);
				}
			}
		})
	});
};

const broadcastToVoters = (event, debate) => {
	const message = JSON.stringify(event);

	socketConnections.forEach(connectedUser => {
		const role = connectedUser.role;
		const socket = connectedUser.ws;
		if (role.isVoter && asm.get(role.sessionCode) === debate) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(message);
			}
		}
	});
};

const startDebate = (debate) => {
	broadcastToVoters({
		type: 'start'
	}, debate);
};

const endDebate = (debate) => {
	broadcastToVoters({
		type: 'end'
	}, debate);
};

setInterval(() => {
	// console.log('update sessions', Date.now());
		updateSessions();
	}, 200
);

const role = require('./app/role');

/**
 *  MANAGE ALL INBOUND COMMUNICATION
 * */
const recordSocketToDebateSession = (ws, session, debate, role) => {
	socketConnections.push(new SessionToSocketMap(ws, role));
	console.log('event received as:',  
		',as moderator:', role.isModerator, 
		',as voter:', role.isVoter,
		',as session:', session.userId,
		',for debate:', debate.sessionCode, 
		',starting:', debate.startTime, 
		',for this long:', debate.allowedDuration, 
		',as started:', debate.started, 
		',as completed:', debate.completed);
};

const moderatorSocketRouter = (ws, session, debate, role) => {
	if (role.isModerator) {
		ws.on('message', (data) => {
			const event = JSON.parse(data.toString());
			console.log('Moderator event of type', event.type);
			switch (event.type) {
				case 'start-session':
					debate.startDebate(function endDebateCallback() {
						endDebate(debate);
					});
					startDebate(debate);
					break;
				case 'close-debate':
				case 'close-any-existing-debates':
					asm.deleteAllDebatesForThisModerator(role.moderatorId);
					// no idea if if this actually works for sessions.
					delete session.activeDebates[debate.sessionCode];
					break;
				default:
					console.log('Unkown event type received:', event.type);
					break;
			}
		});
	}
};

const voterSocketRouter = (ws, session, debate, role) => {
	if (role.isVoter) {
		ws.on('message', (data) => {
			const event = JSON.parse(data.toString());
			console.log('Voter event of type', event.type);
			switch (event.type) {
				case 'vote': 
					const voter = debate.getVoterById(role.voterId);
					voter.placeVote(event.data.participant);
					break;
				case 'voter-check-in': 
					let state;
					if (debate.completed) { state = 'end'; }
					else if (debate.started) { state = 'start'; }
					else { state = 'pending'; }
	
					ws.send(JSON.stringify({
						type: state
					}));
					break;
				default:
					console.log('Unkown event type received:', event.type);
					break;
			}
		});
	}
};

const querystring = require('querystring');

const authenticateDebateSocketRequest = (session, url, ws, socketHandler) => {
	console.log(url.query);
	const qs = querystring.parse(url.query);
	if (qs && qs.sessionCode) {
		const sessionCode = ''+qs.sessionCode;
		// Ops that go with socket functionality require the user to have a sessionCode
		if (session.activeDebates) {
			const role = session.activeDebates[sessionCode];
			if (role) {
				const debate = asm.get(sessionCode);
				if (debate && debate.sessionCode) {
					recordSocketToDebateSession(ws, session, debate, role);
					socketHandler(ws, session, debate, role);
					return true;
				} else {
					console.log('socket missing debate or debate session code');
				}
			} else {
				console.log('socket missing role');
			}
		} else {
			console.log('socket missing active debates');
		}
	} else {
		console.log('socket missing "sessionCode" param');
	}
	// if we get here, the socket request was missing something. close it.
	ws.close();
	return false;
};

const URL = require('url');

// on connection is different than on open in that you get request info 
// you can use to parse things like session cookies and such, which we do and store.
wss.on('connection', (ws, req) => {
	console.log('got a connection');

	const session = req.session;
	const url = URL.parse(req.url);
	const path = url.pathname.split('/');

	console.log(url, path);

	switch (path[1]) {
		case 'create-debate':
			let killableSessions = asm.deleteAllDebatesForThisModerator(session.userId);
			// no idea if if this actually works for sessions.
			killableSessions.forEach(closedSession => {
				delete session.activeDebates[closedSession];
			});
			break;
		case 'moderate-debate':
			authenticateDebateSocketRequest(session, url, ws, moderatorSocketRouter);
			break;
		case 'vote-on-debate':
			authenticateDebateSocketRequest(session, url, ws, voterSocketRouter);
			break;
		default:
			console.log('Unsupported socket request type.');
			break;
	}
	
	ws.on('close', (code, reason) => {
		console.log('Session closed', code, reason);
		removeDeadSockets(ws);
	});

	// ws.on('error', (error) => {
	// 	console.log('error', error);
	// 	removeDeadSockets(ws);
	// });

});

module.exports = { 
	app: app, 
	server: server
};
