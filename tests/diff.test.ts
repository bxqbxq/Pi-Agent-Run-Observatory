import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareEvalConfigs, findLatestEvalSummary, parseEvalSummary, readEvalSummary } from "../src/diff.js";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runs: 8,
    successRate: 0.5,
    failedRate: 0.5,
    timeoutRate: 0,
    unknownRate: 0.25,
    expectedRuns: 0,
    expectationPassRate: null,
    acceptanceRuns: 8,
    acceptancePassRate: 0.5,
    findingRates: { "tool-failure-unrecovered": 0.25 },
    averageDurationMs: 200,
    p95DurationMs: 300,
    averageTurns: 4,
    averageTools: 5,
    ...overrides,
  };
}

test("旧评测汇总缺少 token 和 cost 指标时按 null 处理", () => {
  const summary = parseEvalSummary({
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    byConfig: { baseline: config() },
  });
  assert.equal(summary.byConfig.baseline?.averageTotalTokens, null);
  assert.equal(summary.byConfig.baseline?.averageCost, null);
});

test("配置集合比较输出统一指标、delta 和 finding 差异", () => {
  const summary = parseEvalSummary({
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    byConfig: {
      baseline: config({ usageRuns: 8, averageInputTokens: 100, averageOutputTokens: 50, averageTotalTokens: 150, costRuns: 8, averageCost: 0.1 }),
      candidate: config({ successRate: 0.75, failedRate: 0.25, acceptancePassRate: 0.75, findingRates: { "change-without-verification": 0.125 }, usageRuns: 8, averageInputTokens: 80, averageOutputTokens: 40, averageTotalTokens: 120, costRuns: 8, averageCost: 0.08 }),
    },
  });
  const result = compareEvalConfigs(summary, "baseline", "candidate", "summary.json");
  assert.deepEqual(result.metrics.successRate, { baseline: 0.5, candidate: 0.75, delta: 0.25 });
  assert.deepEqual(result.metrics.averageTotalTokens, { baseline: 150, candidate: 120, delta: -30 });
  assert.deepEqual(result.metrics.averageCost, { baseline: 0.1, candidate: 0.08, delta: -0.02 });
  assert.deepEqual(result.findingRates["tool-failure-unrecovered"], { baseline: 0.25, candidate: 0, delta: -0.25 });
  assert.deepEqual(result.findingRates["change-without-verification"], { baseline: 0, candidate: 0.125, delta: 0.125 });
});

test("配置集合比较拒绝不存在的配置", () => {
  const summary = parseEvalSummary({ schemaVersion: 1, generatedAt: "2026-09-04T00:00:00.000Z", byConfig: { baseline: config() } });
  assert.throws(() => compareEvalConfigs(summary, "baseline", "missing", "summary.json"), /不存在配置/);
});

test("评测汇总拒绝越界比例和非整数运行数", () => {
  assert.throws(() => parseEvalSummary({
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    byConfig: { invalid: config({ successRate: 1.1 }) },
  }), /0 到 1/);
  assert.throws(() => parseEvalSummary({
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    byConfig: { invalid: config({ runs: 1.5 }) },
  }), /必须是整数/);
});

test("自动选择最新且同时包含两个目标配置的评测汇总", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-review-diff-latest-"));
  const resultsDir = join(cwd, "eval", "results");
  await mkdir(resultsDir, { recursive: true });
  const matchingPath = join(resultsDir, "matching.json");
  await writeFile(matchingPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    byConfig: { baseline: config(), candidate: config() },
  }), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(resultsDir, "newer-unrelated.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:01:00.000Z",
    byConfig: { unrelated: config() },
  }), "utf8");

  const selected = await findLatestEvalSummary(cwd, "baseline", "candidate");
  assert.equal(selected?.path, matchingPath);
});

test("仓库内的演示案例符合评测汇总 schema", async () => {
  for (const file of ["add-validation-observed-recovery.json", "add-validation-replication-3x2.json"]) {
    const summary = await readEvalSummary(join(process.cwd(), "eval", "cases", file));
    assert.equal(summary.byConfig["baseline-deepseek"]?.runs > 0, true);
    assert.equal(summary.byConfig["checklist-deepseek"]?.runs > 0, true);
  }
});
