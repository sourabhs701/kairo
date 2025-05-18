import { Kairo } from './DO/Kairo';
export default {
	async fetch(request, env, ctx) {
		const id = env.KAIRO.idFromName(new URL(request.url).pathname);
		const stub = env.KAIRO.get(id);
		const greeting = await stub.sayHello();

		return new Response(greeting);
	},
};

export { Kairo };
