#!/usr/bin/env node
// End-to-end cross-model handoff through real Pi. Claude bridge emits parallel
// and sequential tool turns; a non-Claude model must consume their results,
// then Claude must rebuild from the foreign turn without losing context.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const ALT_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const ALT_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");
const BRIDGE_PROVIDER = "claude-bridge";
const BRIDGE_MODEL = "claude-haiku-4-5";
const TIMEOUT = 180_000;
const CWD_PREFIX = join(tmpdir(), "pi-claude-bridge-cross-model-tools-");
const cwd = mkdtempSync(CWD_PREFIX);
const nonce = Math.random().toString(36).slice(2, 10);
const parallelValues = [`amber-${nonce}`, `birch-${nonce}`, `coral-${nonce}`];
const sequentialValue = `delta-${nonce}`;

for (let i = 0; i < parallelValues.length; i++) writeFileSync(join(cwd, `parallel-${i + 1}.txt`), `${parallelValues[i]}\n`);
writeFileSync(join(cwd, "pointer.txt"), "target.txt\n");
writeFileSync(join(cwd, "target.txt"), `${sequentialValue}\n`);

const harness = createRpcHarness({
	name: "cross-model-tools",
	args: ["--model", `${BRIDGE_PROVIDER}/${BRIDGE_MODEL}`],
	cwd,
	defaultTimeout: TIMEOUT,
});

async function turn(prompt) {
	const collector = harness.collectText();
	const ended = harness.waitForEvent("agent_end", TIMEOUT);
	await harness.send({ type: "prompt", message: prompt }, TIMEOUT);
	const event = await ended;
	return { text: collector.stop(), messages: event.messages ?? [] };
}

function toolCalls(messages) {
	return messages
		.filter((message) => message.role === "assistant")
		.map((message) => (Array.isArray(message.content) ? message.content.filter((block) => block.type === "toolCall") : []))
		.filter((calls) => calls.length > 0);
}

function requireValues(text, values, label) {
	for (const value of values) if (!text.includes(value)) throw new Error(`${label} missing ${value}: ${text}`);
}

await harness.startAndWait();
try {
	const parallel = await turn(
		"Call read exactly three times in one parallel tool turn for parallel-1.txt, parallel-2.txt, and parallel-3.txt. Then report the exact value from each file.",
	);
	requireValues(parallel.text, parallelValues, "bridge parallel response");
	const parallelCalls = toolCalls(parallel.messages);
	if (!parallelCalls.some((calls) => calls.length === 3)) {
		throw new Error(`bridge did not emit one three-call parallel turn: ${JSON.stringify(parallelCalls)}`);
	}

	await harness.send({ type: "set_model", provider: ALT_PROVIDER, modelId: ALT_MODEL });
	const foreignAfterParallel = await turn("Without calling tools, repeat the exact three file values the previous model found.");
	requireValues(foreignAfterParallel.text, parallelValues, "foreign parallel handoff");

	await harness.send({ type: "set_model", provider: BRIDGE_PROVIDER, modelId: BRIDGE_MODEL });
	const sequential = await turn(
		"Read pointer.txt first. Only after that result tells you the filename, read that file in a second tool turn. Report its exact value and also repeat the three earlier parallel values.",
	);
	requireValues(sequential.text, [...parallelValues, sequentialValue], "bridge sequential response");
	const sequentialCalls = toolCalls(sequential.messages);
	if (sequentialCalls.length < 2 || sequentialCalls[0].length !== 1 || sequentialCalls[1].length !== 1) {
		throw new Error(`bridge did not emit two sequential one-call turns: ${JSON.stringify(sequentialCalls)}`);
	}

	await harness.send({ type: "set_model", provider: ALT_PROVIDER, modelId: ALT_MODEL });
	const foreignAfterSequential = await turn("Without calling tools, repeat all four exact file values established in this conversation.");
	requireValues(foreignAfterSequential.text, [...parallelValues, sequentialValue], "foreign sequential handoff");

	await harness.send({ type: "set_model", provider: BRIDGE_PROVIDER, modelId: BRIDGE_MODEL });
	const bridgeReturn = await turn("Without calling tools, repeat all four exact file values. Be brief.");
	requireValues(bridgeReturn.text, [...parallelValues, sequentialValue], "bridge return handoff");
	console.log(`PASS: ${BRIDGE_PROVIDER}/${BRIDGE_MODEL} alternated with ${ALT_PROVIDER}/${ALT_MODEL} after parallel and sequential tools`);
} catch (error) {
	process.exitCode = 1;
	console.error(`FAIL: ${error.message}`);
	console.error(`  RPC log:   ${harness.RPC_LOG}`);
	console.error(`  Debug log: ${harness.DEBUG_LOG}`);
} finally {
	await harness.stop();
	rmSync(cwd, { recursive: true, force: true });
}
