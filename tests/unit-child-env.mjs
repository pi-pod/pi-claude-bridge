/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { CC_CHILD_ENV, buildClaudeChildEnv, resolveClaudeChildEnv } = await import("../src/child-env.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction and claude.ai MCP servers", () => {
		assert.deepEqual(CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
	});

	it("injects Pi OAuth through Claude Code's supported token variable", () => {
		const env = buildClaudeChildEnv(
			{
				ANTHROPIC_API_KEY: "inherited-key",
				ANTHROPIC_AUTH_TOKEN: "inherited-token",
				ANTHROPIC_BASE_URL: "https://inherited.invalid",
				ANTHROPIC_CUSTOM_HEADERS: "authorization: inherited",
				CLAUDE_CODE_USE_BEDROCK: "1",
			},
			{ auth: { apiKey: "pi-oauth" }, source: "OAuth" },
		);
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "pi-oauth");
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
		assert.equal(env.ANTHROPIC_BASE_URL, undefined);
		assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
		assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
	});

	it("injects Pi API keys without leaving an inherited OAuth override", () => {
		const env = buildClaudeChildEnv(
			{ CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth", ANTHROPIC_BASE_URL: "https://inherited.invalid" },
			{
				auth: { apiKey: "pi-api-key", baseUrl: "https://pi-anthropic.invalid" },
				source: "ANTHROPIC_API_KEY",
			},
		);
		assert.equal(env.ANTHROPIC_API_KEY, "pi-api-key");
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
		assert.equal(env.ANTHROPIC_BASE_URL, "https://pi-anthropic.invalid");
	});

	it("routes Pi OAuth env credentials through Claude Code OAuth", () => {
		const env = buildClaudeChildEnv({}, {
			auth: { apiKey: "pi-oauth-env" },
			source: "ANTHROPIC_OAUTH_TOKEN",
		});
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "pi-oauth-env");
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
	});

	it("forwards Pi-resolved bearer auth and provider environment", () => {
		const env = buildClaudeChildEnv(
			{ ANTHROPIC_AUTH_TOKEN: "inherited-bearer" },
			{
				auth: { headers: { Authorization: "Bearer pi-bearer", "x-pi-header": "value" } },
				env: { PI_AUTH_CONTEXT: "resolved", ANTHROPIC_API_KEY: "ignored-shadow" },
				source: "ANTHROPIC_AUTH_TOKEN",
			},
		);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, "pi-bearer");
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-pi-header: value");
		assert.equal(env.PI_AUTH_CONTEXT, "resolved");
	});

	it("rejects inherited Claude Code auth when Pi has no Anthropic credential", () => {
		assert.throws(
			() => buildClaudeChildEnv({ CLAUDE_CODE_OAUTH_TOKEN: "cc-login" }),
			/No Anthropic credential is configured in Pi/,
		);
	});

	it("resolves the Anthropic credential through Pi for every child", async () => {
		const calls = [];
		const registry = {
			async getProviderAuth(provider) {
				calls.push(provider);
				return { auth: { apiKey: "fresh-token" }, source: "OAuth" };
			},
		};
		const env = await resolveClaudeChildEnv(registry, {});
		assert.deepEqual(calls, ["anthropic"]);
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "fresh-token");
	});

	it("requires a Pi model registry and resolved Anthropic credential", async () => {
		await assert.rejects(resolveClaudeChildEnv(null, { CLAUDE_CODE_OAUTH_TOKEN: "cc-login" }), /No Anthropic credential/);
		await assert.rejects(
			resolveClaudeChildEnv({ async getProviderAuth() { return undefined; } }, {}),
			/No Anthropic credential/,
		);
	});

	// Deliberately not asserted here: that every `query()` call site awaits the
	// helper. Grepping source would fail on innocent indirection and read as
	// coverage; the integration auth test exercises the actual child process.
});
