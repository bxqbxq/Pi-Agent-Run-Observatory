import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, readlink, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyzeRun } from "../src/analyzer.js";
import { parseRunReviewConfig, type RunReviewConfig as Config } from "../src/config.js";
import { compareEvalConfigs, findLatestEvalSummary, readEvalSummary } from "../src/diff.js";
import { redactText, redactValue, summarizeMessageContent, summarizeValue } from "../src/redaction.js";
import { appendEvent, readEvents, readReport, writeReport } from "../src/storage.js";
import { renderHtml, renderMarkdown } from "../src/render.js";
import type { ReviewEvent, RunSummary } from "../src/schema.js";

const execFileAsync = promisify(execFile);

interface ActiveRun {
  cwd: string;
  summary: RunSummary;
  config: Config;
  eventsPath: string;
  reportDir: string;
  toolStarts: Map<string, number>;
  toolArgs: Map<string, unknown>;
  providerRequestStarts: number[];
  eventWriteQueue: Promise<void>;
  eventCount: number;
  maxEvents: number;
  eventWriteWarningShown: boolean;
  eventLimitWarningShown: boolean;
  workspaceBaseline?: Map<string, string>;
  workspaceExcludedDir: string;
};

interface LoadedConfig {
  config: Config;
  warning?: string;
}

function now(): string {
  return new Date().toISOString();
}

function textSummary(value: unknown, config: Config, cwd: string): string {
  const maxChars = config.captureFullContent ? undefined : config.summaryMaxChars ?? 1000;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(redactValue(value, { cwd })) ?? String(value ?? "");
    } catch {
      text = String(value ?? "");
    }
  }
  return redactText(text, { cwd, maxChars });
}

function messageContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(messageContentText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const item = value as { text?: unknown };
    if (typeof item.text === "string") return item.text;
  }
  return "";
}

function modelName(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const item = model as { provider?: string; id?: string; name?: string };
  if (item.provider && item.id) return `${item.provider}/${item.id}`;
  return item.name ?? item.id;
}

function capturedValue(value: unknown, config: Config, cwd: string): unknown {
  return config.captureFullContent
    ? redactValue(value, { cwd })
    : summarizeValue(value, { cwd });
}

function explanationText(report: ReturnType<typeof analyzeRun>, text: string): string {
  const evidence = [...new Set(report.findings.flatMap((finding) => finding.evidence))];
  const recommendations = [...new Set(report.findings.map((finding) => finding.recommendation))];
  return [
    "根因解释：",
    text || "模型未返回根因解释。",
    "",
    `证据引用：${evidence.length ? evidence.join(", ") : "无可引用的 finding 证据"}`,
    "",
    "可执行建议：",
    ...(recommendations.length ? recommendations.map((item) => `- ${item}`) : ["- 当前没有规则建议，请结合脱敏事件人工检查。"]),
    "",
    "不确定性说明：以上解释仅基于插件采集到的脱敏事件和确定性规则，可能缺少未被观测的上下文。",
  ].join("\n");
}

function evidenceEvents(report: ReturnType<typeof analyzeRun>, events: ReviewEvent[]): ReviewEvent[] {
  const evidenceIds = new Set(report.findings.flatMap((finding) => finding.evidence));
  return events.filter((event) => event.runId === report.run.runId && evidenceIds.has(event.eventId));
}

function verificationHint(toolName: string, value: unknown, commands: string[] | undefined): string | undefined {
  if (!/^(?:bash|powershell|shell|exec|command)$/i.test(toolName)) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value).toLowerCase();
  } catch {
    text = String(value).toLowerCase();
  }
  const index = (commands ?? ["test", "build", "typecheck", "lint"]).findIndex((command) => text.includes(command.toLowerCase()));
  return index >= 0 ? `verification:${index}` : undefined;
}

async function gitCommit(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function projectIdentifier(projectRoot: string): string {
  const normalizedPath = resolve(projectRoot).replaceAll("\\", "/").replace(/\/$/, "");
  const normalized = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

function numericUsageMetrics(value: unknown, prefix = "", output: Record<string, number> = {}): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof item === "number" && Number.isFinite(item)) output[name] = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) numericUsageMetrics(item, name, output);
  }
  return output;
}

function providerUsageSummary(value: unknown, cwd: string): unknown {
  const summary = summarizeValue(value, { cwd });
  const metrics = numericUsageMetrics(value);
  return { ...summary, ...(Object.keys(metrics).length ? { metrics } : {}) };
}

function pathWithin(path: string, directory: string): boolean {
  const normalizedPath = process.platform === "win32" ? path.toLowerCase() : path;
  const normalizedDirectory = process.platform === "win32" ? directory.toLowerCase() : directory;
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}${sep}`);
}

async function fileFingerprint(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    const hash = createHash("sha256").update(`${info.mode}:`);
    if (info.isSymbolicLink()) return hash.update(`symlink:${await readlink(path)}`).digest("hex");
    if (!info.isFile()) return hash.update("non-file").digest("hex");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function workspaceSnapshot(cwd: string, excludedDir: string): Promise<Map<string, string> | undefined> {
  try {
    const trackedPromise = execFileAsync("git", ["diff", "--name-only", "-z", "HEAD", "--"], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const untrackedPromise = execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const [tracked, untracked] = await Promise.all([trackedPromise, untrackedPromise]);
    const paths = new Set(`${tracked.stdout}${untracked.stdout}`.split("\0").filter(Boolean));
    const snapshot = new Map<string, string>();
    for (const relativePath of paths) {
      const absolutePath = resolve(cwd, relativePath);
      if (!pathWithin(absolutePath, resolve(cwd)) || pathWithin(absolutePath, excludedDir)) continue;
      snapshot.set(relativePath, await fileFingerprint(absolutePath));
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function workspaceChanged(before: Map<string, string> | undefined, after: Map<string, string> | undefined): boolean | undefined {
  if (!before || !after) return undefined;
  if (before.size !== after.size) return true;
  for (const [path, fingerprint] of before) {
    if (after.get(path) !== fingerprint) return true;
  }
  return false;
}

async function loadConfig(cwd: string): Promise<LoadedConfig> {
  try {
    const raw = await readFile(join(cwd, ".pi", "run-review", "config.json"), "utf8");
    return { config: parseRunReviewConfig(JSON.parse(raw)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
    const warning = `pi-run-review 配置无效，已使用安全默认值：${String(error)}`;
    console.error(warning);
    return { config: {}, warning };
  }
}

async function latestReportPath(cwd: string, storageDir?: string): Promise<string | undefined> {
  const dir = join(cwd, storageDir ?? ".pi/run-review", "reports");
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    const candidates = await Promise.all(files.map(async (file) => ({ path: join(dir, file), mtime: (await stat(join(dir, file))).mtimeMs })));
    return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.path;
  } catch { return undefined; }
}

export default function runReviewExtension(pi: ExtensionAPI): void {
  let active: ActiveRun | undefined;
  let lastReportPath: string | undefined;
  let lastMarkdown = "";
  let config: Config = {};
  const pendingWarnings: string[] = [];
  const flushPendingWarnings = (ctx: ExtensionContext): void => {
    for (const warning of pendingWarnings.splice(0)) ctx.ui.notify(warning, "warning");
  };
  const notifyBackgroundWarning = (ctx: ExtensionContext, warning: string): void => {
    console.error(warning);
    try {
      ctx.ui.notify(warning, "warning");
    } catch {
      pendingWarnings.push(warning);
    }
  };
  const appendToRun = (run: ActiveRun, event: ReviewEvent, force = false, notifyWarning?: (message: string) => void): Promise<void> => {
    if (!force && run.eventCount >= run.maxEvents) {
      if (!run.eventLimitWarningShown) {
        run.eventLimitWarningShown = true;
        notifyWarning?.(`pi-run-review 已达到单次运行 ${run.maxEvents} 条事件上限，后续事件将被省略。`);
      }
      return run.eventWriteQueue;
    }
    run.eventCount += 1;
    run.eventWriteQueue = run.eventWriteQueue
      .then(() => appendEvent(run.eventsPath, event))
      .catch((error) => {
        console.error("pi-run-review: event write failed", error);
        if (!run.eventWriteWarningShown) {
          run.eventWriteWarningShown = true;
          notifyWarning?.(`pi-run-review 事件写入失败，诊断记录可能不完整：${String(error)}`);
        }
      });
    return run.eventWriteQueue;
  };

  const append = (event: ReviewEvent, notifyWarning?: (message: string) => void): Promise<void> => {
    return active ? appendToRun(active, event, false, notifyWarning) : Promise.resolve();
  };

  const makeEvent = (type: ReviewEvent["type"], payload: Record<string, unknown>, extra: Partial<ReviewEvent> = {}): ReviewEvent => ({
    schemaVersion: 1,
    eventId: `evt_${randomUUID()}`,
    runId: active?.summary.runId ?? "unknown",
    sessionId: active?.summary.sessionId,
    timestamp: now(),
    type,
    payload,
    ...extra,
  });

  pi.on("session_start", async (_event, ctx) => {
    flushPendingWarnings(ctx);
    const loaded = await loadConfig(ctx.cwd);
    config = loaded.config;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    lastReportPath = await latestReportPath(ctx.cwd, config.storageDir);
  });

  pi.on("agent_start", async (_event, ctx) => {
    flushPendingWarnings(ctx);
    if (active) return;
    const baseDir = config.storageDir ? join(ctx.cwd, config.storageDir) : join(ctx.cwd, ".pi", "run-review");
    const runId = `run_${randomUUID()}`;
    const startedAt = now();
    const [commit, root, baseline] = await Promise.all([gitCommit(ctx.cwd), gitRoot(ctx.cwd), workspaceSnapshot(ctx.cwd, resolve(baseDir))]);
    const projectId = projectIdentifier(root ?? ctx.cwd);
    active = {
      cwd: ctx.cwd,
      summary: {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        model: modelName(ctx.model),
        gitCommit: commit,
        projectId,
        startedAt,
        turnCount: 0,
        toolCount: 0,
        captureMode: config.captureFullContent ? "full" : "redacted",
      },
      config: { ...config, verificationCommands: config.verificationCommands ? [...config.verificationCommands] : undefined },
      eventsPath: join(baseDir, "events.jsonl"),
      reportDir: join(baseDir, "reports"),
      toolStarts: new Map(),
      toolArgs: new Map(),
      providerRequestStarts: [],
      eventWriteQueue: Promise.resolve(),
      eventCount: 0,
      maxEvents: config.maxEventsPerRun ?? 10_000,
      eventWriteWarningShown: false,
      eventLimitWarningShown: false,
      workspaceBaseline: baseline,
      workspaceExcludedDir: resolve(baseDir),
    };
    await append(makeEvent("run_started", { model: active.summary.model, gitCommit: active.summary.gitCommit, projectId: active.summary.projectId, captureMode: active.summary.captureMode }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!active) return;
    active.summary.turnCount = Math.max(active.summary.turnCount, event.turnIndex + 1);
    await append(makeEvent("turn_started", { turnIndex: event.turnIndex }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("turn_end", async (event, ctx) => {
    await append(makeEvent("turn_ended", { turnIndex: event.turnIndex, toolResultCount: event.toolResults.length }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("agent_end", async (event, ctx) => {
    await append(makeEvent("agent_ended", { messageCount: event.messages.length }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("tool_call", async (event, ctx) => {
    await append(makeEvent("tool_call", { toolName: event.toolName, input: capturedValue(event.input, config, ctx.cwd), verificationKey: verificationHint(event.toolName, event.input, config.verificationCommands) }, { toolCallId: event.toolCallId }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("tool_result", async (event, ctx) => {
    await append(makeEvent("tool_result", { toolName: event.toolName, isError: event.isError, content: textSummary(event.content, config, ctx.cwd), usage: redactValue(event.usage, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }) }, { toolCallId: event.toolCallId }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!active) return;
    active.summary.toolCount += 1;
    active.toolStarts.set(event.toolCallId, Date.now());
    active.toolArgs.set(event.toolCallId, event.args);
    await append(makeEvent("tool_started", {
      toolName: event.toolName,
      ...(config.captureFullContent ? { args: capturedValue(event.args, config, ctx.cwd) } : { argsSummary: capturedValue(event.args, config, ctx.cwd) }),
      verificationKey: verificationHint(event.toolName, event.args, config.verificationCommands),
    }, { toolCallId: event.toolCallId }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    await append(makeEvent("tool_updated", {
      toolName: event.toolName,
      summary: textSummary(event.partialResult, config, ctx.cwd),
    }, { toolCallId: event.toolCallId }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const started = active?.toolStarts.get(event.toolCallId);
    const args = active?.toolArgs.get(event.toolCallId);
    active?.toolStarts.delete(event.toolCallId);
    active?.toolArgs.delete(event.toolCallId);
    const result = event.result as { exitCode?: number; code?: number; details?: { exitCode?: number; code?: number } } | undefined;
    await append(makeEvent("tool_finished", {
      toolName: event.toolName,
      ...(config.captureFullContent ? { args: capturedValue(args, config, ctx.cwd) } : { argsSummary: capturedValue(args, config, ctx.cwd) }),
      verificationKey: verificationHint(event.toolName, args, config.verificationCommands),
      isError: event.isError,
      exitCode: result?.exitCode ?? result?.code ?? result?.details?.exitCode ?? result?.details?.code,
      durationMs: started ? Date.now() - started : undefined,
      resultSummary: textSummary(event.result, config, ctx.cwd),
    }, { toolCallId: event.toolCallId }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as { role?: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string };
    const content = messageContentText(message.content);
    const payload: Record<string, unknown> = {
      role: message.role,
      contentSummary: summarizeMessageContent(content),
      ...(config.captureFullContent ? { content: textSummary(content, config, ctx.cwd) } : {}),
      stopReason: message.stopReason,
      usage: redactValue(message.usage, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }),
      errorMessage: message.errorMessage ? textSummary(message.errorMessage, config, ctx.cwd) : undefined,
    };
    await append(makeEvent("message", payload), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("model_select", async (event, ctx) => {
    await append(makeEvent("model_selected", { model: modelName(event.model), source: event.source }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("before_provider_request", async (event, ctx) => {
    active?.providerRequestStarts.push(Date.now());
    await append(makeEvent("provider_request", config.captureFullContent
      ? { payload: capturedValue(event.payload, config, ctx.cwd) }
      : { payloadSummary: capturedValue(event.payload, config, ctx.cwd) }), (message) => ctx.ui.notify(message, "warning"));
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const response = event as typeof event & { durationMs?: unknown; usage?: unknown };
    const started = active?.providerRequestStarts.shift();
    const durationMs = typeof response.durationMs === "number" && Number.isFinite(response.durationMs) && response.durationMs >= 0
      ? response.durationMs
      : started === undefined ? undefined : Date.now() - started;
    const payload: Record<string, unknown> = {
      status: event.status,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(response.usage === undefined ? {} : { usageSummary: providerUsageSummary(response.usage, ctx.cwd) }),
      ...(config.captureFullContent ? { headers: capturedValue(event.headers, config, ctx.cwd) } : { headerSummary: capturedValue(event.headers, config, ctx.cwd) }),
    };
    await append(makeEvent("provider_response", {
      ...payload,
    }), (message) => ctx.ui.notify(message, "warning"));
  });

  const writeRunReports = async (finished: ActiveRun, report: ReturnType<typeof analyzeRun>, jsonPath: string, ctx: ExtensionContext): Promise<void> => {
    try {
      await mkdir(finished.reportDir, { recursive: true });
      await writeReport(jsonPath, report);
      await writeFile(join(finished.reportDir, `${finished.summary.runId}.md`), renderMarkdown(report), "utf8");
      await writeFile(join(finished.reportDir, `${finished.summary.runId}.html`), renderHtml(report), "utf8");
      lastReportPath = jsonPath;
      lastMarkdown = renderMarkdown(report);
    } catch (error) {
      const warning = `pi-run-review 生成报告失败：${String(error)}`;
      notifyBackgroundWarning(ctx, warning);
    }
  };

  const finalizeRun = async (finished: ActiveRun, finalSnapshot: Promise<Map<string, string> | undefined>, ctx: ExtensionContext): Promise<void> => {
    try {
      const changed = workspaceChanged(finished.workspaceBaseline, await finalSnapshot);
      const runEnded = makeEvent("run_ended", {
        durationMs: finished.summary.durationMs,
        ...(changed === undefined ? {} : { workspaceChanged: changed, workspaceEvidence: "git-diff-snapshot" }),
      }, { runId: finished.summary.runId, sessionId: finished.summary.sessionId });
      await appendToRun(finished, runEnded, true, (message) => ctx.ui.notify(message, "warning"));
      const invalidEventLines: number[] = [];
      const events = await readEvents(finished.eventsPath, { onInvalidLine: (issue) => invalidEventLines.push(issue.lineNumber) });
      if (invalidEventLines.length) {
        ctx.ui.notify(`pi-run-review 跳过了 ${invalidEventLines.length} 条损坏或不兼容事件（行 ${invalidEventLines.join(", ")}）。`, "warning");
      }
      const report = analyzeRun(events.filter((event) => event.runId === finished.summary.runId), finished.summary, {
        duplicateWindow: finished.config.duplicateWindow,
        duplicateThreshold: finished.config.duplicateThreshold,
        recoveryWindow: finished.config.recoveryWindow,
        verificationCommands: finished.config.verificationCommands,
      });
      const jsonPath = join(finished.reportDir, `${finished.summary.runId}.json`);
      if (finished.config.autoSummary !== false) {
        const primaryIssue = report.findings[0]?.ruleId ?? "无";
        ctx.ui.notify(`${report.outcome.status}：${report.findings.length} 个问题；主要问题：${primaryIssue}；报告生成已排队：${jsonPath}`, report.outcome.status === "failed" ? "warning" : "info");
      }
      await writeRunReports(finished, report, jsonPath, ctx);
    } catch (error) {
      notifyBackgroundWarning(ctx, `pi-run-review 完成运行诊断失败：${String(error)}`);
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active) return;
    const finished = active;
    finished.summary.settledAt = now();
    finished.summary.durationMs = new Date(finished.summary.settledAt).getTime() - new Date(finished.summary.startedAt).getTime();
    const finalSnapshot = workspaceSnapshot(finished.cwd, finished.workspaceExcludedDir);
    active = undefined;
    await finalizeRun(finished, finalSnapshot, ctx);
  });

  pi.registerCommand("run-review", {
    description: "Review the latest settled pi Agent run",
    handler: async (args, ctx) => {
      flushPendingWarnings(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const requestedRun = tokens.indexOf("--run") >= 0 ? tokens[tokens.indexOf("--run") + 1] : undefined;
      const formatIndex = tokens.indexOf("--format");
      const format = formatIndex >= 0 ? tokens[formatIndex + 1] : "markdown";
      const full = tokens.includes("--full");
      const reportPath = requestedRun && lastReportPath ? join(dirname(lastReportPath), `${requestedRun}.json`) : lastReportPath;
      if (!reportPath) {
        ctx.ui.notify("当前还没有可评审的 settled run。", "warning");
        return;
      }
      if (tokens.includes("--explain")) {
        try {
          const report = await readReport(reportPath);
          const model = ctx.model;
          if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
            ctx.ui.notify("当前模型不可用于 explain，已跳过 LLM 调用。", "warning");
          } else {
            const eventsPath = join(dirname(dirname(reportPath)), "events.jsonl");
            const events = await readEvents(eventsPath);
            const evidence = { run: report.run, outcome: report.outcome, findings: report.findings, events: events.filter((event) => report.findings.some((item) => item.evidence.includes(event.eventId))).map((event) => ({ eventId: event.eventId, type: event.type, toolCallId: event.toolCallId, payload: event.payload })) };
            const response = await ctx.modelRegistry.complete(model, {
              messages: [{ role: "user", content: [{ type: "text", text: `请根据以下脱敏后的 Agent 运行诊断证据，解释最可能的根因，逐项引用相关 eventId，给出可执行建议和不确定性说明。不要引入证据中不存在的事实。\n\n${JSON.stringify(evidence)}` }], timestamp: Date.now() }],
            }, { cacheRetention: "none", sessionId: randomUUID() });
            const text = response.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n").trim();
            report.explanation = { generatedAt: now(), model: modelName(model), text: explanationText(report, text) };
            await appendEvent(eventsPath, { schemaVersion: 1, eventId: `evt_${randomUUID()}`, runId: report.run.runId, sessionId: report.run.sessionId, timestamp: now(), type: "analysis", payload: { kind: "llm_explain", model: modelName(model) } });
            await writeReport(reportPath, report);
            const reportDir = dirname(reportPath);
            const markdown = renderMarkdown(report);
            await writeFile(join(reportDir, `${report.run.runId}.md`), markdown, "utf8");
            await writeFile(join(reportDir, `${report.run.runId}.html`), renderHtml(report), "utf8");
            lastMarkdown = markdown;
          }
        } catch (error) {
          ctx.ui.notify(`LLM explain 失败：${String(error)}`, "warning");
        }
      }
      try {
        const report = await readReport(reportPath);
        let fullEvidence: ReviewEvent[] = [];
        if (full && report.run.captureMode !== "full") {
          ctx.ui.notify("当前报告使用 redacted 采集模式；只有预先启用 captureFullContent 后，--full 才会显示证据详情。", "warning");
        } else if (full) {
          const eventsPath = join(dirname(dirname(reportPath)), "events.jsonl");
          fullEvidence = evidenceEvents(report, await readEvents(eventsPath));
        }
        const output = format === "json"
          ? JSON.stringify(fullEvidence.length ? { report, evidenceEvents: fullEvidence } : report, null, 2)
          : format === "html"
            ? renderHtml(report, fullEvidence)
            : renderMarkdown(report, fullEvidence);
        ctx.ui.notify(output, "info");
      } catch (error) {
        ctx.ui.notify(`读取 run-review 报告失败：${String(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("run-diff", {
    description: "Compare two runs or two evaluation config result sets",
    handler: async (args, ctx) => {
      flushPendingWarnings(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const operands: string[] = [];
      let summaryFile: string | undefined;
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] === "--file") {
          const path = tokens[index + 1];
          if (!path || path.startsWith("--")) {
            ctx.ui.notify("--file 后必须提供评测汇总 JSON 路径。", "warning");
            return;
          }
          summaryFile = path;
          index += 1;
        } else {
          operands.push(tokens[index] as string);
        }
      }
      const [baseline, candidate] = operands;
      if (!baseline || !candidate || operands.length !== 2) {
        ctx.ui.notify("用法：/run-diff <baselineRunId|configId> <candidateRunId|configId> [--file <评测汇总.json>]", "warning");
        return;
      }
      try {
        if (baseline.startsWith("run_") && candidate.startsWith("run_")) {
          const reportDir = lastReportPath ? dirname(lastReportPath) : join(ctx.cwd, config.storageDir ?? ".pi/run-review", "reports");
          const [left, right] = await Promise.all([
            readReport(join(reportDir, `${baseline}.json`)),
            readReport(join(reportDir, `${candidate}.json`)),
          ]);
          ctx.ui.notify(JSON.stringify({
            kind: "run",
            baseline,
            candidate,
            status: { baseline: left.outcome.status, candidate: right.outcome.status },
            findingCount: { baseline: left.findings.length, candidate: right.findings.length },
            verification: { baseline: left.outcome.verification, candidate: right.outcome.verification },
            durationMs: { baseline: left.run.durationMs ?? null, candidate: right.run.durationMs ?? null },
            turns: { baseline: left.run.turnCount, candidate: right.run.turnCount },
            tools: { baseline: left.run.toolCount, candidate: right.run.toolCount },
            tokens: { baseline: left.run.usage?.totalTokens ?? null, candidate: right.run.usage?.totalTokens ?? null },
            cost: { baseline: left.run.cost ?? null, candidate: right.run.cost ?? null },
          }, null, 2), "info");
          return;
        }

        const selected = summaryFile
          ? { path: resolve(ctx.cwd, summaryFile), summary: await readEvalSummary(resolve(ctx.cwd, summaryFile)) }
          : await findLatestEvalSummary(ctx.cwd, baseline, candidate);
        if (!selected) throw new Error(`eval/results 中没有同时包含 ${baseline} 和 ${candidate} 的有效评测汇总`);
        ctx.ui.notify(JSON.stringify(compareEvalConfigs(selected.summary, baseline, candidate, selected.path), null, 2), "info");
      } catch (error) {
        ctx.ui.notify(`读取 run-diff 报告失败：${String(error)}`, "warning");
      }
    },
  });
}
