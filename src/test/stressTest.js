import WebSocket from 'ws';

const TOTAL_USERS = 10;
const WEBSOCKET_URL = 'ws://localhost:8787/api/room/general/websocket';
const MESSAGE_INTERVAL_MS = 1000; // users try every 1s
const RATE_LIMIT_DELAY = 5000; // 1 message per 5s
const GRACE_LIMIT = 5; // allow burst of 5

let report = {
	totalSent: 0,
	totalBlocked: 0,
	connections: 0,
	errors: 0,
};

function createUser(id) {
	const ws = new WebSocket(WEBSOCKET_URL);
	let messagesSent = 0;
	let graceUsed = 0;
	let nextAllowedTime = Date.now();

	ws.on('open', () => {
		report.connections++;
		ws.send(JSON.stringify({ name: `user${id}` }));
		console.log(`User ${id} connected`);

		const interval = setInterval(() => {
			const now = Date.now();
			if (graceUsed < GRACE_LIMIT || now >= nextAllowedTime) {
				const msg = { message: `Hello from user${id}` };
				ws.send(JSON.stringify(msg));
				report.totalSent++;
				if (graceUsed < GRACE_LIMIT) {
					graceUsed++;
				} else {
					nextAllowedTime = now + RATE_LIMIT_DELAY;
				}
				messagesSent++;
			} else {
				report.totalBlocked++;
			}

			if (messagesSent >= 10) {
				clearInterval(interval);
				ws.close();
			}
		}, MESSAGE_INTERVAL_MS);
	});

	ws.on('message', (data) => {
		const msg = data.toString();
		if (msg.includes('rate-limited')) {
			report.totalBlocked++;
		}
	});

	ws.on('error', (err) => {
		console.error(`User ${id} error:`, err.message);
		report.errors++;
	});

	ws.on('close', () => {
		console.log(`User ${id} disconnected`);
	});
}

for (let i = 0; i < TOTAL_USERS; i++) {
	setTimeout(() => createUser(i), i * 20); // stagger connections
}

process.on('exit', () => {
	console.log('\n\n📊 Test Report:');
	console.table(report);
});
