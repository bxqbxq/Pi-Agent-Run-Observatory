import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRun } from "../src/analyzer.js";
import type { ReviewEvent, RunSummary } from "../src/schema.js";

const run: RunSummary = {
  runId: "run_test",
  startedAt: "2026-09-03T00:00:00.000Z",
  turnCount: 3,
  toolCount: 3,
};

function event(type: ReviewEvent["type"], eventId: string, payload: Record<string, unknown>, timestamp = `2026-09-03T00:00:0${eventId.slice(-1)}.000Z`): ReviewEvent {
  return { schemaVersion: 1, eventId, runId: run.runId, timestamp, type, payload };
}

test("未恢复的工具失败输出高置信度证据", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", isError: true, exitCode: 1 }),
    event("message", "e2", { role: "assistant", text: "任务完成" }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "tool-failure-unrecovered");
  assert.equal(finding?.confidence, "high");
  assert.deepEqual(finding?.evidence, ["e1", "e2"]);
});

test("工具失败后缺少结束或结果证据时只输出低置信度提示", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", isError: true, exitCode: 1 }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "tool-failure-unrecovered");
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.confidence, "low");
  assert.deepEqual(finding?.evidence, ["e1"]);
});

test("相同结构化参数的调用触发重复 warning", () => {
  const events = [1, 2, 3].map((index) => event("tool_started", `e${index}`, { toolName: "read", args: { path: "src/a.ts", line: 1 } }));
  const report = analyzeRun(events, run);
  assert.equal(report.findings.some((item) => item.ruleId === "ineffective-duplicate-call"), true);
});

test("代码改动但没有成功验证时报告未验证", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "edit", isError: false }),
    event("tool_finished", "e2", { toolName: "bash", args: "npm test", isError: true, exitCode: 1 }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "change-without-verification"), true);
  assert.equal(report.outcome.status, "failed");
});

test("验证失败后没有成功重跑时报告被忽略", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
    event("message", "e2", { role: "assistant", text: "任务完成" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), true);
  assert.equal(report.outcome.verification, "failed");
});

test("没有验证事件时 outcome 为 unknown", () => {
  const report = analyzeRun([event("message", "e1", { role: "assistant", text: "完成" })], run);
  assert.equal(report.outcome.status, "unknown");
  assert.equal(report.outcome.verification, "missing");
});

test("助手消息 usage 和 cost 汇总到 run，用户消息不计入", () => {
  const report = analyzeRun([
    event("message", "e1", { role: "user", usage: { input: 100, output: 100, totalTokens: 200, cost: { total: 9 } } }),
    event("message", "e2", { role: "assistant", usage: { input: 10, output: 4, cacheRead: 3, totalTokens: 17, cost: { total: 0.02 } } }),
    event("message", "e3", { role: "assistant", usage: { input: 6, output: 2, reasoning: 1, totalTokens: 9, cost: { total: 0.01 } } }),
  ], run);
  assert.deepEqual(report.run.usage, {
    input: 16,
    output: 6,
    cacheRead: 3,
    cacheWrite: 0,
    reasoning: 1,
    totalTokens: 26,
  });
  assert.equal(report.run.cost, 0.03);
});

test("旧事件的 totalTokens 被脱敏时从 token 分项恢复", () => {
  const report = analyzeRun([
    event("message", "e1", { role: "assistant", usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: "<redacted>" } }),
  ], run);
  assert.equal(report.run.usage?.totalTokens, 19);
});

test("自定义验证命令参与成功判定", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", args: "npm run check:api", isError: false, exitCode: 0 }),
  ], run, { verificationCommands: ["check:api"] });
  assert.equal(report.outcome.status, "success");
  assert.equal(report.outcome.verification, "passed");
});

test("读取测试文件不被误判为执行验证命令", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "read", args: { path: "math.test.js" }, isError: false, resultSummary: "test('add', () => {})" }),
    event("message", "e2", { role: "assistant", text: "任务完成" }),
  ], run);
  assert.equal(report.outcome.verification, "missing");
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), false);
});

test("工具失败后同一工具成功重试时不判定为未恢复", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "read", args: { path: "missing.ts" }, isError: true, exitCode: 1 }),
    event("tool_finished", "e2", { toolName: "read", args: { path: "src/existing.ts" }, isError: false, exitCode: 0 }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "tool-failure-unrecovered"), false);
});

test("工具失败后出现同类别替代路径时只输出低置信度提示", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "read", args: { path: "missing.ts" }, isError: true, exitCode: 1 }),
    event("tool_finished", "e2", { toolName: "grep", args: { pattern: "target" }, isError: false, exitCode: 0 }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "tool-failure-unrecovered");
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.confidence, "low");
  assert.deepEqual(finding?.evidence, ["e1", "e2"]);
});

test("恢复窗口按完成操作计数且不被遥测事件耗尽", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "read", args: { path: "missing.ts" }, isError: true, exitCode: 1 }),
    event("provider_request", "e2", { model: "test" }),
    event("message", "e3", { role: "assistant", summary: "调整路径" }),
    event("tool_started", "e4", { toolName: "read", args: { path: "existing.ts" } }),
    event("provider_response", "e5", { status: 200 }),
    event("tool_finished", "e6", { toolName: "read", args: { path: "existing.ts" }, isError: false, exitCode: 0 }),
  ], run, { recoveryWindow: 1 });
  assert.equal(report.findings.some((item) => item.ruleId === "tool-failure-unrecovered"), false);
});

test("失败验证不会被无关成功命令误判为明确恢复", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", verificationKey: "verification:0", isError: true, exitCode: 1 }),
    event("tool_finished", "e2", { toolName: "bash", args: "git status", isError: false, exitCode: 0 }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "tool-failure-unrecovered");
  assert.equal(finding?.confidence, "low");
  assert.deepEqual(finding?.evidence, ["e1", "e2"]);
});

test("重复调用缺少参数指纹时证据不足且不输出 finding", () => {
  const report = analyzeRun([
    event("tool_started", "e1", { toolName: "read" }),
    event("tool_started", "e2", { toolName: "read" }),
    event("tool_started", "e3", { toolName: "read" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "ineffective-duplicate-call"), false);
});

test("重复次数未达到阈值时不输出 finding", () => {
  const report = analyzeRun([
    event("tool_started", "e1", { toolName: "read", args: { path: "src/a.ts" } }),
    event("tool_started", "e2", { toolName: "read", args: { path: "src/a.ts" } }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "ineffective-duplicate-call"), false);
});

test("重复调用之间只有可能推进的操作时降低置信度", () => {
  const first = { ...event("tool_started", "e1", { toolName: "read", args: { path: "src/a.ts" } }), toolCallId: "repeat-1" };
  const possibleProgress = { ...event("tool_finished", "e2", { toolName: "bash", isError: false, exitCode: 0 }), toolCallId: "command-1" };
  const second = { ...event("tool_started", "e3", { toolName: "read", args: { path: "src/a.ts" } }), toolCallId: "repeat-2" };
  const third = { ...event("tool_started", "e4", { toolName: "read", args: { path: "src/a.ts" } }), toolCallId: "repeat-3" };
  const report = analyzeRun([first, possibleProgress, second, third], run);
  const finding = report.findings.find((item) => item.ruleId === "ineffective-duplicate-call");
  assert.equal(finding?.confidence, "low");
  assert.equal(finding?.evidence.includes("e2"), true);
});

test("重复调用之间存在确定性状态推进时不输出 finding", () => {
  const first = { ...event("tool_started", "e1", { toolName: "read", args: { path: "src/a.ts" } }), toolCallId: "repeat-1" };
  const progress = { ...event("tool_finished", "e2", { toolName: "edit", isError: false, exitCode: 0 }), toolCallId: "edit-1" };
  const second = { ...event("tool_started", "e3", { toolName: "read", args: { path: "src/a.ts" } }), toolCallId: "repeat-2" };
  const third = { ...event("tool_started", "e4", { toolName: "read", args: { path: "src/a.ts" } }), toolCallId: "repeat-3" };
  const report = analyzeRun([first, progress, second, third], run);
  assert.equal(report.findings.some((item) => item.ruleId === "ineffective-duplicate-call"), false);
});

test("状态推进后重新累计到阈值时仍输出重复调用 finding", () => {
  const calls = ["e1", "e3", "e4", "e5"].map((eventId, index) => ({
    ...event("tool_started", eventId, { toolName: "read", args: { path: "src/a.ts" } }),
    toolCallId: `repeat-${index + 1}`,
  }));
  const progress = { ...event("tool_finished", "e2", { toolName: "edit", isError: false, exitCode: 0 }), toolCallId: "edit-1" };
  const report = analyzeRun([calls[0], progress, calls[1], calls[2], calls[3]], run);
  const finding = report.findings.find((item) => item.ruleId === "ineffective-duplicate-call");
  assert.equal(finding?.confidence, "medium");
  assert.deepEqual(finding?.evidence, ["e3", "e4", "e5"]);
});

test("连续重复超过阈值时升级为高置信度", () => {
  const report = analyzeRun([1, 2, 3, 4].map((index) => event("tool_started", `e${index}`, {
    toolName: "read",
    args: { path: "src/a.ts" },
  })), run);
  const finding = report.findings.find((item) => item.ruleId === "ineffective-duplicate-call");
  assert.equal(finding?.confidence, "high");
  assert.deepEqual(finding?.evidence, ["e1", "e2", "e3", "e4"]);
});

test("Git 指纹确认真实改动且缺少验证时输出高置信度 finding", () => {
  const report = analyzeRun([
    event("run_ended", "e1", { workspaceChanged: true, workspaceEvidence: "git-diff-snapshot" }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "change-without-verification");
  assert.equal(finding?.severity, "high");
  assert.equal(finding?.confidence, "high");
  assert.deepEqual(finding?.evidence, ["e1"]);
});

test("写入工具成功但 Git 指纹确认无净改动时不输出 finding", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "edit", isError: false }),
    event("run_ended", "e2", { workspaceChanged: false, workspaceEvidence: "git-diff-snapshot" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "change-without-verification"), false);
});

test("写入工具成功但缺少 Git 指纹时只输出证据不足提示", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "edit", isError: false }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "change-without-verification");
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.confidence, "low");
});

test("成功验证发生在最后一次改动之前时仍报告改动未验证", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
    event("tool_finished", "e2", { toolName: "edit", isError: false }),
    event("run_ended", "e3", { workspaceChanged: true, workspaceEvidence: "git-diff-snapshot" }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "change-without-verification");
  assert.equal(finding?.confidence, "high");
  assert.deepEqual(finding?.evidence, ["e2", "e3"]);
});

test("最后一次改动后成功验证时不报告改动未验证", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "edit", isError: false }),
    event("verification", "e2", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
    event("run_ended", "e3", { workspaceChanged: true, workspaceEvidence: "git-diff-snapshot" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "change-without-verification"), false);
});

test("只有 Git 证据时 run 内验证不能证明发生在改动之后", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
    event("run_ended", "e2", { workspaceChanged: true, workspaceEvidence: "git-diff-snapshot" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "change-without-verification"), true);
});

test("只有 Git 证据时 run 结束后的外部验证可以覆盖改动", () => {
  const report = analyzeRun([
    event("run_ended", "e1", { workspaceChanged: true, workspaceEvidence: "git-diff-snapshot" }),
    event("verification", "e2", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "change-without-verification"), false);
});

test("验证失败后成功重跑时不判定为被忽略", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
    event("verification", "e2", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
  ], run);
  assert.equal(report.outcome.status, "success");
  assert.equal(report.outcome.verification, "passed");
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), false);
});

test("一个验证恢复时不会掩盖另一项尚未恢复的失败", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
    event("verification", "e2", { command: "npm run typecheck", passed: false, exitCode: 1, source: "declared" }),
    event("verification", "e3", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
  ], run);
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.verification, "failed");
});

test("插件内验证分类和 runner 完整命令按同类验证结算", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", verificationKey: "verification:0", isError: true, exitCode: 1 }),
    event("verification", "e2", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
  ], run);
  assert.equal(report.outcome.status, "success");
  assert.equal(report.outcome.verification, "passed");
  assert.equal(report.findings.some((item) => item.ruleId === "tool-failure-unrecovered"), false);
});

test("隐私参数摘要的哈希仍可用于重复调用检测", () => {
  const argsSummary = { structure: { type: "object", fields: { path: "string" } }, hash: "sha256:same" };
  const report = analyzeRun([
    event("tool_started", "e1", { toolName: "read", argsSummary }),
    event("tool_started", "e2", { toolName: "read", argsSummary }),
    event("tool_started", "e3", { toolName: "read", argsSummary }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "ineffective-duplicate-call"), true);
});

test("Agent 完成后才发生的外部验证失败不算被忽略", () => {
  const report = analyzeRun([
    event("message", "e1", { role: "assistant", text: "任务完成" }),
    event("verification", "e2", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
  ], run);
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), false);
});

test("Agent 内部验证失败后结束仍会在后续外部失败存在时被识别", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", args: "npm test", isError: true, exitCode: 1 }),
    event("message", "e2", { role: "assistant", text: "任务完成" }),
    event("verification", "e3", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "verification-failure-ignored");
  assert.deepEqual(finding?.evidence, ["e1", "e2"]);
});

test("Agent 明确报告验证失败时不算忽略失败", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", args: "npm test", isError: true, exitCode: 1 }),
    event("message", "e2", { role: "assistant", summary: "测试失败，任务尚未完成，需要先修复断言。" }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), false);
});

test("Agent 同时披露失败并声称任务完成时仍判定忽略失败", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", args: "npm test", isError: true, exitCode: 1 }),
    event("message", "e2", { role: "assistant", contentSummary: { completionClaim: true, failureDisclosure: true } }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), true);
});

test("验证失败但没有后续完成声明时证据不足且不判定为忽略", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
    event("run_ended", "e2", { workspaceChanged: false, workspaceEvidence: "git-diff-snapshot" }),
  ], run);
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), false);
});
