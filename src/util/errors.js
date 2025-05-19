/**
 * Utility function for handling errors in fetch handlers
 * @param {Request} request - The incoming request
 * @param {Function} func - The async function to execute
 * @returns {Response} - The response with appropriate error handling
 */
export async function handleErrors(request, func) {
	try {
		return await func();
	} catch (err) {
		if (request.headers.get('Upgrade') == 'websocket') {
			let pair = new WebSocketPair();
			pair[1].accept();
			pair[1].send(JSON.stringify({ error: err.stack }));
			pair[1].close(1011, 'Uncaught exception during session setup');
			return new Response(null, { status: 101, webSocket: pair[0] });
		} else {
			return new Response(err.stack, { status: 500 });
		}
	}
}
