import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { test } from "node:test";
import { piCliPath, validateTask, writeEvalSummary } from "../src/eval.js";

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
