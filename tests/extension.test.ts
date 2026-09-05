import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import runReviewExtension from "../extensions/run-review.js";
import { summarizeValue, type MessageContentSummary, type ValueSummary } from "../src/redaction.js";
import type { ReviewEvent, RunReport } from "../src/schema.js";

const execFileAsync = promisify(execFile);

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

async function initGitFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, "tracked.txt"), "before\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "pi-run-review@example.invalid"], { cwd, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "pi-run-review"], { cwd, windowsHide: true });
  await execFileAsync("git", ["add", "tracked.txt"], { cwd, windowsHide: true });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd, windowsHide: true });
}

async function readOnlyReport(reportsDir: string): Promise<RunReport> {
  await waitFor(() => hasJsonReport(reportsDir), "报告未生成");
  const reportFiles = (await readdir(reportsDir)).filter((file) => file.endsWith(".json"));
  assert.equal(reportFiles.length, 1);
  return JSON.parse(await readFile(join(reportsDir, reportFiles[0]), "utf8")) as RunReport;
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
  await invoke("tool_execution_end", { toolCallId: "call_1", toolName: "bash", isError: true, result: { exitCode: 1, error: { code: "ENOENT", message: "command unavailable" } } }, ctx);
  await invoke("message_end", { message: { role: "user", content: "private user prompt alpha-42" } }, ctx);
  await invoke("message_end", { message: { role: "assistant", content: "任务已经完成，测试已通过。private answer beta-43" } }, ctx);
  await invoke("before_provider_request", { payload: { messages: [{ content: "provider secret gamma-44" }] } }, ctx);
  await invoke("after_provider_response", { status: 200, headers: { "x-request-id": "provider-secret-header" }, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, secret: "provider-secret-delta" } }, ctx);
  await invoke("before_provider_request", { payload: { messages: [] } }, ctx);
  await invoke("after_provider_response", { status: 204, headers: {} }, ctx);
  await invoke("agent_settled", {}, ctx);
  await waitFor(() => notifications.some((message) => message.includes("报告生成已排队")), "settled 后未异步生成摘要");
  assert.equal(notifications.some((message) => message.includes("主要问题：tool-failure-unrecovered")), true);

  const eventsPath = join(cwd, ".pi", "run-review", "events.jsonl");
  const rawEvents = await readFile(eventsPath, "utf8");
  for (const privateText of ["super-secret-value", "C:\\Users\\alice", "alpha-42", "beta-43", "gamma-44", "npm test", "provider-secret-header", "provider-secret-delta"]) {
    assert.equal(rawEvents.includes(privateText), false, `event log leaked: ${privateText}`);
  }

  const events = rawEvents.trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  const toolStarted = events.find((event) => event.type === "tool_started");
  const toolPayload = toolStarted?.payload as { args?: unknown; argsSummary?: ValueSummary; verificationKey?: string };
  assert.equal(toolPayload.args, undefined);
  assert.match(String(toolPayload.argsSummary?.hash), /^sha256:[a-f0-9]{64}$/);
  assert.equal(toolPayload.verificationKey, "verification:0");
  const toolFinished = events.find((event) => event.type === "tool_finished");
  const toolFinishedPayload = toolFinished?.payload as { resultSummary?: string };
  assert.match(String(toolFinishedPayload.resultSummary), /ENOENT/);
  assert.doesNotMatch(String(toolFinishedPayload.resultSummary), /\[object Object\]/);
  const providerRequest = events.find((event) => event.type === "provider_request");
  const providerPayload = providerRequest?.payload as { payload?: unknown; payloadSummary?: ValueSummary };
  assert.equal(providerPayload.payload, undefined);
  assert.match(String(providerPayload.payloadSummary?.hash), /^sha256:[a-f0-9]{64}$/);
  const providerResponse = events.find((event) => event.type === "provider_response");
  const providerResponsePayload = providerResponse?.payload as { durationMs?: unknown; usageSummary?: { metrics?: Record<string, unknown>; structure?: unknown } };
  assert.equal(typeof providerResponsePayload.durationMs, "number");
  assert.equal(providerResponsePayload.usageSummary?.metrics?.prompt_tokens, 10);
  assert.equal(providerResponsePayload.usageSummary?.metrics?.secret, undefined);
  const providerResponses = events.filter((event) => event.type === "provider_response");
  assert.equal(providerResponses.length, 2);
  assert.equal((providerResponses[1]?.payload as { usageSummary?: unknown }).usageSummary, undefined);
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
  assert.match(report.run.projectId ?? "", /^sha256:[a-f0-9]{64}$/);
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
  } finally {
    console.error = originalError;
  }
  assert.equal(notifications.some((message) => message.includes("生成报告失败")), true);
  await assert.doesNotReject(invoke("agent_start", {}, ctx));
});

test("事件日志读取失败时 settled handler 隔离异常并清理 active run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-read-failure-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  const eventsPath = join(cwd, ".pi", "run-review", "events.jsonl");
  const backupPath = `${eventsPath}.bak`;
  const brokenPath = `${eventsPath}.broken`;
  await rename(eventsPath, backupPath);
  await mkdir(eventsPath);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.doesNotReject(invoke("agent_settled", {}, ctx));
    await waitFor(() => errors.some((message) => message.includes("完成运行诊断失败")), "事件读取失败未写入后台日志");
    await rename(eventsPath, brokenPath);
    await rename(backupPath, eventsPath);
    await assert.doesNotReject(invoke("agent_start", {}, ctx));
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.some((message) => message.includes("完成运行诊断失败")), true);
  assert.equal(notifications.some((message) => message.includes("完成运行诊断失败")), true);
  const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  assert.equal(events.filter((event) => event.type === "run_started").length, 2);
});

test("活跃 run 含损坏 JSONL 行时仍生成报告并提示跳过", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-corrupt-jsonl-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await appendFile(join(cwd, ".pi", "run-review", "events.jsonl"), "{broken-json\n", "utf8");
  await assert.doesNotReject(invoke("agent_settled", {}, ctx));
  await waitFor(() => notifications.some((message) => message.includes("跳过了 1 条")), "损坏事件警告未异步显示");
  const reportsDir = join(cwd, ".pi", "run-review", "reports");
  await waitFor(() => hasJsonReport(reportsDir), "损坏 JSONL 后未生成报告");
  assert.equal((await readdir(reportsDir)).some((file) => file.endsWith(".json")), true);
});

test("Git 工作区指纹确认 run 期间的真实改动", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-git-change-"));
  await initGitFixture(cwd);
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await writeFile(join(cwd, "tracked.txt"), "after\n", "utf8");
  await invoke("agent_settled", {}, ctx);

  const report = await readOnlyReport(join(cwd, ".pi", "run-review", "reports"));
  const finding = report.findings.find((item) => item.ruleId === "change-without-verification");
  assert.equal(finding?.confidence, "high");
});

test("写入工具成功但 Git 工作区未变化时不误报改动未验证", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-git-unchanged-"));
  await initGitFixture(cwd);
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("tool_execution_start", { toolCallId: "call_edit", toolName: "edit", args: { path: "tracked.txt" } }, ctx);
  await invoke("tool_execution_end", { toolCallId: "call_edit", toolName: "edit", isError: false, result: { message: "unchanged" } }, ctx);
  await invoke("agent_settled", {}, ctx);

  const report = await readOnlyReport(join(cwd, ".pi", "run-review", "reports"));
  assert.equal(report.findings.some((item) => item.ruleId === "change-without-verification"), false);
});

test("Git 工作区指纹能识别 run 期间删除的文件", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-git-delete-"));
  await initGitFixture(cwd);
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("tool_execution_start", { toolCallId: "call_delete", toolName: "edit", args: { path: "tracked.txt" } }, ctx);
  await unlink(join(cwd, "tracked.txt"));
  await invoke("tool_execution_end", { toolCallId: "call_delete", toolName: "edit", isError: false, result: { message: "deleted" } }, ctx);
  await invoke("agent_settled", {}, ctx);

  const report = await readOnlyReport(join(cwd, ".pi", "run-review", "reports"));
  const finding = report.findings.find((item) => item.ruleId === "change-without-verification");
  assert.equal(finding?.confidence, "high");
});

test("非 Git 工作区只能将写入事件判为低置信度改动", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-non-git-"));
  const { invoke, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("tool_execution_start", { toolCallId: "call_write", toolName: "write", args: { path: "created.txt" } }, ctx);
  await writeFile(join(cwd, "created.txt"), "created\n", "utf8");
  await invoke("tool_execution_end", { toolCallId: "call_write", toolName: "write", isError: false, result: { message: "created" } }, ctx);
  await invoke("agent_settled", {}, ctx);

  const report = await readOnlyReport(join(cwd, ".pi", "run-review", "reports"));
  const finding = report.findings.find((item) => item.ruleId === "change-without-verification");
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.confidence, "low");
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
  assert.equal(events[settledIndex]?.runId, events[agentEndIndex]?.runId);
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
        return { content: [{ type: "text", text: "工具失败后没有恢复。" }] };
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
  assert.match(after.explanation?.text ?? "", /根因解释：\n工具失败后没有恢复。/);
  assert.match(after.explanation?.text ?? "", /证据引用：evt_/);
  assert.match(after.explanation?.text ?? "", /可执行建议：/);
  assert.match(after.explanation?.text ?? "", /不确定性说明：/);
  assert.match(JSON.stringify(requests[0]), /逐项引用相关 eventId/);
  const afterEvents = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as ReviewEvent);
  assert.equal(afterEvents.length, beforeEvents + 1);
  assert.equal(afterEvents.at(-1)?.type, "analysis");
  assert.equal(afterEvents.at(-1)?.runId, before.run.runId);
  assert.equal(notifications.some((message) => message.includes('"explanation"')), true);
});

test("run-review full 仅在完整采集模式显示 finding 证据详情", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-full-"));
  const configDir = join(cwd, ".pi", "run-review");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ captureFullContent: true }), "utf8");
  const { invoke, invokeCommand, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("tool_execution_start", { toolCallId: "call_full", toolName: "read", args: { path: "missing.ts" } }, ctx);
  await invoke("tool_execution_end", { toolCallId: "call_full", toolName: "read", isError: true, result: { message: "not found" } }, ctx);
  await invoke("agent_settled", {}, ctx);
  await waitFor(() => hasJsonReport(join(configDir, "reports")), "完整采集报告未生成");
  await invoke("session_start", {}, ctx);

  await invokeCommand("run-review", "--full --format json", ctx);

  const output = notifications.find((message) => message.includes('"evidenceEvents"'));
  assert.ok(output);
  const full = JSON.parse(output) as { report: RunReport; evidenceEvents: ReviewEvent[] };
  assert.equal(full.report.run.captureMode, "full");
  assert.equal(full.evidenceEvents.length > 0, true);
  assert.equal(full.evidenceEvents.every((event) => full.report.findings.some((finding) => finding.evidence.includes(event.eventId))), true);
});

test("run-review full 不会绕过默认脱敏模式", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-full-redacted-"));
  const { invoke, invokeCommand, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("tool_execution_start", { toolCallId: "call_redacted", toolName: "read", args: { path: "private-name.ts" } }, ctx);
  await invoke("tool_execution_end", { toolCallId: "call_redacted", toolName: "read", isError: true, result: { message: "not found" } }, ctx);
  await invoke("agent_settled", {}, ctx);
  await waitFor(() => hasJsonReport(join(cwd, ".pi", "run-review", "reports")), "脱敏采集报告未生成");
  await invoke("session_start", {}, ctx);

  await invokeCommand("run-review", "--full --format json", ctx);

  assert.equal(notifications.some((message) => message.includes("只有预先启用 captureFullContent")), true);
  assert.equal(notifications.some((message) => message.includes('"evidenceEvents"')), false);
  assert.equal(notifications.some((message) => message.includes("private-name.ts")), false);
});

test("run-review 读取损坏报告时仅提示警告", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-command-corrupt-"));
  const { invoke, invokeCommand, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  await invoke("session_start", {}, ctx);
  await invoke("agent_start", {}, ctx);
  await invoke("agent_settled", {}, ctx);
  const reportsDir = join(cwd, ".pi", "run-review", "reports");
  await waitFor(async () => {
    try {
      return (await readdir(reportsDir)).some((file) => file.endsWith(".html"));
    } catch {
      return false;
    }
  }, "基础报告未完整生成");
  const reportFile = (await readdir(reportsDir)).find((file) => file.endsWith(".json"));
  assert.ok(reportFile);
  await writeFile(join(reportsDir, reportFile), "{broken-json", "utf8");

  await assert.doesNotReject(invokeCommand("run-review", "--format json", ctx));
  assert.equal(notifications.some((message) => message.includes("读取 run-review 报告失败")), true);
});

test("run-diff 读取损坏评测汇总时仅提示警告", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-extension-diff-corrupt-"));
  const { invokeCommand, notifications } = createExtensionHarness();
  const ctx = context(cwd, notifications);
  const summaryPath = join(cwd, "broken-summary.json");
  await writeFile(summaryPath, "{broken-json", "utf8");

  await assert.doesNotReject(invokeCommand("run-diff", "baseline candidate --file broken-summary.json", ctx));
  assert.equal(notifications.some((message) => message.includes("读取 run-diff 报告失败")), true);
});
