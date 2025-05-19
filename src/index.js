export { ChatRoom } from './DO/ChatRoom';
export { RateLimiter } from './DO/RateLimiter';
import HTML from './chatroom.html';
import { handleErrors } from './util/errors';

const PUBLIC_ROOMS = [{ id: 'general', name: 'General Chat' }];
// The IDs returned by `newUniqueId()` are unguessable, so are a valid way to implement
// "anyone with the link can access" sharing

export default {
	async fetch(request, env) {
		return handleErrors(request, async () => {
			let url = new URL(request.url);
			let path = url.pathname.slice(1).split('/');

			if (!path[0]) {
				return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
			}

			switch (path[0]) {
				case 'api':
					return handleApiRequest(path.slice(1), request, env);

				default:
					return new Response('Not found', { status: 404 });
			}
		});
	},
};

async function handleApiRequest(path, request, env, ctx) {
	switch (path[0]) {
		case 'room': {
			if (!path[1]) {
				if (request.method == 'GET') {
					// Fetch user counts for each room
					const roomsWithCounts = await Promise.all(
						PUBLIC_ROOMS.map(async (room) => {
							const id = env.CHAT_ROOMS.idFromName(room.id);
							const roomObject = env.CHAT_ROOMS.get(id);
							try {
								// Correctly fetch the count from the Durable Object
								const countResp = await roomObject.fetch('https://dummy-host/count');
								let users = 0;
								if (countResp.ok) {
									const data = await countResp.json();
									users = data.count || 0;
								}
								return {
									id: room.id,
									name: room.name,
									users,
								};
							} catch (error) {
								console.error('Error fetching room count:', error);
								return {
									id: room.id,
									name: room.name,
									users: 0,
								};
							}
						})
					);
					return new Response(JSON.stringify(roomsWithCounts), {
						headers: { 'Content-Type': 'application/json' },
					});
				} else {
					return new Response('Method not allowed', { status: 404 });
				}
			}

			const name = path[1];
			const id = env.CHAT_ROOMS.idFromName(name);
			const roomObject = env.CHAT_ROOMS.get(id);
			let newUrl = new URL(request.url);
			newUrl.pathname = '/' + path.slice(2).join('/');
			return roomObject.fetch(newUrl, request);
		}
		case 'rate-limit': {
			// Get the client's IP address
			const ip = request.headers.get('CF-Connecting-IP');
			const id = env.RATE_LIMITERS.idFromName(ip);
			const rateLimiter = env.RATE_LIMITERS.get(id);

			// Forward the request to the rate limiter
			// GET will just check status, POST will increment the count
			return rateLimiter.fetch(request);
		}
		default:
			return new Response('Not Found', { status: 404 });
	}
}
