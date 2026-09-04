import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { test } from "node:test";
import { piCliPath, reconcileEvalReport, runEvalTask, validateTask, writeEvalSummary } from "../src/eval.js";
import { appendEvent, writeReport } from "../src/storage.js";
import { renderHtml, renderMarkdown } from "../src/render.js";
import type { RunReport } from "../src/schema.js";

test("任务 schema 要求验证命令", () => {
  assert.throws(() => validateTask({ id: "bad", prompt: "x", fixture: "y", validate: [] }), /验证命令/);
  assert.deepEqual(validateTask({ id: "ok", prompt: "x", fixture: "y", validate: ["npm test"] }).id, "ok");
});

test("Pi CLI 固定使用项目本地依赖", () => {
  assert.equal(
    piCliPath("C:\\project"),
    normalize("C:\\project\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js"),
  );
});

test("fixture 内容直接复制到评测工作区根目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-review-fixture-test-"));
  const fixture = join(dir, "fixture");
  const workspace = join(dir, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(fixture));
  await writeFile(join(fixture, "package.json"), "{}\n", "utf8");
  for (const entry of await (await import("node:fs/promises")).readdir(fixture)) {
    await cp(join(fixture, entry), join(workspace, entry), { recursive: true });
  }
  assert.equal(await readFile(join(workspace, "package.json"), "utf8"), "{}\n");
});

test("评测汇总按配置计算成功率", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-review-test-"));
  const path = join(dir, "summary.json");
  await writeEvalSummary(path, [
    { taskId: "a", configId: "baseline", status: "success", durationMs: 100, piExitCode: 0, validations: [] },
    { taskId: "b", configId: "baseline", status: "failed", durationMs: 300, piExitCode: 0, validations: [] },
  ]);
  const summary = JSON.parse(await readFile(path, "utf8"));
  assert.equal(summary.byConfig.baseline.successRate, 0.5);
  assert.equal(summary.byConfig.baseline.averageDurationMs, 200);
});

test("外部验证结果回写报告并消除未验证误报", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-run-review-reconcile-test-"));
  const reportDir = join(workspace, ".pi", "run-review", "reports");
  const report: RunReport = {
    schemaVersion: 1,
    run: { runId: "run_reconcile", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 1, toolCount: 1 },
    outcome: { status: "unknown", source: "unknown", verification: "missing" },
    findings: [{
      findingId: "change-without-verification:e1",
      ruleId: "change-without-verification",
      severity: "high",
      confidence: "high",
      evidence: ["e1"],
      trigger: "检测到文件改动，但 run 结束前没有成功验证命令",
      recommendation: "运行任务声明的测试、构建、类型检查或 lint 命令",
    }],
  };
  await mkdir(reportDir, { recursive: true });
  await appendEvent(join(workspace, ".pi", "run-review", "events.jsonl"), {
    schemaVersion: 1,
    eventId: "e1",
    runId: report.run.runId,
    timestamp: "2026-09-03T00:00:01.000Z",
    type: "tool_finished",
    payload: { toolName: "edit", isError: false },
  });
  await writeReport(join(reportDir, "run_reconcile.json"), report);

  const reconciled = await reconcileEvalReport(workspace, [{ command: "npm test", exitCode: 0, passed: true, output: "" }]);

  assert.equal(reconciled?.outcome.status, "success");
  assert.equal(reconciled?.outcome.verification, "passed");
  assert.equal(reconciled?.findings.some((item) => item.ruleId === "change-without-verification"), false);
});

test("协调报告同步更新三种格式并支持自定义存储目录", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-run-review-reconcile-format-test-"));
  const reportDir = join(workspace, ".pi", "custom-review", "reports");
  const report: RunReport = {
    schemaVersion: 1,
    run: { runId: "run_format", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 1, toolCount: 1 },
    outcome: { status: "unknown", source: "unknown", verification: "missing" },
    findings: [],
  };
  await mkdir(reportDir, { recursive: true });
  const eventsPath = join(workspace, ".pi", "custom-review", "events.jsonl");
  await appendEvent(eventsPath, {
    schemaVersion: 1,
    eventId: "format-edit",
    runId: report.run.runId,
    timestamp: "2026-09-03T00:00:01.000Z",
    type: "tool_finished",
    payload: { toolName: "edit", isError: false },
  });
  const reportPath = join(reportDir, "run_format.json");
  await writeReport(reportPath, report);
  await writeFile(join(reportDir, "run_format.md"), renderMarkdown(report), "utf8");
  await writeFile(join(reportDir, "run_format.html"), renderHtml(report), "utf8");

  const reconciled = await reconcileEvalReport(workspace, [{ command: "npm test", exitCode: 0, passed: true, output: "" }], ".pi/custom-review");
  const markdown = await readFile(join(reportDir, "run_format.md"), "utf8");
  const html = await readFile(join(reportDir, "run_format.html"), "utf8");
  const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });

  assert.equal(reconciled?.outcome.status, "success");
  assert.equal(reconciled?.outcome.verification, "passed");
  assert.match(markdown, /结果：\*\*success\*\*/);
  assert.match(markdown, /验证：\*\*passed\*\*/);
  assert.match(html, /结果：\*\*success\*\*/);
  assert.match(html, /验证：\*\*passed\*\*/);
  assert.equal(events.filter((event) => event.type === "verification").length, 1);
});

test("评测 runner 端到端执行假 Pi、验证并协调报告", async () => {
  const result = await runEvalTask(
    { id: "integration", prompt: "完成任务", fixture: "fixtures/tiny-node", validate: ["npm test"], timeoutMs: 5_000 },
    { id: "fake" },
    {
      rootDir: process.cwd(),
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi.mjs"),
      keepWorkspace: false,
    },
  );

  assert.equal(result.status, "success");
  assert.equal(result.validations.length, 1);
  assert.equal(result.validations[0]?.passed, true);
  assert.equal(result.report?.outcome.status, "success");
  assert.equal(result.report?.outcome.verification, "passed");
});

test("评测 runner 端到端保留验证失败诊断", async () => {
  const result = await runEvalTask(
    { id: "integration-failure", prompt: "FAIL_VALIDATION", fixture: "fixtures/tiny-node", validate: ["npm test"], timeoutMs: 5_000 },
    { id: "fake", model: "FAIL_VALIDATION" },
    {
      rootDir: process.cwd(),
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi-failure.mjs"),
      keepWorkspace: false,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.validations[0]?.passed, false);
  assert.equal(result.report?.outcome.status, "failed");
  assert.equal(result.report?.outcome.verification, "failed");
  assert.equal(result.report?.findings.some((item) => item.ruleId === "verification-failure-ignored"), true);
});
