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

function comparableArgs(payload: Partial<NormalizedToolPayload>): string | undefined {
  if (payload.argsSummary?.hash) return payload.argsSummary.hash;
  if (payload.args === undefined) return undefined;
  return normalizedArgs(payload.args);
}

function toolCategory(toolName: unknown): string {
  const name = String(toolName ?? "").toLowerCase();
  if (/^(?:read|grep|find|ls|search|view|cat)$/.test(name)) return "inspect";
  if (/^(?:write|edit|apply_patch|patch)$/.test(name)) return "change";
  if (/^(?:bash|powershell|shell|exec|command)$/.test(name)) return "command";
  return name;
}

function isDefiniteProgress(event: ReviewEvent, repeatedToolCallIds: Set<string>): boolean {
  if (event.type === "verification") return verificationPassed(event);
  if (event.type !== "tool_finished") return false;
  if (event.toolCallId && repeatedToolCallIds.has(event.toolCallId)) return false;
  const payload = payloadOf(event);
  return payload.isError !== true && /^(?:write|edit|apply_patch|patch)$/i.test(String(payload.toolName ?? ""));
}

function isPossibleProgress(event: ReviewEvent, repeatedToolCallIds: Set<string>): boolean {
  if (event.type !== "tool_finished") return false;
  if (event.toolCallId && repeatedToolCallIds.has(event.toolCallId)) return false;
  return payloadOf(event).isError !== true;
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
  if (!/^(?:bash|powershell|shell|exec|command)$/i.test(String(payload.toolName ?? ""))) return undefined;
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
  const reportsCompletion = /任务(?:已经|已)?完成|测试(?:已经|已)?通过|验证(?:已经|已)?通过|\b(?:done|completed|finished|success(?:ful)?|tests?\s+passed)\b/i.test(text);
  return reportsCompletion;
}

function aggregateRunUsage(events: ReviewEvent[], run: RunSummary): RunSummary {
  const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
  const usage = Object.fromEntries(usageKeys.map((key) => [key, 0])) as Record<(typeof usageKeys)[number], number>;
  const observedUsage = new Set<string>();
  let hasUsage = false;
  let cost = 0;
  let hasCost = false;
  for (const event of events) {
    if (event.type !== "message" || event.payload.role !== "assistant") continue;
    const messageUsage = event.payload.usage;
    if (!messageUsage || typeof messageUsage !== "object" || Array.isArray(messageUsage)) continue;
    const values = messageUsage as Record<string, unknown>;
    for (const key of usageKeys) {
      if (typeof values[key] === "number" && Number.isFinite(values[key])) {
        usage[key] += values[key];
        observedUsage.add(key);
        hasUsage = true;
      }
    }
    const costValue = values.cost;
    if (costValue && typeof costValue === "object" && !Array.isArray(costValue)) {
      const total = (costValue as Record<string, unknown>).total;
      if (typeof total === "number" && Number.isFinite(total)) {
        cost += total;
        hasCost = true;
      }
    }
  }
  if (!hasUsage) {
    for (const event of events) {
      if (event.type !== "provider_response") continue;
      const summary = event.payload.usageSummary;
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) continue;
      const metrics = (summary as Record<string, unknown>).metrics;
      if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) continue;
      const values = metrics as Record<string, unknown>;
      const readMetric = (names: string[]): number | undefined => {
        for (const name of names) {
          const value = values[name];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
        }
        return undefined;
      };
      const measured = {
        input: readMetric(["input", "inputTokens", "promptTokens", "prompt_tokens"]),
        output: readMetric(["output", "outputTokens", "completionTokens", "completion_tokens"]),
        cacheRead: readMetric(["cacheRead", "cache_read", "cachedTokens", "cached_tokens"]),
        cacheWrite: readMetric(["cacheWrite", "cache_write"]),
        reasoning: readMetric(["reasoning", "reasoningTokens", "reasoning_tokens"]),
        totalTokens: readMetric(["totalTokens", "total_tokens"]),
      };
      for (const [key, value] of Object.entries(measured)) {
        if (value !== undefined) {
          usage[key as keyof typeof usage] += value;
          observedUsage.add(key);
          hasUsage = true;
        }
      }
      const providerCost = readMetric(["cost", "totalCost", "total_cost"]);
      if (providerCost !== undefined) {
        cost += providerCost;
        hasCost = true;
      }
    }
  }
  if (hasUsage && !observedUsage.has("totalTokens")) {
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  return {
    ...run,
    usage: hasUsage ? usage : run.usage,
    cost: hasCost ? cost : run.cost,
  };
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
    run: aggregateRunUsage(events, run),
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
    const remainingEvents = events.slice(sourceIndex + 1);
    const later = remainingEvents
      .filter((candidate) => candidate.type === "tool_finished" || candidate.type === "verification")
      .slice(0, config.recoveryWindow);
    const failedVerificationKey = verificationKey(event, config);
    const recovered = later.some((candidate) => {
      if (failedVerificationKey) return verificationKey(candidate, config) === failedVerificationKey && verificationPassed(candidate);
      if (candidate.type !== "tool_finished") return false;
      const candidatePayload = payloadOf(candidate);
      return candidatePayload.isError !== true && candidatePayload.toolName === payload.toolName;
    });
    if (recovered) continue;
    const category = toolCategory(payload.toolName);
    const possibleRecovery = category && later.find((candidate) => {
      if (candidate.type === "verification") return failedVerificationKey !== undefined && verificationPassed(candidate);
      const candidatePayload = payloadOf(candidate);
      if (candidatePayload.isError === true) return false;
      if (failedVerificationKey) return toolCategory(candidatePayload.toolName) === category;
      return candidatePayload.toolName !== payload.toolName && toolCategory(candidatePayload.toolName) === category;
    });
    if (possibleRecovery) {
      results.push(finding("tool-failure-unrecovered", "medium", "low", [event, possibleRecovery], "工具失败后出现同类别替代操作，但无法确认其是否消除了失败影响", "检查替代操作的结果是否覆盖原失败目标，并补充明确验证"));
      continue;
    }
    const boundary = later.at(-1)
      ?? [...remainingEvents].reverse().find((candidate) => candidate.type === "agent_ended" || candidate.type === "run_ended" || claimsCompletion(candidate));
    if (!boundary) {
      results.push(finding("tool-failure-unrecovered", "medium", "low", [event], "检测到工具失败，但缺少后续完成操作或 run 结束证据，无法确认是否恢复", "检查后续事件是否完整，并确认失败影响是否已消除"));
      continue;
    }
    results.push(finding("tool-failure-unrecovered", "high", "high", [event, boundary], "工具调用失败后恢复窗口内没有成功操作", "修正参数、切换策略或明确向用户报告失败原因"));
  }
  return results;
}

function detectDuplicateCalls(events: ReviewEvent[], config: AnalyzerConfig): Finding[] {
  const calls = events.filter((event) => event.type === "tool_started");
  let strongest: Finding | undefined;
  const confidenceRank: Record<Finding["confidence"], number> = { low: 1, medium: 2, high: 3 };
  for (let index = 0; index < calls.length; index += 1) {
    const current = calls[index];
    const currentPayload = payloadOf(current);
    const currentArgs = comparableArgs(currentPayload);
    if (!currentPayload.toolName || currentArgs === undefined) continue;
    const key = `${currentPayload.toolName}:${currentArgs}`;
    const window = calls.slice(Math.max(0, index - config.duplicateWindow + 1), index + 1);
    const matches = window.filter((candidate) => {
      const payload = payloadOf(candidate);
      const args = comparableArgs(payload);
      return args !== undefined && `${payload.toolName ?? ""}:${args}` === key;
    });
    if (matches.length >= config.duplicateThreshold) {
      const currentEventIndex = events.indexOf(current);
      const repeatedToolCallIds = new Set(matches.flatMap((match) => match.toolCallId ? [match.toolCallId] : []));
      const firstEventIndex = events.indexOf(matches[0]);
      const lastProgressIndex = events.slice(firstEventIndex + 1, currentEventIndex)
        .reduce((latest, event, offset) => isDefiniteProgress(event, repeatedToolCallIds) ? firstEventIndex + 1 + offset : latest, -1);
      const effectiveMatches = matches.filter((match) => events.indexOf(match) > lastProgressIndex);
      if (effectiveMatches.length < config.duplicateThreshold) continue;
      const effectiveFirstIndex = events.indexOf(effectiveMatches[0]);
      const interval = events.slice(effectiveFirstIndex + 1, currentEventIndex);
      const possibleProgress = interval.find((event) => isPossibleProgress(event, repeatedToolCallIds));
      let consecutiveCount = 0;
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (events.indexOf(calls[cursor]) <= lastProgressIndex) break;
        const payload = payloadOf(calls[cursor]);
        const args = comparableArgs(payload);
        if (args === undefined || `${payload.toolName ?? ""}:${args}` !== key) break;
        consecutiveCount += 1;
      }
      const candidate = finding(
        "ineffective-duplicate-call",
        "medium",
        possibleProgress ? "low" : consecutiveCount >= config.duplicateThreshold + 1 ? "high" : "medium",
        possibleProgress ? [...effectiveMatches, possibleProgress] : effectiveMatches,
        possibleProgress
          ? `相同工具调用在最近 ${config.duplicateWindow} 次调用中出现 ${effectiveMatches.length} 次，期间存在无法确认效果的成功操作`
          : `相同工具调用在最近 ${config.duplicateWindow} 次调用中出现 ${effectiveMatches.length} 次`,
        "检查参数、读取结果和当前状态，避免重复执行没有新信息的调用",
      );
      if (!strongest || confidenceRank[candidate.confidence] > confidenceRank[strongest.confidence]) strongest = candidate;
    }
  }
  return strongest ? [strongest] : [];
}

function detectUnverifiedChanges(events: ReviewEvent[], config: AnalyzerConfig): Finding[] {
  const changes = events.filter((event) => event.type === "tool_finished" && payloadOf(event).isError !== true && /^(write|edit|apply_patch|patch)$/i.test(String(payloadOf(event).toolName ?? "")));
  const workspaceEvent = [...events].reverse().find((event) => event.type === "run_ended" && typeof event.payload.workspaceChanged === "boolean");
  if (workspaceEvent?.payload.workspaceChanged === false) return [];
  const latestChangeIndex = changes.reduce((latest, event) => Math.max(latest, events.indexOf(event)), -1);
  const verificationFloorIndex = latestChangeIndex >= 0
    ? latestChangeIndex
    : workspaceEvent
      ? events.indexOf(workspaceEvent)
      : -1;
  const hasSuccessfulVerificationAfterChange = events.some((event, index) => index > verificationFloorIndex && isVerification(event, config) && verificationPassed(event));
  if (hasSuccessfulVerificationAfterChange) return [];
  if (workspaceEvent?.payload.workspaceChanged === true) {
    const evidence = changes.length ? [changes.at(-1)!, workspaceEvent] : [workspaceEvent];
    return [finding("change-without-verification", "high", "high", evidence, "Git 工作区指纹确认 run 期间发生真实改动，但改动后没有成功验证命令", "运行任务声明的测试、构建、类型检查或 lint 命令")];
  }
  if (!changes.length) return [];
  return [finding("change-without-verification", "medium", "low", changes, "检测到写入类工具成功，但缺少 Git 工作区指纹，无法确认最终是否存在真实改动", "确认 Git diff 后运行任务声明的测试、构建、类型检查或 lint 命令")];
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
