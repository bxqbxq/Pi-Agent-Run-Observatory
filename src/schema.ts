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
  startedAt: string;
  settledAt?: string;
  durationMs?: number;
  turnCount: number;
  toolCount: number;
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
