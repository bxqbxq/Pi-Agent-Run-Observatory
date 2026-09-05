export type RunOutcomeStatus = "success" | "failed" | "partial" | "unknown";
export type Severity = "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";

export type ReviewEventType =
  | "run_started"
  | "run_ended"
  | "agent_ended"
  | "turn_started"
  | "turn_ended"
  | "tool_started"
  | "tool_updated"
  | "tool_finished"
  | "tool_call"
  | "tool_result"
  | "message"
  | "model_selected"
  | "provider_response"
  | "provider_request"
  | "analysis"
  | "verification";

export interface ReviewEvent<T = Record<string, unknown>> {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  sessionId?: string;
  timestamp: string;
  type: ReviewEventType;
  toolCallId?: string;
  payload: T;
}

export interface Finding {
  findingId: string;
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  evidence: string[];
  trigger: string;
  recommendation: string;
}

export interface RunSummary {
  runId: string;
  sessionId?: string;
  model?: string;
  gitCommit?: string;
  /** One-way identifier derived from the normalized project root; never the path itself. */
  projectId?: string;
  startedAt: string;
  settledAt?: string;
  durationMs?: number;
  turnCount: number;
  toolCount: number;
  captureMode?: "redacted" | "full";
  usage?: Record<string, unknown>;
  cost?: number | null;
}

export interface RunReport {
  schemaVersion: 1;
  run: RunSummary;
  outcome: {
    status: RunOutcomeStatus;
    source: "rule" | "judge" | "human" | "unknown";
    verification: "passed" | "failed" | "missing" | "unknown";
  };
  findings: Finding[];
  explanation?: {
    generatedAt: string;
    model?: string;
    text: string;
  };
}

export interface AnalyzerConfig {
  duplicateWindow: number;
  duplicateThreshold: number;
  recoveryWindow: number;
  verificationCommands: string[];
}

export const DEFAULT_ANALYZER_CONFIG: AnalyzerConfig = {
  duplicateWindow: 5,
  duplicateThreshold: 3,
  recoveryWindow: 5,
  verificationCommands: ["test", "build", "typecheck", "lint"],
};

export interface NormalizedToolPayload {
  toolName: string;
  args?: unknown;
  argsSummary?: {
    structure: unknown;
    hash: string;
  };
  verificationKey?: string;
  verificationCommand?: string;
  resultSummary?: string;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
}

export interface VerificationPayload {
  command: string;
  exitCode?: number;
  passed: boolean;
  source: "declared" | "inferred";
}

const EVENT_TYPES: ReadonlySet<string> = new Set<ReviewEventType>([
  "run_started", "run_ended", "agent_ended", "turn_started", "turn_ended",
  "tool_started", "tool_updated", "tool_finished", "tool_call", "tool_result",
  "message", "model_selected", "provider_response", "provider_request", "analysis", "verification",
]);
const OUTCOME_STATUSES: ReadonlySet<string> = new Set<RunOutcomeStatus>(["success", "failed", "partial", "unknown"]);
const OUTCOME_SOURCES = new Set(["rule", "judge", "human", "unknown"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "missing", "unknown"]);
const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["high", "medium", "low"]);
const CONFIDENCES: ReadonlySet<string> = new Set<Confidence>(["high", "medium", "low"]);

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SchemaValidationError(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new SchemaValidationError(`${path} 必须是非空字符串`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringField(value, path);
}

function optionalProjectId(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const result = stringField(value, path);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new SchemaValidationError(`${path} 必须是 sha256 标识`);
  return result;
}

function nonNegativeNumber(value: unknown, path: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new SchemaValidationError(`${path} 必须是非负${integer ? "整数" : "数字"}`);
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = stringField(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new SchemaValidationError(`${path} 必须是有效时间`);
  return result;
}

function enumField<T extends string>(value: unknown, values: ReadonlySet<string>, path: string): T {
  if (typeof value !== "string" || !values.has(value)) throw new SchemaValidationError(`${path} 值无效`);
  return value as T;
}

export function parseReviewEvent(value: unknown): ReviewEvent {
  const input = record(value, "event");
  if (input.schemaVersion !== 1) throw new SchemaValidationError("event.schemaVersion 必须为 1");
  const payload = record(input.payload, "event.payload");
  return {
    schemaVersion: 1,
    eventId: stringField(input.eventId, "event.eventId"),
    runId: stringField(input.runId, "event.runId"),
    sessionId: optionalString(input.sessionId, "event.sessionId"),
    timestamp: timestamp(input.timestamp, "event.timestamp"),
    type: enumField<ReviewEventType>(input.type, EVENT_TYPES, "event.type"),
    toolCallId: optionalString(input.toolCallId, "event.toolCallId"),
    payload,
  };
}

function parseRunSummary(value: unknown): RunSummary {
  const input = record(value, "report.run");
  const usage = input.usage === undefined ? undefined : record(input.usage, "report.run.usage");
  const cost = input.cost === undefined || input.cost === null ? input.cost : nonNegativeNumber(input.cost, "report.run.cost");
  return {
    runId: stringField(input.runId, "report.run.runId"),
    sessionId: optionalString(input.sessionId, "report.run.sessionId"),
    model: optionalString(input.model, "report.run.model"),
    gitCommit: optionalString(input.gitCommit, "report.run.gitCommit"),
    projectId: optionalProjectId(input.projectId, "report.run.projectId"),
    startedAt: timestamp(input.startedAt, "report.run.startedAt"),
    settledAt: input.settledAt === undefined ? undefined : timestamp(input.settledAt, "report.run.settledAt"),
    durationMs: input.durationMs === undefined ? undefined : nonNegativeNumber(input.durationMs, "report.run.durationMs"),
    turnCount: nonNegativeNumber(input.turnCount, "report.run.turnCount", true),
    toolCount: nonNegativeNumber(input.toolCount, "report.run.toolCount", true),
    captureMode: input.captureMode === undefined ? undefined : enumField<"redacted" | "full">(input.captureMode, new Set(["redacted", "full"]), "report.run.captureMode"),
    usage,
    cost,
  };
}

function parseFinding(value: unknown, index: number): Finding {
  const path = `report.findings[${index}]`;
  const input = record(value, path);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.some((item) => typeof item !== "string" || !item)) {
    throw new SchemaValidationError(`${path}.evidence 必须是非空字符串数组`);
  }
  return {
    findingId: stringField(input.findingId, `${path}.findingId`),
    ruleId: stringField(input.ruleId, `${path}.ruleId`),
    severity: enumField<Severity>(input.severity, SEVERITIES, `${path}.severity`),
    confidence: enumField<Confidence>(input.confidence, CONFIDENCES, `${path}.confidence`),
    evidence: input.evidence as string[],
    trigger: stringField(input.trigger, `${path}.trigger`),
    recommendation: stringField(input.recommendation, `${path}.recommendation`),
  };
}

export function parseRunReport(value: unknown): RunReport {
  const input = record(value, "report");
  if (input.schemaVersion !== 1) throw new SchemaValidationError("report.schemaVersion 必须为 1");
  const outcome = record(input.outcome, "report.outcome");
  if (!Array.isArray(input.findings)) throw new SchemaValidationError("report.findings 必须是数组");
  const explanation = input.explanation === undefined ? undefined : record(input.explanation, "report.explanation");
  return {
    schemaVersion: 1,
    run: parseRunSummary(input.run),
    outcome: {
      status: enumField<RunOutcomeStatus>(outcome.status, OUTCOME_STATUSES, "report.outcome.status"),
      source: enumField<RunReport["outcome"]["source"]>(outcome.source, OUTCOME_SOURCES, "report.outcome.source"),
      verification: enumField<RunReport["outcome"]["verification"]>(outcome.verification, VERIFICATION_STATUSES, "report.outcome.verification"),
    },
    findings: input.findings.map(parseFinding),
    explanation: explanation ? {
      generatedAt: timestamp(explanation.generatedAt, "report.explanation.generatedAt"),
      model: optionalString(explanation.model, "report.explanation.model"),
      text: stringField(explanation.text, "report.explanation.text"),
    } : undefined,
  };
}
