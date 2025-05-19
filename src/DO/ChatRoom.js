import { DurableObject } from 'cloudflare:workers';
import { RateLimiterClient } from './RateLimiter';
import { handleErrors } from '../util/errors';

export class ChatRoom extends DurableObject {
	constructor(state, env) {
		super(state, env);
		this.state = state;
		this.env = env;
		this.storage = state.storage;
		// Store WebSocket connections
		this.sessions = new Map();

		this.state.getWebSockets().forEach((webSocket) => {
			let meta = webSocket.deserializeAttachment();
			let limiterId = this.env.RATE_LIMITERS.idFromString(meta.limiterId);
			let limiter = new RateLimiterClient(
				() => this.env.RATE_LIMITERS.get(limiterId),
				(err) => webSocket.close(1011, err.stack)
			);
			let blockedMessages = [];
			this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
		});

		this.lastTimestamp = 0;
	}

	async fetch(request) {
		return handleErrors(request, async () => {
			const url = new URL(request.url);

			// Handle WebSocket connections
			switch (url.pathname) {
				case '/websocket': {
					// The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
					// WebSocket session.
					if (request.headers.get('Upgrade') != 'websocket') {
						return new Response('expected websocket', { status: 400 });
					}

					// Get the client's IP address for use with the rate limiter.
					let ip = request.headers.get('CF-Connecting-IP');

					// To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
					// i.e. two WebSockets that talk to each other), we return one end of the pair in the
					// response, and we operate on the other end. Note that this API is not part of the
					// Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
					// any way to act as a WebSocket server today.
					let pair = new WebSocketPair();

					// We're going to take pair[1] as our end, and return pair[0] to the client.
					await this.handleSession(pair[1], ip);

					// Now we return the other end of the pair to the client.
					return new Response(null, { status: 101, webSocket: pair[0] });
				}
				case '/count': {
					return new Response(
						JSON.stringify({
							count: this.sessions.size,
						}),
						{
							headers: {
								'Content-Type': 'application/json',
								'Access-Control-Allow-Origin': '*',
							},
						}
					);
				}
				default:
					return new Response('Not found', { status: 404 });
			}
		});
	}

	async handleSession(webSocket, ip) {
		// Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
		// WebSocket in JavaScript, not sending it elsewhere.
		this.state.acceptWebSocket(webSocket);

		// Set up our rate limiter client.
		let limiterId = this.env.RATE_LIMITERS.idFromName(ip);
		let limiter = new RateLimiterClient(
			() => this.env.RATE_LIMITERS.get(limiterId),
			(err) => webSocket.close(1011, err.stack)
		);

		// Create our session and add it to the sessions map.
		let session = { limiterId, limiter, blockedMessages: [] };
		// attach limiterId to the webSocket so it survives hibernation
		webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
		this.sessions.set(webSocket, session);

		// Queue "join" messages for all online users, to populate the client's roster.
		for (let otherSession of this.sessions.values()) {
			if (otherSession.name) {
				session.blockedMessages.push(JSON.stringify({ joined: otherSession.name }));
			}
		}

		// Load the last 100 messages from the chat history stored on disk, and send them to the
		// client.
		let storage = await this.storage.list({ reverse: true, limit: 100 });
		let backlog = [...storage.values()];
		backlog.reverse();
		backlog.forEach((value) => {
			session.blockedMessages.push(value);
		});
	}

	async webSocketMessage(webSocket, msg) {
		try {
			let session = this.sessions.get(webSocket);
			if (session.quit) {
				// Whoops, when trying to send to this WebSocket in the past, it threw an exception and
				// we marked it broken. But somehow we got another message? I guess try sending a
				// close(), which might throw, in which case we'll try to send an error, which will also
				// throw, and whatever, at least we won't accept the message. (This probably can't
				// actually happen. This is defensive coding.)
				webSocket.close(1011, 'WebSocket broken.');
				return;
			}

			// Check if the user is over their rate limit and reject the message if so.
			if (!session.limiter.checkLimit()) {
				webSocket.send(
					JSON.stringify({
						error: 'Your IP is being rate-limited, please try again later.',
					})
				);
				return;
			}

			// I guess we'll use JSON.
			let data = JSON.parse(msg);

			if (!session.name) {
				// The first message the client sends is the user info message with their name. Save it
				// into their session object.
				session.name = '' + (data.name || 'anonymous');
				// attach name to the webSocket so it survives hibernation
				webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

				// Don't let people use ridiculously long names. (This is also enforced on the client,
				// so if they get here they are not using the intended client.)
				if (session.name.length > 32) {
					webSocket.send(JSON.stringify({ error: 'Name too long.' }));
					webSocket.close(1009, 'Name too long.');
					return;
				}

				// Deliver all the messages we queued up since the user connected.
				session.blockedMessages.forEach((queued) => {
					webSocket.send(queued);
				});
				delete session.blockedMessages;

				// Broadcast to all other connections that this user has joined.
				this.broadcast({ joined: session.name });

				webSocket.send(JSON.stringify({ ready: true }));
				return;
			}

			// Construct sanitized message for storage and broadcast.
			data = { name: session.name, message: '' + data.message };

			// Block people from sending overly long messages. This is also enforced on the client,
			// so to trigger this the user must be bypassing the client code.
			if (data.message.length > 256) {
				webSocket.send(JSON.stringify({ error: 'Message too long.' }));
				return;
			}

			// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
			// messages at the same time (or if the clock somehow goes backwards????), we'll assign
			// them sequential timestamps, so at least the ordering is maintained.
			data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
			this.lastTimestamp = data.timestamp;

			// Broadcast the message to all other WebSockets.
			let dataStr = JSON.stringify(data);
			this.broadcast(dataStr);

			// Save message.
			let key = new Date(data.timestamp).toISOString();
			await this.storage.put(key, dataStr);
		} catch (err) {
			// Report any exceptions directly back to the client. As with our handleErrors() this
			// probably isn't what you'd want to do in production, but it's convenient when testing.
			webSocket.send(JSON.stringify({ error: err.stack }));
		}
	}

	// On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
	// a quit message.
	async closeOrErrorHandler(webSocket) {
		let session = this.sessions.get(webSocket) || {};
		session.quit = true;
		this.sessions.delete(webSocket);
		if (session.name) {
			this.broadcast({ quit: session.name });
		}
	}

	async webSocketClose(webSocket, code, reason, wasClean) {
		this.closeOrErrorHandler(webSocket);
	}

	async webSocketError(webSocket, error) {
		this.closeOrErrorHandler(webSocket);
	}

	// broadcast() broadcasts a message to all clients.
	broadcast(message) {
		// Apply JSON if we weren't given a string to start with.
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
		}

		// Iterate over all the sessions sending them messages.
		let quitters = [];
		this.sessions.forEach((session, webSocket) => {
			if (session.name) {
				try {
					webSocket.send(message);
				} catch (err) {
					// Whoops, this connection is dead. Remove it from the map and arrange to notify
					// everyone below.
					session.quit = true;
					quitters.push(session);
					this.sessions.delete(webSocket);
				}
			} else {
				// This session hasn't sent the initial user info message yet, so we're not sending them
				// messages yet (no secret lurking!). Queue the message to be sent later.
				session.blockedMessages.push(message);
			}
		});

		quitters.forEach((quitter) => {
			if (quitter.name) {
				this.broadcast({ quit: quitter.name });
			}
		});
	}
}
