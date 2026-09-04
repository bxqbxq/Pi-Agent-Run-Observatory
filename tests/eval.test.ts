import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { test } from "node:test";
import { piCliPath, reconcileEvalReport, validateTask, writeEvalSummary } from "../src/eval.js";
import { appendEvent, writeReport } from "../src/storage.js";
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
