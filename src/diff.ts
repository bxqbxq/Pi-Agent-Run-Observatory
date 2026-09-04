import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvalConfigSummary } from "./eval.js";

export interface EvalSummaryDocument {
  schemaVersion: 1;
  generatedAt: string;
  byConfig: Record<string, EvalConfigSummary>;
}

interface MetricComparison {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

export interface EvalConfigComparison {
  kind: "config-set";
  source: string;
  baseline: string;
  candidate: string;
  metrics: Record<string, MetricComparison>;
  findingRates: Record<string, MetricComparison>;
}

const REQUIRED_METRICS = [
  "runs", "successRate", "failedRate", "timeoutRate", "unknownRate",
  "expectedRuns", "expectationPassRate", "acceptanceRuns", "acceptancePassRate",
  "averageDurationMs", "p95DurationMs", "averageTurns", "averageTools",
] as const;

const OPTIONAL_METRICS = [
  "usageRuns", "averageInputTokens", "averageOutputTokens", "averageTotalTokens",
  "costRuns", "averageCost",
] as const;

const NULLABLE_METRICS = new Set<string>([
  "unknownRate", "expectationPassRate", "acceptancePassRate", "averageTurns", "averageTools",
  "usageRuns", "averageInputTokens", "averageOutputTokens", "averageTotalTokens", "costRuns", "averageCost",
]);
const RATE_METRICS = new Set<string>(["successRate", "failedRate", "timeoutRate", "unknownRate", "expectationPassRate", "acceptancePassRate"]);
const INTEGER_METRICS = new Set<string>(["runs", "expectedRuns", "acceptanceRuns", "usageRuns", "costRuns"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function metric(value: unknown, label: string, name: string, optional = false): number | null {
  if ((value === null && NULLABLE_METRICS.has(name)) || (optional && value === undefined)) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负数字或 null`);
  if (RATE_METRICS.has(name) && value > 1) throw new Error(`${label} 必须在 0 到 1 之间`);
  if (INTEGER_METRICS.has(name) && !Number.isInteger(value)) throw new Error(`${label} 必须是整数`);
  return value;
}

function parseConfigSummary(value: unknown, configId: string): EvalConfigSummary {
  const input = object(value, `byConfig.${configId}`);
  const findingInput = object(input.findingRates, `byConfig.${configId}.findingRates`);
  const findingRates = Object.fromEntries(Object.entries(findingInput).map(([ruleId, value]) => {
    const rate = metric(value, `byConfig.${configId}.findingRates.${ruleId}`, "findingRate");
    if (rate === null || rate > 1) throw new Error(`byConfig.${configId}.findingRates.${ruleId} 必须在 0 到 1 之间`);
    return [ruleId, rate];
  }));
  const parsed = Object.fromEntries(REQUIRED_METRICS.map((key) => [key, metric(input[key], `byConfig.${configId}.${key}`, key)]));
  const optional = Object.fromEntries(OPTIONAL_METRICS.map((key) => [key, metric(input[key], `byConfig.${configId}.${key}`, key, true)]));
  return { ...parsed, ...optional, findingRates } as EvalConfigSummary;
}

export function parseEvalSummary(value: unknown): EvalSummaryDocument {
  const input = object(value, "评测汇总");
  if (input.schemaVersion !== 1) throw new Error("评测汇总 schemaVersion 必须为 1");
  if (typeof input.generatedAt !== "string" || !Number.isFinite(Date.parse(input.generatedAt))) throw new Error("评测汇总 generatedAt 无效");
  const byConfigInput = object(input.byConfig, "评测汇总 byConfig");
  const byConfig = Object.fromEntries(Object.entries(byConfigInput).map(([configId, summary]) => [configId, parseConfigSummary(summary, configId)]));
  return { schemaVersion: 1, generatedAt: input.generatedAt, byConfig };
}

export async function readEvalSummary(path: string): Promise<EvalSummaryDocument> {
  return parseEvalSummary(JSON.parse(await readFile(path, "utf8")));
}

function comparison(baseline: number | null, candidate: number | null): MetricComparison {
  return { baseline, candidate, delta: baseline === null || candidate === null ? null : Number((candidate - baseline).toPrecision(12)) };
}

export function compareEvalConfigs(summary: EvalSummaryDocument, baselineId: string, candidateId: string, source: string): EvalConfigComparison {
  const baseline = summary.byConfig[baselineId];
  const candidate = summary.byConfig[candidateId];
  if (!baseline) throw new Error(`评测汇总中不存在配置：${baselineId}`);
  if (!candidate) throw new Error(`评测汇总中不存在配置：${candidateId}`);
  const metricNames = [...REQUIRED_METRICS, ...OPTIONAL_METRICS];
  const metrics = Object.fromEntries(metricNames.map((name) => [name, comparison(baseline[name] ?? null, candidate[name] ?? null)]));
  const ruleIds = [...new Set([...Object.keys(baseline.findingRates), ...Object.keys(candidate.findingRates)])].sort();
  const findingRates = Object.fromEntries(ruleIds.map((ruleId) => [ruleId, comparison(baseline.findingRates[ruleId] ?? 0, candidate.findingRates[ruleId] ?? 0)]));
  return { kind: "config-set", source, baseline: baselineId, candidate: candidateId, metrics, findingRates };
}

export async function findLatestEvalSummary(cwd: string, baselineId: string, candidateId: string): Promise<{ path: string; summary: EvalSummaryDocument } | undefined> {
  const dir = resolve(cwd, "eval", "results");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  } catch {
    return undefined;
  }
  const candidates = await Promise.all(files.map(async (file) => ({ path: join(dir, file), mtime: (await stat(join(dir, file))).mtimeMs })));
  for (const candidate of candidates.sort((left, right) => right.mtime - left.mtime)) {
    try {
      const summary = await readEvalSummary(candidate.path);
      if (summary.byConfig[baselineId] && summary.byConfig[candidateId]) return { path: candidate.path, summary };
    } catch {
      // Ignore unrelated or incompatible JSON files while searching for a matching summary.
    }
  }
  return undefined;
}
