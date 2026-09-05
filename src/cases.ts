import { readFile } from "node:fs/promises";
import { parseReviewEvent, parseRunReport, type Finding, type ReviewEvent, type RunReport } from "./schema.js";

export interface FailureCaseDocument {
  schemaVersion: 1;
  generatedAt: string;
  case: {
    id: string;
    kind: "real-pi-failure";
    source: "real-pi-run-redacted";
    taskId: string;
    model?: string;
    runId: string;
  };
  events: ReviewEvent[];
  report: RunReport;
  annotation: {
    reviewer: "human";
    expectedFinding: {
      ruleId: string;
      evidence: string[];
      rationale: string;
    };
  };
  redaction: {
    mode: "redacted";
    omitted: string[];
    limitation: string;
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label} 必须是非空字符串数组`);
  return [...value] as string[];
}

function findingEvidence(findings: Finding[], label: string): string[] {
  return findings.flatMap((finding, index) => {
    if (!finding.evidence.length) throw new Error(`${label}[${index}] 缺少 evidence`);
    return finding.evidence;
  });
}

export function parseFailureCase(value: unknown): FailureCaseDocument {
  const input = object(value, "失败案例");
  if (input.schemaVersion !== 1) throw new Error("失败案例 schemaVersion 必须为 1");
  const generatedAt = stringField(input.generatedAt, "失败案例 generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("失败案例 generatedAt 无效");
  const caseInput = object(input.case, "失败案例 case");
  if (caseInput.kind !== "real-pi-failure" || caseInput.source !== "real-pi-run-redacted") throw new Error("失败案例必须声明为脱敏真实 Pi 失败运行");
  const report = parseRunReport(input.report);
  const runId = stringField(caseInput.runId, "失败案例 case.runId");
  if (runId !== report.run.runId) throw new Error("失败案例 case.runId 必须与 report.run.runId 一致");
  const eventsInput = input.events;
  if (!Array.isArray(eventsInput) || eventsInput.length < 3) throw new Error("失败案例 events 必须至少包含 3 个事件");
  const events = eventsInput.map(parseReviewEvent);
  const eventIds = new Set<string>();
  let previousTimestamp = "";
  for (const event of events) {
    if (event.runId !== runId) throw new Error("失败案例事件必须属于同一个 run");
    if (eventIds.has(event.eventId)) throw new Error("失败案例事件 eventId 不能重复");
    if (previousTimestamp && Date.parse(event.timestamp) < Date.parse(previousTimestamp)) throw new Error("失败案例事件链必须按时间顺序排列");
    eventIds.add(event.eventId);
    previousTimestamp = event.timestamp;
  }
  if (!events.some((event) => event.type === "run_ended")) throw new Error("失败案例事件链必须包含 run_ended");
  if (!events.some((event) => event.type === "agent_ended")) throw new Error("失败案例事件链必须包含 agent_ended");
  if (!events.some((event) => event.type === "tool_finished" && object(event.payload, "失败案例 tool_finished.payload").isError === true)) {
    throw new Error("失败案例事件链必须包含失败工具事件");
  }
  const annotationInput = object(input.annotation, "失败案例 annotation");
  if (annotationInput.reviewer !== "human") throw new Error("失败案例必须包含人工标注");
  const expectedInput = object(annotationInput.expectedFinding, "失败案例 annotation.expectedFinding");
  const evidence = stringArray(expectedInput.evidence, "失败案例 annotation.expectedFinding.evidence");
  if (evidence.some((eventId) => !eventIds.has(eventId))) throw new Error("人工标注 evidence 必须引用事件链中的 eventId");
  const expectedRuleId = stringField(expectedInput.ruleId, "失败案例 annotation.expectedFinding.ruleId");
  if (!report.findings.some((finding) => finding.ruleId === expectedRuleId)) throw new Error("人工预期规则必须出现在报告 findings 中");
  const findingsEvidence = findingEvidence(report.findings, "失败案例 report.findings");
  if (findingsEvidence.some((eventId) => !eventIds.has(eventId))) throw new Error("报告 finding evidence 必须引用事件链中的 eventId");
  const redactionInput = object(input.redaction, "失败案例 redaction");
  if (redactionInput.mode !== "redacted") throw new Error("失败案例必须声明 redacted 模式");
  return {
    schemaVersion: 1,
    generatedAt,
    case: {
      id: stringField(caseInput.id, "失败案例 case.id"),
      kind: "real-pi-failure",
      source: "real-pi-run-redacted",
      taskId: stringField(caseInput.taskId, "失败案例 case.taskId"),
      model: caseInput.model === undefined ? undefined : stringField(caseInput.model, "失败案例 case.model"),
      runId,
    },
    events,
    report,
    annotation: {
      reviewer: "human",
      expectedFinding: {
        ruleId: expectedRuleId,
        evidence,
        rationale: stringField(expectedInput.rationale, "失败案例 annotation.expectedFinding.rationale"),
      },
    },
    redaction: {
      mode: "redacted",
      omitted: stringArray(redactionInput.omitted, "失败案例 redaction.omitted"),
      limitation: stringField(redactionInput.limitation, "失败案例 redaction.limitation"),
    },
  };
}

export async function readFailureCase(path: string): Promise<FailureCaseDocument> {
  return parseFailureCase(JSON.parse(await readFile(path, "utf8")));
}
