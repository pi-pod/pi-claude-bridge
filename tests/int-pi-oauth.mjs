#!/usr/bin/env node
// Proves the bridge authenticates Agent SDK children exclusively through the
// credential Pi resolves. An empty CLAUDE_CONFIG_DIR plus invalid inherited
// credentials proves Pi OAuth injection; a second probe supplies an invalid Pi
// credential while leaving Claude Code login visible and verifies there is no
// login fallback.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const CLAUDE_DIR_PREFIX = join(tmpdir(), "pi-claude-bridge-pi-oauth-");
const CLAUDE_DIR = mkdtempSync(CLAUDE_DIR_PREFIX);
const harness = createRpcHarness({
	name: "pi-oauth",
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	env: {
		CLAUDE_CONFIG_DIR: CLAUDE_DIR,
		ANTHROPIC_API_KEY: "invalid-inherited-sentinel",
		CLAUDE_CODE_OAUTH_TOKEN: "invalid-inherited-sentinel",
	},
	defaultTimeout: 180_000,
});

await harness.startAndWait();
try {
	const text = await harness.promptAndWait("Reply with exactly PI_OAUTH_OK.");
	if (!text.includes("PI_OAUTH_OK")) throw new Error(`bridge did not use Pi OAuth: ${text}`);
	console.log("PASS: empty Claude config authenticated with Pi-stored Anthropic OAuth");
} catch (error) {
	process.exitCode = 1;
	console.error(`FAIL: ${error.message}`);
	console.error(`  RPC log:   ${harness.RPC_LOG}`);
	console.error(`  Debug log: ${harness.DEBUG_LOG}`);
} finally {
	await harness.stop();
	rmSync(CLAUDE_DIR, { recursive: true, force: true });
}

const PI_AUTH_DIR = mkdtempSync(join(tmpdir(), "pi-claude-bridge-invalid-pi-auth-"));
writeFileSync(
join(PI_AUTH_DIR, "auth.json"),
	JSON.stringify({ anthropic: { type: "api_key", key: "invalid-pi-auth-sentinel" } }),
	{ mode: 0o600 },
);
const noFallbackHarness = createRpcHarness({
	name: "pi-auth-no-cc-fallback",
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	env: { PI_CODING_AGENT_DIR: PI_AUTH_DIR },
	defaultTimeout: 180_000,
});

await noFallbackHarness.startAndWait();
try {
	const text = await noFallbackHarness.promptAndWait("Reply with exactly CC_LOGIN_FALLBACK_USED.");
	if (text.includes("CC_LOGIN_FALLBACK_USED")) throw new Error("bridge fell back to Claude Code login");
	const debug = readFileSync(noFallbackHarness.DEBUG_LOG, "utf8");
	if (!/invalid.*(?:api[_ -]?key|x-api-key)|authentication_error/i.test(debug)) {
		throw new Error(`invalid Pi credential did not reach Claude: ${debug.slice(-1000)}`);
	}
	console.log("PASS: invalid Pi credential did not fall back to Claude Code login");
} catch (error) {
	process.exitCode = 1;
	console.error(`FAIL: ${error.message}`);
	console.error(`  RPC log:   ${noFallbackHarness.RPC_LOG}`);
	console.error(`  Debug log: ${noFallbackHarness.DEBUG_LOG}`);
} finally {
	await noFallbackHarness.stop();
	rmSync(PI_AUTH_DIR, { recursive: true, force: true });
}
