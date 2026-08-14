import { Command } from "commander";
import { randomInt } from "node:crypto";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region lib/types/startup.js
/**
* The web app's command-line provider: it parses the `dsh --profile web` flag
* family (`--host`, `--port`, `--trusted-host`, `--pair-pin`) and its `--help`
* text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
* Ordinary rows inject that service before reading it from lazy config.
* @module @deepseek-ai/dsh-web-app/startup
*/
/** Stable Cordis plugin name. */
const name = "web-startup";
/** Services required before the flags can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
const WEB_STARTUP_SERVICE = "webStartup";
/** Accepted `--pair-pin` shape: 4-8 ASCII digits. */
const PAIR_PIN_PATTERN = /^\d{4,8}$/;
/**
* This app's command: its flags, its description, and its help text.
* @returns a fresh program, so one process can parse more than once (tests).
*/
function webCommand() {
	return new Command().name("dsh --profile web").description("Serve the DeepSeek Harness browser UI.").helpOption("-h, --help", "show this help").option("--host <host>", "bind host").option("--port <port>", "listen port; pass 0 to let the OS pick a free one").option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)").option("--pair-pin <pin>", "pairing PIN non-loopback clients must enter once (4-8 digits; random when binding 0.0.0.0)").addHelpText("after", `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           serve LAN/Tailscale clients (a random pairing PIN is printed)
  dsh --profile web --host 0.0.0.0 --pair-pin 483920   use a fixed pairing PIN
`);
}
/**
* Parse and provide the Web invocation as an ordinary Cordis service. The
* command's action publishes the flags this invocation named; a non-numeric
* `--port` or a malformed `--pair-pin` is a usage error, so on rejection (and
* on `--help`) nothing is provided. Binding 0.0.0.0 arms device pairing: every
* non-loopback client must present the PIN before /api serves it, and a random
* PIN is generated when the invocation does not name one.
* @param ctx - plugin context carrying the command line.
*/
function apply(ctx) {
	const program = webCommand();
	program.action(() => {
		const options = program.opts();
		if (options.port !== void 0 && !/^\d+$/.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
		let pairPin;
		if (options.pairPin !== void 0) {
			if (!PAIR_PIN_PATTERN.test(options.pairPin)) program.error(`error: --pair-pin must be 4-8 digits, got ${JSON.stringify(options.pairPin)}`);
			pairPin = options.pairPin;
		} else if (options.host === "0.0.0.0") {
			pairPin = String(randomInt(0, 1e6)).padStart(6, "0");
		}
		ctx.provide(WEB_STARTUP_SERVICE, {
			...options.host !== void 0 && { host: options.host },
			...options.port !== void 0 && { port: Number(options.port) },
			trustedHosts: options.trustedHost ?? [],
			...pairPin !== void 0 && { pairPin }
		});
	});
	parseCmdline(ctx, program);
}
//#endregion
export { WEB_STARTUP_SERVICE, apply, inject, name };
