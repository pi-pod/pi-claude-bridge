import type { AuthResult } from "@earendil-works/pi-ai";

// Applied to every Claude Code subprocess the bridge spawns. Pi owns both its
// tool surface and context compaction, so Claude Code must not add either one.
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

export interface AnthropicAuthRegistry {
	getProviderAuth(provider: string): Promise<AuthResult | undefined>;
}

/** Build an isolated child environment from Pi's resolved Anthropic auth.
 *
 * Pi refreshes stored OAuth before getProviderAuth() resolves. Claude Code's
 * supported OAuth injection point is CLAUDE_CODE_OAUTH_TOKEN; API keys keep
 * using ANTHROPIC_API_KEY. All inherited Claude/Anthropic auth and alternate
 * backend settings are removed so every child relies exclusively on the
 * credential and endpoint resolved by Pi.
 */
export function buildClaudeChildEnv(
	base: NodeJS.ProcessEnv,
	resolved?: AuthResult,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, ...(resolved?.env ?? {}), ...CC_CHILD_ENV };
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_IDENTITY_TOKEN",
		"ANTHROPIC_IDENTITY_TOKEN_FILE",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_CUSTOM_HEADERS",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_CUSTOM_OAUTH_URL",
		"CLAUDE_CODE_OAUTH_CLIENT_ID",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_USE_VERTEX",
	] as const) delete env[key];

	const headers = Object.entries(resolved?.auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] != null);
	const authorization = headers.find(([name]) => name.toLowerCase() === "authorization")?.[1];
	const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	const headerApiKey = headers.find(([name]) => name.toLowerCase() === "x-api-key")?.[1];
	const credential = resolved?.auth.apiKey ?? headerApiKey;
	if (!credential && !bearerToken) {
		throw new Error("No Anthropic credential is configured in Pi. Configure Anthropic authentication in Pi before using claude-bridge.");
	}

	if (resolved?.auth.baseUrl) env.ANTHROPIC_BASE_URL = resolved.auth.baseUrl;
	const customHeaders = headers.filter(([name]) => !["authorization", "x-api-key"].includes(name.toLowerCase()));
	if (customHeaders.length > 0) {
		env.ANTHROPIC_CUSTOM_HEADERS = customHeaders.map(([name, value]) => `${name}: ${value}`).join("\n");
	}

	if (bearerToken) {
		env.ANTHROPIC_AUTH_TOKEN = bearerToken;
	} else if (resolved?.source?.toLowerCase().includes("oauth")) {
		env.CLAUDE_CODE_OAUTH_TOKEN = credential;
	} else {
		env.ANTHROPIC_API_KEY = credential;
	}
	return env;
}

export async function resolveClaudeChildEnv(
	registry: AnthropicAuthRegistry | null | undefined,
	base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
	const resolved = registry ? await registry.getProviderAuth("anthropic") : undefined;
	return buildClaudeChildEnv(base, resolved);
}
