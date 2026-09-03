import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateTask, writeEvalSummary } from "../src/eval.js";

test("任务 schema 要求验证命令", () => {
  assert.throws(() => validateTask({ id: "bad", prompt: "x", fixture: "y", validate: [] }), /验证命令/);
  assert.deepEqual(validateTask({ id: "ok", prompt: "x", fixture: "y", validate: ["npm test"] }).id, "ok");
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
