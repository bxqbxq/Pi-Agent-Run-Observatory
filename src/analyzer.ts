import {
  DEFAULT_ANALYZER_CONFIG,
  type AnalyzerConfig,
  type Finding,
  type ReviewEvent,
  type RunOutcomeStatus,
  type RunReport,
  type RunSummary,
  type VerificationPayload,
  type NormalizedToolPayload,
} from "./schema.js";

function payloadOf(event: ReviewEvent): Partial<NormalizedToolPayload> {
  return event.payload as Partial<NormalizedToolPayload>;
}

function finding(ruleId: string, severity: Finding["severity"], confidence: Finding["confidence"], evidence: ReviewEvent[], trigger: string, recommendation: string): Finding {
  return {
    findingId: `${ruleId}:${evidence.map((event) => event.eventId).join(",")}`,
    ruleId,
    severity,
    confidence,
    evidence: evidence.map((event) => event.eventId),
    trigger,
    recommendation,
  };
}

function normalizedArgs(args: unknown): string {
  if (args === undefined) return "";
  if (typeof args === "string") return args.replace(/\s+/g, " ").trim();
  if (Array.isArray(args)) return JSON.stringify(args.map(normalizedArgs));
  if (args && typeof args === "object") {
    return JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalizedArgs(value)])));
  }
  return String(args);
}

function verificationKey(event: ReviewEvent, config: AnalyzerConfig): string | undefined {
  if (event.type === "verification") {
    const command = (event.payload as unknown as VerificationPayload).command.replace(/\s+/g, " ").trim().toLowerCase();
    const index = config.verificationCommands.findIndex((candidate) => command.includes(candidate.toLowerCase()));
    return index >= 0 ? `verification:${index}` : command;
  }
  if (event.type !== "tool_finished") return undefined;
  const payload = payloadOf(event);
  if (payload.verificationKey) return payload.verificationKey;
  if (payload.verificationCommand) {
    const index = config.verificationCommands.findIndex((candidate) => payload.verificationCommand?.toLowerCase() === candidate.toLowerCase());
    return index >= 0 ? `verification:${index}` : payload.verificationCommand.toLowerCase();
  }
  const name = `${payload.toolName ?? ""} ${payload.args ?? ""} ${payload.resultSummary ?? ""}`.toLowerCase();
  const index = config.verificationCommands.findIndex((command) => name.includes(command.toLowerCase()));
  return index >= 0 ? `verification:${index}` : undefined;
}

function isVerification(event: ReviewEvent, config: AnalyzerConfig): boolean {
  return verificationKey(event, config) !== undefined;
}

function verificationPassed(event: ReviewEvent): boolean {
  if (event.type === "verification") return (event.payload as unknown as VerificationPayload).passed;
  const payload = payloadOf(event);
  return payload.isError !== true && payload.exitCode === 0;
}

function claimsCompletion(event: ReviewEvent): boolean {
  if (event.type !== "message") return false;
  const payload = event.payload as { role?: string; summary?: unknown; text?: unknown; contentSummary?: { completionClaim?: boolean } };
  if (payload.role !== "assistant") return false;
  if (payload.contentSummary?.completionClaim !== undefined) return payload.contentSummary.completionClaim;
  const text = String(payload.summary ?? payload.text ?? "");
  const reportsFailure = /未完成|没有完成|尚未完成|无法完成|不能完成|失败|未通过|没有通过|错误|阻塞|\b(?:failed|failure|error|blocked|incomplete|not\s+(?:done|complete|completed|finished|successful)|did not|could not)\b/i.test(text);
  const reportsCompletion = /任务(?:已经|已)?完成|测试(?:已经|已)?通过|验证(?:已经|已)?通过|\b(?:done|completed|finished|success(?:ful)?|tests?\s+passed)\b/i.test(text);
  return reportsCompletion && !reportsFailure;
}

export function analyzeRun(events: ReviewEvent[], run: RunSummary, config: Partial<AnalyzerConfig> = {}): RunReport {
  const options: AnalyzerConfig = {
    duplicateWindow: config.duplicateWindow ?? DEFAULT_ANALYZER_CONFIG.duplicateWindow,
    duplicateThreshold: config.duplicateThreshold ?? DEFAULT_ANALYZER_CONFIG.duplicateThreshold,
    recoveryWindow: config.recoveryWindow ?? DEFAULT_ANALYZER_CONFIG.recoveryWindow,
    verificationCommands: config.verificationCommands ?? DEFAULT_ANALYZER_CONFIG.verificationCommands,
  };
  const findings = [
    ...detectToolFailures(events, options),
    ...detectDuplicateCalls(events, options),
    ...detectUnverifiedChanges(events, options),
    ...detectIgnoredVerificationFailures(events, options),
  ];
  const verificationEvents = events.filter((event) => isVerification(event, options));
  const latestVerificationByKey = new Map<string, ReviewEvent>();
  for (const event of verificationEvents) latestVerificationByKey.set(verificationKey(event, options) ?? event.eventId, event);
  const effectiveVerificationEvents = [...latestVerificationByKey.values()];
  const hasFailedVerification = effectiveVerificationEvents.some((event) => !verificationPassed(event));
  const hasPassedVerification = effectiveVerificationEvents.some(verificationPassed);
  const verification = hasFailedVerification ? "failed" : hasPassedVerification ? "passed" : "missing";
  let status: RunOutcomeStatus = hasFailedVerification ? "failed" : verification === "missing" ? "unknown" : "success";
  if (findings.some((item) => item.severity === "high") && status === "success") status = "partial";
  return {
    schemaVersion: 1,
    run,
    outcome: { status, source: status === "unknown" ? "unknown" : "rule", verification },
    findings,
  };
}

function detectToolFailures(events: ReviewEvent[], config: AnalyzerConfig): Finding[] {
  const results: Finding[] = [];
  const finished = events.filter((event) => event.type === "tool_finished");
  for (const event of finished) {
    const payload = payloadOf(event);
    if (!payload.isError) continue;
    const sourceIndex = events.indexOf(event);
    const laterEvents = events.slice(sourceIndex + 1, sourceIndex + 1 + config.recoveryWindow);
    const later = laterEvents.filter((candidate) => candidate.type === "tool_finished");
    const recovered = later.some((candidate) => {
      const candidatePayload = payloadOf(candidate);
      return candidatePayload.isError !== true && candidatePayload.toolName === payload.toolName;
    });
    if (!recovered) {
      results.push(finding("tool-failure-unrecovered", "high", "high", [event, ...laterEvents.slice(-1)], "工具调用失败后恢复窗口内没有成功操作", "修正参数、切换策略或明确向用户报告失败原因"));
    }
  }
  return results;
}

function detectDuplicateCalls(events: ReviewEvent[], config: AnalyzerConfig): Finding[] {
  const calls = events.filter((event) => event.type === "tool_started");
  const results: Finding[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const current = calls[index];
    const currentPayload = payloadOf(current);
    const key = `${currentPayload.toolName ?? ""}:${currentPayload.argsSummary?.hash ?? normalizedArgs(currentPayload.args)}`;
    const window = calls.slice(Math.max(0, index - config.duplicateWindow + 1), index + 1);
    const matches = window.filter((candidate) => {
      const payload = payloadOf(candidate);
      return `${payload.toolName ?? ""}:${payload.argsSummary?.hash ?? normalizedArgs(payload.args)}` === key;
    });
    if (matches.length >= config.duplicateThreshold) {
      results.push(finding("ineffective-duplicate-call", "medium", matches.length >= config.duplicateThreshold + 1 ? "high" : "medium", matches, `相同工具调用在最近 ${config.duplicateWindow} 次调用中出现 ${matches.length} 次`, "检查参数、读取结果和当前状态，避免重复执行没有新信息的调用"));
      break;
    }
  }
  return results;
}

function detectUnverifiedChanges(events: ReviewEvent[], config: AnalyzerConfig): Finding[] {
  const changes = events.filter((event) => event.type === "tool_finished" && payloadOf(event).isError !== true && /^(write|edit|apply_patch|patch)$/i.test(String(payloadOf(event).toolName ?? "")));
  if (!changes.length || events.some((event) => isVerification(event, config) && verificationPassed(event))) return [];
  return [finding("change-without-verification", "high", "high", changes, "检测到文件改动，但 run 结束前没有成功验证命令", "运行任务声明的测试、构建、类型检查或 lint 命令")];
}

function detectIgnoredVerificationFailures(events: ReviewEvent[], config: AnalyzerConfig): Finding[] {
  const failures = events.filter((event) => isVerification(event, config) && !verificationPassed(event));
  if (!failures.length) return [];
  for (const failure of [...failures].reverse()) {
    const failureIndex = events.indexOf(failure);
    const completionIndex = events.findIndex((event, index) => index > failureIndex && claimsCompletion(event));
    if (completionIndex < 0) continue;
    const failureKey = verificationKey(failure, config);
    const recovered = events.slice(failureIndex + 1, completionIndex).some((event) => verificationKey(event, config) === failureKey && verificationPassed(event));
    if (!recovered) {
      return [finding("verification-failure-ignored", "high", "high", [failure, events[completionIndex]], "验证命令失败后没有成功重跑，run 仍然结束", "先修复验证失败，再重新执行验证命令并确认退出码为 0")];
    }
  }
  return [];
}
