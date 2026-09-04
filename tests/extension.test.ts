import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import runReviewExtension from "../extensions/run-review.js";
import { summarizeValue, type MessageContentSummary, type ValueSummary } from "../src/redaction.js";
import type { ReviewEvent, RunReport } from "../src/schema.js";

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function hasJsonReport(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).some((file) => file.endsWith(".json"));
  } catch {
    return false;
  }
}

function createExtensionHarness(): {
  invoke: (name: string, ...args: unknown[]) => Promise<void>;
  invokeCommand: (name: string, args: string, ctx: unknown) => Promise<void>;
  notifications: string[];
} {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notifications: string[] = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => Promise<void>) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  runReviewExtension(pi);
  return {
    notifications,
    invoke: async (name: string, ...args: unknown[]): Promise<void> => {
      const handler = handlers.get(name);
      assert.ok(handler, `missing handler: ${name}`);
      await handler(...args);
    },
    invokeCommand: async (name: string, args: string, ctx: unknown): Promise<void> => {
      const handler = commands.get(name);
      assert.ok(handler, `missing command: ${name}`);
      await handler(args, ctx);
    },
  };
}

function context(cwd: string, notifications: string[]): Record<string, unknown> {
  return {
    cwd,
    model: undefined,
    sessionManager: { getSessionId: () => "session_test" },
    ui: { notify: (message: string) => notifications.push(message) },
  };
}

test("默认扩展采集不持久化消息、工具参数或 provider payload 原文", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-privacy-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);

  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  const privateArgs = { command: "npm test -- --token=super-secret-value", path: "C:\\Users\\alice\\private.ts" };
  await invoke("tool_execution_start", { toolCallId: "call_1", toolName: "bash", args: privateArgs }, ctx);
  await invoke("tool_execution_end", { toolCallId: "call_1", toolName: "bash", isError: false, result: { exitCode: 0 } }, ctx);
  await invoke("message_end", { message: { role: "user", content: "private user prompt alpha-42" } }, ctx);
  await invoke("message_end", { message: { role: "assistant", content: "任务已经完成，测试已通过。private answer beta-43" } }, ctx);
  await invoke("before_provider_request", { payload: { messages: [{ content: "provider secret gamma-44" }] } }, ctx);
  await invoke("agent_settled", {}, ctx);
  assert.equal(notifications.some((message) => message.includes("报告生成已排队")), true);

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
  await waitFor(() => hasJsonReport(reportsDir), "settled 后未异步生成隐私测试报告");
  const reportFile = notifications[0]?.match(/run_[^\\/]+\.json/)?.[0];
  assert.ok(reportFile);
  const report = JSON.parse(await readFile(join(reportsDir, reportFile), "utf8")) as RunReport;
  assert.equal(report.run.captureMode, "redacted");
});

test("损坏配置回退安全默认值且不阻断 run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-config-"));
  const configDir = join(cwd, ".pi", "run-review");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ captureFullContent: "yes" }), "utf8");
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.doesNotReject(invoke("session_start", {}, ctx));
    await assert.doesNotReject(invoke("agent_start", {}, ctx));
    await assert.doesNotReject(invoke("agent_settled", {}, ctx));
    await waitFor(() => hasJsonReport(join(configDir, "reports")), "损坏配置回退后未生成报告");
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.some((message) => message.includes("配置无效")), true);
  assert.equal(notifications.some((message) => message.includes("使用安全默认值")), true);
  const reportFile = (await readdir(join(configDir, "reports"))).find((file) => file.endsWith(".json"));
  assert.ok(reportFile);
  const report = JSON.parse(await readFile(join(configDir, "reports", reportFile), "utf8")) as RunReport;
  assert.equal(report.run.captureMode, "redacted");
});

test("事件日志路径不可写时生命周期不抛错", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-log-failure-"));
  const configDir = join(cwd, ".pi", "run-review");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ storageDir: "blocked" }), "utf8");
  await writeFile(join(cwd, "blocked"), "not a directory", "utf8");
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.doesNotReject(invoke("session_start", {}, ctx));
    await assert.doesNotReject(invoke("agent_start", {}, ctx));
    await assert.doesNotReject(invoke("turn_start", { turnIndex: 0 }, ctx));
    await assert.doesNotReject(invoke("agent_settled", {}, ctx));
    await waitFor(() => errors.some((message) => message.includes("生成报告失败")), "日志路径错误后后台未记录报告失败");
    await assert.doesNotReject(invoke("session_start", {}, ctx));
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.some((message) => message.includes("event write failed")), true);
  assert.equal(notifications.filter((message) => message.includes("事件写入失败")).length, 1);
  assert.equal(notifications.some((message) => message.includes("生成报告失败")), true);
});

test("报告目录不可写时 settled handler 隔离异常并清理 active run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-report-failure-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  const reportsPath = join(cwd, ".pi", "run-review", "reports");
  await writeFile(reportsPath, "not a directory", "utf8");
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.doesNotReject(invoke("agent_settled", {}, ctx));
    await waitFor(() => errors.some((message) => message.includes("生成报告失败")), "报告写入失败未写入后台日志");
    assert.equal(notifications.some((message) => message.includes("生成报告失败")), false);
    await assert.doesNotReject(invoke("session_start", {}, ctx));
  } finally {
    console.error = originalError;
  }
  assert.equal(notifications.some((message) => message.includes("生成报告失败")), true);
  await assert.doesNotReject(invoke("agent_start", {}, ctx));
});

test("活跃 run 含损坏 JSONL 行时仍生成报告并提示跳过", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-corrupt-jsonl-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await appendFile(join(cwd, ".pi", "run-review", "events.jsonl"), "{broken-json\n", "utf8");
  await assert.doesNotReject(invoke("agent_settled", {}, ctx));
  assert.equal(notifications.some((message) => message.includes("跳过了 1 条")), true);
  const reportsDir = join(cwd, ".pi", "run-review", "reports");
  await waitFor(() => hasJsonReport(reportsDir), "损坏 JSONL 后未生成报告");
  assert.equal((await readdir(reportsDir)).some((file) => file.endsWith(".json")), true);
});

test("并发事件串行写入且交错工具完成仍按 toolCallId 关联参数", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-concurrent-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  const firstArgs = { path: "src/first.ts", offset: 1 };
  const secondArgs = { path: "src/second.ts", offset: 2 };
  await Promise.all([
    invoke("tool_execution_start", { toolCallId: "call_first", toolName: "read", args: firstArgs }, ctx),
    invoke("tool_execution_start", { toolCallId: "call_second", toolName: "read", args: secondArgs }, ctx),
    ...Array.from({ length: 40 }, (_, index) => invoke("message_end", { message: { role: "assistant", content: `并发消息 ${index}` } }, ctx)),
  ]);
  await Promise.all([
    invoke("tool_execution_end", { toolCallId: "call_second", toolName: "read", isError: false, result: { exitCode: 0 } }, ctx),
    invoke("tool_execution_end", { toolCallId: "call_first", toolName: "read", isError: false, result: { exitCode: 0 } }, ctx),
  ]);
  await invoke("agent_settled", {}, ctx);
  await waitFor(() => hasJsonReport(join(cwd, ".pi", "run-review", "reports")), "并发事件 run 未生成报告");

  const raw = await readFile(join(cwd, ".pi", "run-review", "events.jsonl"), "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const events = lines.map((line) => JSON.parse(line) as ReviewEvent);
  assert.equal(lines.length, events.length);
  assert.equal(events.filter((event) => event.type === "message").length, 40);
  const finished = events.filter((event) => event.type === "tool_finished");
  const first = finished.find((event) => event.toolCallId === "call_first")?.payload as { argsSummary?: ValueSummary };
  const second = finished.find((event) => event.toolCallId === "call_second")?.payload as { argsSummary?: ValueSummary };
  assert.equal(first.argsSummary?.hash, summarizeValue(firstArgs, { cwd }).hash);
  assert.equal(second.argsSummary?.hash, summarizeValue(secondArgs, { cwd }).hash);
  assert.notEqual(first.argsSummary?.hash, second.argsSummary?.hash);
});

test("agent_end 不关闭 run，后续事件保留到 agent_settled 才生成报告", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-boundary-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("agent_end", { messages: [] }, ctx);
  await invoke("message_end", { message: { role: "assistant", content: "agent_end 后的续跑消息" } }, ctx);
  const reportsDir = join(cwd, ".pi", "run-review", "reports");
  assert.equal(await hasJsonReport(reportsDir), false);
  await invoke("agent_settled", {}, ctx);
  assert.equal(notifications.some((message) => message.includes("报告生成已排队")), true);
  await waitFor(() => hasJsonReport(reportsDir), "agent_settled 后未异步生成报告");

  const events = (await readFile(join(cwd, ".pi", "run-review", "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  const agentEndIndex = events.findIndex((event) => event.type === "agent_ended");
  const messageIndex = events.findIndex((event) => event.type === "message");
  const settledIndex = events.findIndex((event) => event.type === "run_ended");
  assert.equal(agentEndIndex >= 0 && messageIndex > agentEndIndex && settledIndex > messageIndex, true);
});

test("单 run 事件上限省略后续事件、只警告一次并保留 run_ended", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-limit-"));
  const configDir = join(cwd, ".pi", "run-review");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ maxEventsPerRun: 3 }), "utf8");
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  for (let index = 0; index < 8; index += 1) {
    await invoke("message_end", { message: { role: "assistant", content: `消息 ${index}` } }, ctx);
  }
  await invoke("agent_settled", {}, ctx);
  await waitFor(() => hasJsonReport(join(configDir, "reports")), "事件上限 run 未生成报告");

  const events = (await readFile(join(cwd, ".pi", "run-review", "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  assert.equal(events.length, 4);
  assert.equal(events.at(-1)?.type, "run_ended");
  assert.equal(notifications.filter((message) => message.includes("事件上限")).length, 1);
});

test("run-review explain 追加解释事件且不改变原 run 统计和规则结论", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-explain-"));
  const { invoke, invokeCommand, notifications } = createExtensionHarness();
  const requests: unknown[] = [];
  const ctx = {
    ...context(cwd, notifications),
    model: { provider: "test", id: "explain-model" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, request: unknown) => {
        requests.push(request);
        return { content: [{ type: "text", text: "根据引用事件，工具失败后没有恢复。" }] };
      },
    },
  };

  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("tool_execution_start", { toolCallId: "call_failed", toolName: "read", args: { path: "missing.ts" } }, ctx);
  await invoke("tool_execution_end", { toolCallId: "call_failed", toolName: "read", isError: true, result: { message: "not found" } }, ctx);
  await invoke("agent_settled", {}, ctx);

  const reportsDir = join(cwd, ".pi", "run-review", "reports");
  await waitFor(() => hasJsonReport(reportsDir), "explain 测试的基础报告未生成");
  await invoke("session_start", {}, ctx);
  const reportFile = (await readdir(reportsDir)).find((file) => file.endsWith(".json"));
  assert.ok(reportFile);
  const reportPath = join(reportsDir, reportFile);
  const before = JSON.parse(await readFile(reportPath, "utf8")) as RunReport;
  const eventsPath = join(cwd, ".pi", "run-review", "events.jsonl");
  const beforeEvents = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).length;

  await invokeCommand("run-review", "--explain --format json", ctx);

  const after = JSON.parse(await readFile(reportPath, "utf8")) as RunReport;
  assert.equal(requests.length, 1);
  assert.deepEqual(after.run, before.run);
  assert.deepEqual(after.outcome, before.outcome);
  assert.deepEqual(after.findings, before.findings);
  assert.equal(after.explanation?.model, "test/explain-model");
  assert.equal(after.explanation?.text, "根据引用事件，工具失败后没有恢复。");
  const afterEvents = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  assert.equal(afterEvents.length, beforeEvents + 1);
  assert.equal(afterEvents.at(-1)?.type, "analysis");
  assert.equal(afterEvents.at(-1)?.runId, before.run.runId);
  assert.equal(notifications.some((message) => message.includes('"explanation"')), true);
});
