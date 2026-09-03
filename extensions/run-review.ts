import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeRun } from "../src/analyzer.js";
import { redactText, redactValue } from "../src/redaction.js";
import { appendEvent, readEvents, writeReport } from "../src/storage.js";
import { renderHtml, renderMarkdown } from "../src/render.js";
import type { ReviewEvent, RunSummary } from "../src/schema.js";

const execFileAsync = promisify(execFile);

interface ActiveRun {
  summary: RunSummary;
  eventsPath: string;
  reportDir: string;
  toolStarts: Map<string, number>;
  toolArgs: Map<string, unknown>;
};

interface Config {
  storageDir?: string;
  captureFullContent?: boolean;
  summaryMaxChars?: number;
  duplicateWindow?: number;
  duplicateThreshold?: number;
  recoveryWindow?: number;
  verificationCommands?: string[];
  autoSummary?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function textSummary(value: unknown, config: Config, cwd: string): string {
  const maxChars = config.captureFullContent ? undefined : config.summaryMaxChars ?? 1000;
  return redactText(String(value ?? ""), { cwd, maxChars });
}

function modelName(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const item = model as { provider?: string; id?: string; name?: string };
  if (item.provider && item.id) return `${item.provider}/${item.id}`;
  return item.name ?? item.id;
}

async function gitCommit(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function loadConfig(cwd: string): Promise<Config> {
  try {
    const raw = await readFile(join(cwd, ".pi", "run-review", "config.json"), "utf8");
    return JSON.parse(raw) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`pi-run-review: config ignored: ${String(error)}`);
    return {};
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

  const append = async (event: ReviewEvent): Promise<void> => {
    if (!active) return;
    try {
      await appendEvent(active.eventsPath, event);
    } catch (error) {
      console.error("pi-run-review: event write failed", error);
    }
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
    config = await loadConfig(ctx.cwd);
    lastReportPath = await latestReportPath(ctx.cwd, config.storageDir);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (active) return;
    const baseDir = config.storageDir ? join(ctx.cwd, config.storageDir) : join(ctx.cwd, ".pi", "run-review");
    const runId = `run_${randomUUID()}`;
    const startedAt = now();
    active = {
      summary: {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        model: modelName(ctx.model),
        gitCommit: await gitCommit(ctx.cwd),
        startedAt,
        turnCount: 0,
        toolCount: 0,
      },
      eventsPath: join(baseDir, "events.jsonl"),
      reportDir: join(baseDir, "reports"),
      toolStarts: new Map(),
      toolArgs: new Map(),
    };
    await append(makeEvent("run_started", { model: active.summary.model, gitCommit: active.summary.gitCommit }));
  });

  pi.on("turn_start", async (event) => {
    if (!active) return;
    active.summary.turnCount = Math.max(active.summary.turnCount, event.turnIndex + 1);
    await append(makeEvent("turn_started", { turnIndex: event.turnIndex }));
  });

  pi.on("turn_end", async (event) => {
    await append(makeEvent("turn_ended", { turnIndex: event.turnIndex, toolResultCount: event.toolResults.length }));
  });

  pi.on("agent_end", async (event) => {
    await append(makeEvent("agent_ended", { messageCount: event.messages.length }));
  });

  pi.on("tool_call", async (event, ctx) => {
    await append(makeEvent("tool_call", { toolName: event.toolName, input: redactValue(event.input, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }) }, { toolCallId: event.toolCallId }));
  });

  pi.on("tool_result", async (event, ctx) => {
    await append(makeEvent("tool_result", { toolName: event.toolName, isError: event.isError, content: textSummary(event.content, config, ctx.cwd), usage: redactValue(event.usage, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }) }, { toolCallId: event.toolCallId }));
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!active) return;
    active.summary.toolCount += 1;
    active.toolStarts.set(event.toolCallId, Date.now());
    active.toolArgs.set(event.toolCallId, event.args);
    await append(makeEvent("tool_started", {
      toolName: event.toolName,
      args: redactValue(event.args, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }),
    }, { toolCallId: event.toolCallId }));
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    await append(makeEvent("tool_updated", {
      toolName: event.toolName,
      summary: textSummary(event.partialResult, config, ctx.cwd),
    }, { toolCallId: event.toolCallId }));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const started = active?.toolStarts.get(event.toolCallId);
    const args = active?.toolArgs.get(event.toolCallId);
    active?.toolStarts.delete(event.toolCallId);
    active?.toolArgs.delete(event.toolCallId);
    const result = event.result as { exitCode?: number; code?: number; details?: { exitCode?: number; code?: number } } | undefined;
    await append(makeEvent("tool_finished", {
      toolName: event.toolName,
      args: redactValue(args, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }),
      isError: event.isError,
      exitCode: result?.exitCode ?? result?.code ?? result?.details?.exitCode ?? result?.details?.code,
      durationMs: started ? Date.now() - started : undefined,
      resultSummary: textSummary(event.result, config, ctx.cwd),
    }, { toolCallId: event.toolCallId }));
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as { role?: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string };
    const payload: Record<string, unknown> = {
      role: message.role,
      summary: textSummary(message.content, config, ctx.cwd),
      stopReason: message.stopReason,
      usage: redactValue(message.usage, { cwd: ctx.cwd, maxChars: config.summaryMaxChars ?? 1000 }),
      errorMessage: message.errorMessage ? textSummary(message.errorMessage, config, ctx.cwd) : undefined,
    };
    await append(makeEvent("message", payload));
  });

  pi.on("model_select", async (event) => {
    await append(makeEvent("model_selected", { model: modelName(event.model), source: event.source }));
  });

  pi.on("before_provider_request", async (event) => {
    await append(makeEvent("provider_request", { payload: redactValue(event.payload, { maxChars: config.summaryMaxChars ?? 1000 }) }));
  });

  pi.on("after_provider_response", async (event) => {
    await append(makeEvent("provider_response", { status: event.status, headers: redactValue(event.headers, { maxChars: config.summaryMaxChars ?? 1000 }) }));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active) return;
    const finished = active;
    finished.summary.settledAt = now();
    finished.summary.durationMs = new Date(finished.summary.settledAt).getTime() - new Date(finished.summary.startedAt).getTime();
    await append(makeEvent("run_ended", { durationMs: finished.summary.durationMs }));
    try {
      const events = await readEvents(finished.eventsPath);
      const report = analyzeRun(events.filter((event) => event.runId === finished.summary.runId), finished.summary, {
        duplicateWindow: config.duplicateWindow,
        duplicateThreshold: config.duplicateThreshold,
        recoveryWindow: config.recoveryWindow,
        verificationCommands: config.verificationCommands,
      });
      await mkdir(finished.reportDir, { recursive: true });
      const jsonPath = join(finished.reportDir, `${finished.summary.runId}.json`);
      await writeReport(jsonPath, report);
      await writeFile(join(finished.reportDir, `${finished.summary.runId}.md`), renderMarkdown(report), "utf8");
      await writeFile(join(finished.reportDir, `${finished.summary.runId}.html`), renderHtml(report), "utf8");
      lastReportPath = jsonPath;
      lastMarkdown = renderMarkdown(report);
      if (config.autoSummary !== false) {
        ctx.ui.notify(`${report.outcome.status}：${report.findings.length} 个问题，报告已写入 ${jsonPath}`, report.outcome.status === "failed" ? "warning" : "info");
      }
    } catch (error) {
      ctx.ui.notify(`pi-run-review 生成报告失败：${String(error)}`, "warning");
    } finally {
      active = undefined;
    }
  });

  pi.registerCommand("run-review", {
    description: "Review the latest settled pi Agent run",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const requestedRun = tokens.indexOf("--run") >= 0 ? tokens[tokens.indexOf("--run") + 1] : undefined;
      const formatIndex = tokens.indexOf("--format");
      const format = formatIndex >= 0 ? tokens[formatIndex + 1] : "markdown";
      const reportPath = requestedRun && lastReportPath ? join(dirname(lastReportPath), `${requestedRun}.json`) : lastReportPath;
      if (!reportPath) {
        ctx.ui.notify("当前还没有可评审的 settled run。", "warning");
        return;
      }
      if (tokens.includes("--explain")) {
        try {
          const raw = await readFile(reportPath, "utf8");
          const report = JSON.parse(raw) as import("../src/schema.js").RunReport;
          const model = ctx.model;
          if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
            ctx.ui.notify("当前模型不可用于 explain，已跳过 LLM 调用。", "warning");
          } else {
            const eventsPath = join(dirname(dirname(reportPath)), "events.jsonl");
            const events = await readEvents(eventsPath);
            const evidence = { run: report.run, outcome: report.outcome, findings: report.findings, events: events.filter((event) => report.findings.some((item) => item.evidence.includes(event.eventId))).map((event) => ({ eventId: event.eventId, type: event.type, toolCallId: event.toolCallId, payload: event.payload })) };
            const response = await ctx.modelRegistry.complete(model, {
              messages: [{ role: "user", content: [{ type: "text", text: `请根据以下脱敏后的 Agent 运行诊断证据，解释最可能的根因并给出修复建议。不要引入证据中不存在的事实。\n\n${JSON.stringify(evidence)}` }], timestamp: Date.now() }],
            }, { cacheRetention: "none", sessionId: randomUUID() });
            const text = response.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n").trim();
            report.explanation = { generatedAt: now(), model: modelName(model), text };
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
      const raw = await readFile(reportPath, "utf8");
      const report = JSON.parse(raw) as import("../src/schema.js").RunReport;
      const output = format === "json" ? raw : format === "html" ? renderHtml(report) : renderMarkdown(report);
      ctx.ui.notify(output, "info");
    },
  });

  pi.registerCommand("run-diff", {
    description: "Compare two persisted run-review reports",
    handler: async (args, ctx) => {
      const [baseline, candidate] = args.trim().split(/\s+/);
      if (!baseline || !candidate) {
        ctx.ui.notify("用法：/run-diff <baselineRunId> <candidateRunId>", "warning");
        return;
      }
      const reportDir = lastReportPath ? dirname(lastReportPath) : join(ctx.cwd, config.storageDir ?? ".pi/run-review", "reports");
      try {
        const [left, right] = await Promise.all([
          readFile(join(reportDir, `${baseline}.json`), "utf8").then((value) => JSON.parse(value) as import("../src/schema.js").RunReport),
          readFile(join(reportDir, `${candidate}.json`), "utf8").then((value) => JSON.parse(value) as import("../src/schema.js").RunReport),
        ]);
        const result = {
          baseline,
          candidate,
          status: { baseline: left.outcome.status, candidate: right.outcome.status },
          findingCount: { baseline: left.findings.length, candidate: right.findings.length },
          verification: { baseline: left.outcome.verification, candidate: right.outcome.verification },
          durationMs: { baseline: left.run.durationMs ?? null, candidate: right.run.durationMs ?? null },
        };
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(`读取 run-diff 报告失败：${String(error)}`, "warning");
      }
    },
  });
}
