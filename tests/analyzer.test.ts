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
    event("message", "e2", { role: "assistant", text: "完成" }),
  ], run);
  const finding = report.findings.find((item) => item.ruleId === "tool-failure-unrecovered");
  assert.equal(finding?.confidence, "high");
  assert.deepEqual(finding?.evidence, ["e1", "e2"]);
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

test("自定义验证命令参与成功判定", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "bash", args: "npm run check:api", isError: false, exitCode: 0 }),
  ], run, { verificationCommands: ["check:api"] });
  assert.equal(report.outcome.status, "success");
  assert.equal(report.outcome.verification, "passed");
});

test("工具失败后同一工具成功重试时不判定为未恢复", () => {
  const report = analyzeRun([
    event("tool_finished", "e1", { toolName: "read", isError: true, exitCode: 1 }),
    event("tool_finished", "e2", { toolName: "read", isError: false, exitCode: 0 }),
  ], run);
  assert.equal(report.findings.some((item) => item.ruleId === "tool-failure-unrecovered"), false);
});

test("验证失败后成功重跑时不判定为被忽略", () => {
  const report = analyzeRun([
    event("verification", "e1", { command: "npm test", passed: false, exitCode: 1, source: "declared" }),
    event("verification", "e2", { command: "npm test", passed: true, exitCode: 0, source: "declared" }),
  ], run);
  assert.equal(report.outcome.status, "failed");
  assert.equal(report.outcome.verification, "failed");
  assert.equal(report.findings.some((item) => item.ruleId === "verification-failure-ignored"), false);
});
