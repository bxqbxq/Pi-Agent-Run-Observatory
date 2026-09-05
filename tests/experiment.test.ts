import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readEvalSummary, type EvalSummaryDocument } from "../src/diff.js";
import { assessExperiment, experimentFingerprint, parseExperimentPlan, type ExperimentPlan } from "../src/experiment.js";

const plan: ExperimentPlan = {
  schemaVersion: 1,
  id: "bounded-mean-5x2",
  taskId: "bounded-mean",
  baselineConfigId: "baseline-deepseek",
  candidateConfigId: "contract-checklist-deepseek",
  repeatsPerConfig: 5,
  inputFingerprints: {
    task: "sha256:task",
    baselineConfig: "sha256:baseline",
    candidateConfig: "sha256:candidate",
  },
  criteria: {
    minBaselineFailures: 1,
    minSuccessRateDelta: 0.2,
    minAcceptanceRateDelta: 0,
    maxDurationIncreaseRate: 0.3,
    maxCostIncreaseRate: 0.3,
  },
};

function metric(overrides: Record<string, number | null> = {}) {
  return {
    runs: 5,
    successRate: 0.6,
    failedRate: 0.4,
    timeoutRate: 0,
    unknownRate: 0,
    expectedRuns: 0,
    expectationPassRate: null,
    acceptanceRuns: 5,
    acceptancePassRate: 0.6,
    findingRates: {},
    averageDurationMs: 100,
    p95DurationMs: 120,
    averageTurns: 4,
    averageTools: 6,
    usageRuns: 5,
    averageInputTokens: 100,
    averageOutputTokens: 50,
    averageTotalTokens: 150,
    costRuns: 5,
    averageCost: 0.001,
    ...overrides,
  };
}

function summary(baseline: Record<string, unknown>, candidate: Record<string, unknown>): EvalSummaryDocument {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    taskId: "bounded-mean",
    inputFingerprints: {
      tasks: { "bounded-mean": "sha256:task" },
      configs: {
        "baseline-deepseek": "sha256:baseline",
        "contract-checklist-deepseek": "sha256:candidate",
      },
    },
    byConfig: {
      "baseline-deepseek": baseline as never,
      "contract-checklist-deepseek": candidate as never,
    },
  };
}

test("候选达到预注册质量和资源标准时采用", () => {
  const result = assessExperiment(plan, summary(metric(), metric({ successRate: 0.8, failedRate: 0.2, acceptancePassRate: 0.8, averageDurationMs: 125, averageCost: 0.0012 })));
  assert.equal(result.decision, "adopt");
  assert.equal(result.checks.every((check) => check.passed), true);
});

test("baseline 没有失败时判定任务缺少区分度", () => {
  const result = assessExperiment(plan, summary(
    metric({ successRate: 1, failedRate: 0, acceptancePassRate: 1 }),
    metric({ successRate: 1, failedRate: 0, acceptancePassRate: 1 }),
  ));
  assert.equal(result.decision, "inconclusive");
  assert.match(result.reason, /区分度/);
});

test("候选质量改善或资源预算不达标时拒绝", () => {
  const result = assessExperiment(plan, summary(metric(), metric({ successRate: 0.6, failedRate: 0.4, acceptancePassRate: 0.6, averageDurationMs: 150, averageCost: 0.0015 })));
  assert.equal(result.decision, "reject");
  assert.equal(result.checks.some((check) => !check.passed), true);
});

test("按每次成功计算时允许单次更贵但成功效率更高的候选", () => {
  const perSuccessPlan: ExperimentPlan = {
    ...plan,
    criteria: { ...plan.criteria, resourceBasis: "per-success" },
  };
  const result = assessExperiment(perSuccessPlan, summary(
    metric({ successRate: 0.2, failedRate: 0.8, acceptancePassRate: 0.2, averageDurationMs: 100, averageCost: 0.001 }),
    metric({ successRate: 1, failedRate: 0, acceptancePassRate: 1, averageDurationMs: 200, averageCost: 0.002 }),
  ));
  assert.equal(result.decision, "adopt");
  assert.equal(result.checks.find((check) => check.id === "duration-increase-rate")?.actual, -0.6);
  assert.equal(result.checks.find((check) => check.id === "cost-increase-rate")?.actual, -0.6);
});

test("baseline 从未成功时每次成功资源口径判定为证据不足", () => {
  const perSuccessPlan: ExperimentPlan = {
    ...plan,
    criteria: { ...plan.criteria, resourceBasis: "per-success" },
  };
  const result = assessExperiment(perSuccessPlan, summary(
    metric({ successRate: 0, failedRate: 1, acceptancePassRate: 0 }),
    metric({ successRate: 1, failedRate: 0, acceptancePassRate: 1 }),
  ));
  assert.equal(result.decision, "inconclusive");
  assert.match(result.reason, /无法估算/);
  assert.equal(result.checks.find((check) => check.id === "cost-increase-rate")?.actual, null);
});

test("结果任务与计划不一致时拒绝评估", () => {
  const wrongTask = { ...summary(metric(), metric()), taskId: "another-task" };
  const result = assessExperiment(plan, wrongTask);
  assert.equal(result.decision, "invalid");
  assert.match(result.reason, /任务/);
});

test("任务或配置指纹与预注册计划不一致时拒绝评估", () => {
  const mismatched = {
    ...summary(metric(), metric({ successRate: 0.8, failedRate: 0.2, acceptancePassRate: 0.8 })),
    inputFingerprints: {
      tasks: { "bounded-mean": "sha256:different-task" },
      configs: {
        "baseline-deepseek": "sha256:baseline",
        "contract-checklist-deepseek": "sha256:candidate",
      },
    },
  };
  const result = assessExperiment(plan, mismatched as EvalSummaryDocument);
  assert.equal(result.decision, "invalid");
  assert.match(result.reason, /指纹/);
});

test("成本样本不完整时不能采用候选配置", () => {
  const result = assessExperiment(plan, summary(
    metric(),
    metric({ successRate: 0.8, failedRate: 0.2, acceptancePassRate: 0.8, averageDurationMs: 125, costRuns: 1, averageCost: 0.0001 }),
  ));
  assert.equal(result.decision, "reject");
  assert.equal(result.checks.find((check) => check.id === "candidate-cost-samples")?.passed, false);
});

test("实验计划拒绝不可能的样本数和质量阈值", () => {
  assert.throws(() => parseExperimentPlan({ ...plan, repeatsPerConfig: 101 }), /1 到 100/);
  assert.throws(() => parseExperimentPlan({ ...plan, criteria: { ...plan.criteria, minBaselineFailures: 6 } }), /不能大于/);
  assert.throws(() => parseExperimentPlan({ ...plan, criteria: { ...plan.criteria, minSuccessRateDelta: 1.1 } }), /0 到 1/);
  assert.throws(() => parseExperimentPlan({ ...plan, criteria: { ...plan.criteria, resourceBasis: "per-token" } }), /per-run 或 per-success/);
});

test("实验指纹不受对象字段插入顺序影响", () => {
  assert.equal(
    experimentFingerprint({ z: 1, "ä": 2, a: { y: 3, b: 4 } }),
    experimentFingerprint({ a: { b: 4, y: 3 }, "ä": 2, z: 1 }),
  );
});

test("仓库中的预注册实验可从归档汇总重算结论", async () => {
  const expected = {
    "bounded-mean": "inconclusive",
    "allocate-by-weight": "inconclusive",
    "allocate-extreme-weights": "reject",
    "allocate-extreme-weights-efficiency": "inconclusive",
    "allocate-extreme-weights-lean": "reject",
  } as const;
  for (const [id, decision] of Object.entries(expected)) {
    const plan = parseExperimentPlan(JSON.parse(await readFile(join(process.cwd(), "eval", "experiments", `${id}-plan.json`), "utf8")));
    const summary = await readEvalSummary(join(process.cwd(), "eval", "experiments", `${id}-result.json`));
    const assessment = assessExperiment(plan, summary);
    assert.equal(assessment.decision, decision);
    const archived = JSON.parse(await readFile(join(process.cwd(), "eval", "experiments", `${id}-result.json`), "utf8"));
    assert.equal(archived.assessment.decision, assessment.decision);
    assert.equal(archived.assessment.reason, assessment.reason);
  }
});
