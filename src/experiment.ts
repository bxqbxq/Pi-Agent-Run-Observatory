import { createHash } from "node:crypto";
import type { EvalSummaryDocument } from "./diff.js";
import { stableValue } from "./stable.js";

export interface ExperimentPlan {
  schemaVersion: 1;
  id: string;
  taskId: string;
  baselineConfigId: string;
  candidateConfigId: string;
  repeatsPerConfig: number;
  inputFingerprints: {
    task: string;
    baselineConfig: string;
    candidateConfig: string;
  };
  criteria: {
    resourceBasis?: "per-run" | "per-success";
    minBaselineFailures: number;
    minSuccessRateDelta: number;
    minAcceptanceRateDelta: number;
    maxDurationIncreaseRate: number;
    maxCostIncreaseRate: number;
  };
}

export interface ExperimentCheck {
  id: string;
  passed: boolean;
  actual: number | null;
  required: string;
}

export interface ExperimentAssessment {
  schemaVersion: 1;
  experimentId: string;
  taskId: string;
  decision: "adopt" | "reject" | "inconclusive" | "invalid";
  reason: string;
  checks: ExperimentCheck[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} 必须是非负${integer ? "整数" : "数字"}`);
  }
  return value;
}

export function experimentFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

export function parseExperimentPlan(value: unknown): ExperimentPlan {
  const input = object(value, "实验计划");
  if (input.schemaVersion !== 1) throw new Error("实验计划 schemaVersion 必须为 1");
  const criteria = object(input.criteria, "实验计划 criteria");
  const inputFingerprints = object(input.inputFingerprints, "实验计划 inputFingerprints");
  const repeatsPerConfig = nonNegativeNumber(input.repeatsPerConfig, "实验计划 repeatsPerConfig", true);
  if (repeatsPerConfig < 1 || repeatsPerConfig > 100) throw new Error("实验计划 repeatsPerConfig 必须在 1 到 100 之间");
  const minBaselineFailures = nonNegativeNumber(criteria.minBaselineFailures, "实验计划 criteria.minBaselineFailures", true);
  const minSuccessRateDelta = nonNegativeNumber(criteria.minSuccessRateDelta, "实验计划 criteria.minSuccessRateDelta");
  const minAcceptanceRateDelta = nonNegativeNumber(criteria.minAcceptanceRateDelta, "实验计划 criteria.minAcceptanceRateDelta");
  const resourceBasis = criteria.resourceBasis === undefined ? "per-run" : criteria.resourceBasis;
  if (resourceBasis !== "per-run" && resourceBasis !== "per-success") {
    throw new Error("实验计划 criteria.resourceBasis 必须是 per-run 或 per-success");
  }
  if (minBaselineFailures > repeatsPerConfig) throw new Error("实验计划 minBaselineFailures 不能大于 repeatsPerConfig");
  if (minSuccessRateDelta > 1 || minAcceptanceRateDelta > 1) throw new Error("实验计划质量比例阈值必须在 0 到 1 之间");
  return {
    schemaVersion: 1,
    id: string(input.id, "实验计划 id"),
    taskId: string(input.taskId, "实验计划 taskId"),
    baselineConfigId: string(input.baselineConfigId, "实验计划 baselineConfigId"),
    candidateConfigId: string(input.candidateConfigId, "实验计划 candidateConfigId"),
    repeatsPerConfig,
    inputFingerprints: {
      task: string(inputFingerprints.task, "实验计划 inputFingerprints.task"),
      baselineConfig: string(inputFingerprints.baselineConfig, "实验计划 inputFingerprints.baselineConfig"),
      candidateConfig: string(inputFingerprints.candidateConfig, "实验计划 inputFingerprints.candidateConfig"),
    },
    criteria: {
      resourceBasis,
      minBaselineFailures,
      minSuccessRateDelta,
      minAcceptanceRateDelta,
      maxDurationIncreaseRate: nonNegativeNumber(criteria.maxDurationIncreaseRate, "实验计划 criteria.maxDurationIncreaseRate"),
      maxCostIncreaseRate: nonNegativeNumber(criteria.maxCostIncreaseRate, "实验计划 criteria.maxCostIncreaseRate"),
    },
  };
}

function increaseRate(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null || baseline === 0) return null;
  return (candidate - baseline) / baseline;
}

function resourceValue(perRun: number | null, successRate: number, basis: "per-run" | "per-success"): number | null {
  if (perRun === null) return null;
  if (basis === "per-run") return perRun;
  return successRate > 0 ? perRun / successRate : null;
}

export function assessExperiment(plan: ExperimentPlan, summary: EvalSummaryDocument): ExperimentAssessment {
  const baseline = summary.byConfig[plan.baselineConfigId];
  const candidate = summary.byConfig[plan.candidateConfigId];
  if (!baseline) throw new Error(`评测汇总中不存在 baseline 配置：${plan.baselineConfigId}`);
  if (!candidate) throw new Error(`评测汇总中不存在 candidate 配置：${plan.candidateConfigId}`);

  const baselineFailures = Math.round(baseline.runs * (baseline.failedRate + baseline.timeoutRate));
  const successRateDelta = candidate.successRate - baseline.successRate;
  const acceptanceRateDelta = baseline.acceptancePassRate === null || candidate.acceptancePassRate === null
    ? null
    : candidate.acceptancePassRate - baseline.acceptancePassRate;
  const resourceBasis = plan.criteria.resourceBasis ?? "per-run";
  const durationIncreaseRate = increaseRate(
    resourceValue(baseline.averageDurationMs, baseline.successRate, resourceBasis),
    resourceValue(candidate.averageDurationMs, candidate.successRate, resourceBasis),
  );
  const costIncreaseRate = increaseRate(
    resourceValue(baseline.averageCost, baseline.successRate, resourceBasis),
    resourceValue(candidate.averageCost, candidate.successRate, resourceBasis),
  );
  const exactSamples = (id: string, actual: number): ExperimentCheck => ({
    id,
    passed: actual === plan.repeatsPerConfig,
    actual,
    required: `等于 ${plan.repeatsPerConfig}`,
  });
  const taskCheck: ExperimentCheck = {
    id: "task-id",
    passed: summary.taskId === plan.taskId,
    actual: null,
    required: `等于 ${plan.taskId}`,
  };
  const fingerprintCheck: ExperimentCheck = {
    id: "input-fingerprints",
    passed: summary.inputFingerprints?.tasks[plan.taskId] === plan.inputFingerprints.task
      && summary.inputFingerprints?.configs[plan.baselineConfigId] === plan.inputFingerprints.baselineConfig
      && summary.inputFingerprints?.configs[plan.candidateConfigId] === plan.inputFingerprints.candidateConfig,
    actual: null,
    required: "任务、baseline 配置和 candidate 配置均匹配预注册指纹",
  };
  const baselineSamples = exactSamples("baseline-samples", baseline.runs);
  const candidateSamples = exactSamples("candidate-samples", candidate.runs);
  const baselineAcceptanceSamples = exactSamples("baseline-acceptance-samples", baseline.acceptanceRuns);
  const candidateAcceptanceSamples = exactSamples("candidate-acceptance-samples", candidate.acceptanceRuns);
  const baselineCostSamples = exactSamples("baseline-cost-samples", baseline.costRuns ?? 0);
  const candidateCostSamples = exactSamples("candidate-cost-samples", candidate.costRuns ?? 0);
  const baselineFailureCheck: ExperimentCheck = {
    id: "baseline-failures",
    passed: baselineFailures >= plan.criteria.minBaselineFailures,
    actual: baselineFailures,
    required: `至少 ${plan.criteria.minBaselineFailures}`,
  };
  const qualityAndBudgetChecks: ExperimentCheck[] = [
    {
      id: "success-rate-delta",
      passed: successRateDelta >= plan.criteria.minSuccessRateDelta,
      actual: successRateDelta,
      required: `至少 ${plan.criteria.minSuccessRateDelta}`,
    },
    {
      id: "acceptance-rate-delta",
      passed: acceptanceRateDelta !== null && acceptanceRateDelta >= plan.criteria.minAcceptanceRateDelta,
      actual: acceptanceRateDelta,
      required: `至少 ${plan.criteria.minAcceptanceRateDelta}`,
    },
    {
      id: "duration-increase-rate",
      passed: durationIncreaseRate !== null && durationIncreaseRate <= plan.criteria.maxDurationIncreaseRate,
      actual: durationIncreaseRate,
      required: `按 ${resourceBasis} 口径至多 ${plan.criteria.maxDurationIncreaseRate}`,
    },
    {
      id: "cost-increase-rate",
      passed: costIncreaseRate !== null && costIncreaseRate <= plan.criteria.maxCostIncreaseRate,
      actual: costIncreaseRate,
      required: `按 ${resourceBasis} 口径至多 ${plan.criteria.maxCostIncreaseRate}`,
    },
  ];
  const checks = [
    taskCheck,
    fingerprintCheck,
    baselineSamples,
    candidateSamples,
    baselineAcceptanceSamples,
    candidateAcceptanceSamples,
    baselineCostSamples,
    candidateCostSamples,
    baselineFailureCheck,
    ...qualityAndBudgetChecks,
  ];

  if (!taskCheck.passed) {
    return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "invalid", reason: "评测结果任务与预注册计划不一致或无法验证", checks };
  }
  if (!fingerprintCheck.passed) {
    return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "invalid", reason: "评测输入指纹与预注册计划不一致或无法验证", checks };
  }
  if (!baselineSamples.passed || !candidateSamples.passed) {
    return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "invalid", reason: "样本数与预注册计划不一致", checks };
  }
  if (!baselineFailureCheck.passed) {
    return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "inconclusive", reason: "baseline 没有产生足够失败，任务缺少区分度", checks };
  }
  if (resourceBasis === "per-success" && baseline.successRate === 0) {
    return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "inconclusive", reason: "baseline 没有观测到成功，无法估算每次成功的资源消耗", checks };
  }
  const evidenceCoverageChecks = [baselineAcceptanceSamples, candidateAcceptanceSamples, baselineCostSamples, candidateCostSamples];
  if ([...evidenceCoverageChecks, ...qualityAndBudgetChecks].every((check) => check.passed)) {
    return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "adopt", reason: "候选配置同时满足质量改善和资源预算", checks };
  }
  return { schemaVersion: 1, experimentId: plan.id, taskId: plan.taskId, decision: "reject", reason: "候选配置未同时满足预注册质量改善和资源预算", checks };
}
