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

function isVerification(event: ReviewEvent, config: AnalyzerConfig): boolean {
  if (event.type === "verification") return true;
  if (event.type !== "tool_finished") return false;
  const payload = payloadOf(event);
  const name = `${payload.toolName ?? ""} ${payload.args ?? ""} ${payload.resultSummary ?? ""}`.toLowerCase();
  return config.verificationCommands.some((command) => name.includes(command.toLowerCase()));
}

function verificationPassed(event: ReviewEvent): boolean {
  if (event.type === "verification") return (event.payload as unknown as VerificationPayload).passed;
  const payload = payloadOf(event);
  return payload.isError !== true && payload.exitCode === 0;
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
  const hasFailedVerification = verificationEvents.some((event) => !verificationPassed(event));
  const hasPassedVerification = verificationEvents.some(verificationPassed);
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
    const key = `${currentPayload.toolName ?? ""}:${normalizedArgs(currentPayload.args)}`;
    const window = calls.slice(Math.max(0, index - config.duplicateWindow + 1), index + 1);
    const matches = window.filter((candidate) => `${payloadOf(candidate).toolName ?? ""}:${normalizedArgs(payloadOf(candidate).args)}` === key);
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
  const laterSuccess = events.some((event, index) => index > events.indexOf(failures[failures.length - 1]) && isVerification(event, config) && verificationPassed(event));
  if (laterSuccess) return [];
  const completion = events.filter((event) => event.type === "message").slice(-1);
  return [finding("verification-failure-ignored", "high", "high", [...failures, ...completion], "验证命令失败后没有成功重跑，run 仍然结束", "先修复验证失败，再重新执行验证命令并确认退出码为 0")];
}
