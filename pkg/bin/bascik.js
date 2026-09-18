#!/usr/bin/env node

const MIN_MAJOR = 22;
const MIN_MINOR = 18;

const [majorRaw, minorRaw] = process.versions.node.split(".");
const major = Number(majorRaw ?? 0);
const minor = Number(minorRaw ?? 0);
const unsupported =
	Number.isNaN(major) ||
	Number.isNaN(minor) ||
	major < MIN_MAJOR ||
	(major === MIN_MAJOR && minor < MIN_MINOR);

if (unsupported) {
	console.error(
		`[bascik] Node.js ${MIN_MAJOR}.${MIN_MINOR}.0 or newer is required. ` +
		`Detected ${process.versions.node}.`,
	);
	process.exit(1);
}

const distEntrypoint = "../dist/index.js";
let runCli;
let installProcessCrashHandlers;
try {
	({ runCli, installProcessCrashHandlers } = await import(distEntrypoint));
} catch (err) {
	const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
	const message = err instanceof Error ? err.message : String(err);
	const missingDist =
		code === "ERR_MODULE_NOT_FOUND" &&
		(message.includes("/dist/index.js") || message.includes("../dist/index.js"));
	if (missingDist) {
		console.error(
			"[bascik] Could not start because pkg/dist/index.js is missing. " +
			"Build the package first: `yarn workspace @bascik/bascik build`.",
		);
		process.exit(1);
	}
	throw err;
}

// The bin wrapper is the package-manager entrypoint (node_modules/.bin/bascik
// symlinks here). It must invoke the exported CLI directly rather than rely on
// main-module detection inside dist/index.js: when launched through the
// symlink, process.argv[1] ends with "bascik" (not "bascik.js") and does not
// resolve to dist/index.js, so an isMain check there would never fire and the
// CLI would silently no-op. Invoking runCli here keeps the CLI boundary in one
// place and preserves the crash-net + single-line error handling.
installProcessCrashHandlers();
try {
	await runCli(process.argv.slice(2), { exitOnFinish: true });
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
