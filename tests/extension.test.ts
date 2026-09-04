import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import runReviewExtension from "../extensions/run-review.js";
import type { MessageContentSummary, ValueSummary } from "../src/redaction.js";
import type { ReviewEvent, RunReport } from "../src/schema.js";

test("默认扩展采集不持久化消息、工具参数或 provider payload 原文", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-privacy-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const notifications: string[] = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => Promise<void>) {
      handlers.set(name, handler);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  runReviewExtension(pi);

  const ctx = {
    cwd,
    model: undefined,
    sessionManager: { getSessionId: () => "session_privacy" },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const invoke = async (name: string, ...args: unknown[]): Promise<void> => {
    const handler = handlers.get(name);
    assert.ok(handler, `missing handler: ${name}`);
    await handler(...args);
  };

  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  const privateArgs = { command: "npm test -- --token=super-secret-value", path: "C:\\Users\\alice\\private.ts" };
  await invoke("tool_execution_start", { toolCallId: "call_1", toolName: "bash", args: privateArgs }, ctx);
  await invoke("tool_execution_end", { toolCallId: "call_1", toolName: "bash", isError: false, result: { exitCode: 0 } }, ctx);
  await invoke("message_end", { message: { role: "user", content: "private user prompt alpha-42" } }, ctx);
  await invoke("message_end", { message: { role: "assistant", content: "任务已经完成，测试已通过。private answer beta-43" } }, ctx);
  await invoke("before_provider_request", { payload: { messages: [{ content: "provider secret gamma-44" }] } }, ctx);
  await invoke("agent_settled", {}, ctx);

  const eventsPath = join(cwd, ".pi", "run-review", "events.jsonl");
  const rawEvents = await readFile(eventsPath, "utf8");
  for (const privateText of ["super-secret-value", "C:\\Users\\alice", "alpha-42", "beta-43", "gamma-44", "npm test"]) {
    assert.equal(rawEvents.includes(privateText), false, `event log leaked: ${privateText}`);
  }

  const events = rawEvents.trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  const toolStarted = events.find((event) => event.type === "tool_started");
  const toolPayload = toolStarted?.payload as { args?: unknown; argsSummary?: ValueSummary; verificationKey?: string };
  assert.equal(toolPayload.args, undefined);
  assert.match(String(toolPayload.argsSummary?.hash), /^sha256:[a-f0-9]{64}$/);
  assert.equal(toolPayload.verificationKey, "verification:0");
  const providerRequest = events.find((event) => event.type === "provider_request");
  const providerPayload = providerRequest?.payload as { payload?: unknown; payloadSummary?: ValueSummary };
  assert.equal(providerPayload.payload, undefined);
  assert.match(String(providerPayload.payloadSummary?.hash), /^sha256:[a-f0-9]{64}$/);
  const assistantMessage = events.find((event) => event.type === "message" && event.payload.role === "assistant");
  const messagePayload = assistantMessage?.payload as { content?: unknown; contentSummary?: MessageContentSummary };
  assert.equal(messagePayload.content, undefined);
  assert.equal(messagePayload.contentSummary?.completionClaim, true);

  const reportsDir = join(cwd, ".pi", "run-review", "reports");
  const reportFile = notifications[0]?.match(/run_[^\\/]+\.json/)?.[0];
  assert.ok(reportFile);
  const report = JSON.parse(await readFile(join(reportsDir, reportFile), "utf8")) as RunReport;
  assert.equal(report.run.captureMode, "redacted");
});
