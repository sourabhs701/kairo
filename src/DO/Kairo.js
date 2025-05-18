import { DurableObject } from 'cloudflare:workers';
export class Kairo extends DurableObject {
	constructor(ctx, env) {
		// Required, as we are extending the base class.
		super(ctx, env);
	}

	async sayHello() {
		let result = this.ctx.storage.sql.exec("SELECT 'Hello, Kairo!' as greeting").one();
		return result.greeting;
	}
}
