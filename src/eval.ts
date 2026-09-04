import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { analyzeRun } from "./analyzer.js";
import type { RunReport } from "./schema.js";
import type { ReviewEvent } from "./schema.js";
import { renderHtml, renderMarkdown } from "./render.js";
import { appendEvent, readEvents, writeReport } from "./storage.js";

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export interface EvalTask {
  id: string;
  prompt: string;
  fixture: string;
  validate: string[];
  tags?: string[];
  timeoutMs?: number;
}

export interface EvalConfig {
  id: string;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  thinking?: string;
}

export interface EvalResult {
  taskId: string;
  configId: string;
  status: "success" | "failed" | "timeout" | "error";
  durationMs: number;
  piExitCode: number | null;
  validations: Array<{ command: string; exitCode: number | null; passed: boolean; output: string }>;
  report?: RunReport;
  error?: string;
}

export function validateTask(value: unknown): EvalTask {
  if (!value || typeof value !== "object") throw new Error("任务必须是 JSON 对象");
  const task = value as Partial<EvalTask>;
  if (!task.id || !task.prompt || !task.fixture) throw new Error("任务缺少 id、prompt 或 fixture");
  if (!Array.isArray(task.validate) || task.validate.length === 0 || task.validate.some((item) => typeof item !== "string")) {
    throw new Error(`任务 ${task.id} 必须包含至少一个验证命令`);
  }
  return task as EvalTask;
}

export async function loadTasks(tasksDir: string): Promise<EvalTask[]> {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(tasksDir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => validateTask(JSON.parse(await readFile(join(tasksDir, file), "utf8")))));
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, shell = false): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, shell, windowsHide: true, env: childEnvironment() });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolveResult({ exitCode: null, output: `${output}\n${error.message}`.trim(), timedOut }); });
    child.on("close", (exitCode) => { clearTimeout(timer); resolveResult({ exitCode, output: output.slice(-4000), timedOut }); });
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.once("close", () => resolveKill());
      killer.once("error", () => resolveKill());
    });
    return;
  }
  child.kill();
}

function runPiProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let jsonBuffer = "";
    let timedOut = false;
    let settled = false;
    let finished = false;
    let checkingReport = false;
    let reportPoll: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (reportPoll) clearInterval(reportPoll);
      if (settleTimer) clearTimeout(settleTimer);
      resolveResult({ exitCode: settled ? 0 : exitCode, output: output.slice(-4000), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, timeoutMs);
    const consumeOutput = (chunk: unknown): void => {
      const text = String(chunk);
      output += text;
      jsonBuffer += text;
      const lines = jsonBuffer.split(/\r?\n/);
      jsonBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if ((JSON.parse(line) as { type?: string }).type === "agent_settled") {
            settled = true;
            settleTimer ??= setTimeout(() => { void terminateProcessTree(child); }, 1_500);
          }
        } catch {
          // Pi's JSON mode may interleave non-JSON diagnostics; ignore those lines.
        }
      }
    };
    child.stdout?.on("data", consumeOutput);
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => { output += `\n${error.message}`; finish(null); });
    child.on("close", (exitCode) => finish(exitCode));
    reportPoll = setInterval(() => {
      if (checkingReport || finished) return;
      checkingReport = true;
      void readdir(join(cwd, ".pi", "run-review", "reports"))
        .then((files) => {
          if (files.some((file) => file.endsWith(".json"))) {
            settled = true;
            settleTimer ??= setTimeout(() => { void terminateProcessTree(child); }, 1_500);
          }
        })
        .catch(() => undefined)
        .finally(() => { checkingReport = false; });
    }, 250);
  });
}

export function piCliPath(rootDir: string): string {
  return resolve(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
}

async function latestReportPath(workspace: string, storageDir = ".pi/run-review"): Promise<string | undefined> {
  const reportsDir = join(workspace, storageDir, "reports");
  try {
    const candidates = await Promise.all((await readdir(reportsDir)).filter((file) => file.endsWith(".json")).map(async (file) => ({ file, mtime: (await stat(join(reportsDir, file))).mtimeMs })));
    const latest = candidates.sort((a, b) => b.mtime - a.mtime)[0];
    return latest ? join(reportsDir, latest.file) : undefined;
  } catch {
    return undefined;
  }
}

async function readLatestReport(workspace: string, storageDir = ".pi/run-review"): Promise<RunReport | undefined> {
  const path = await latestReportPath(workspace, storageDir);
  return path ? JSON.parse(await readFile(path, "utf8")) as RunReport : undefined;
}

export async function reconcileEvalReport(workspace: string, validations: EvalResult["validations"], storageDir = ".pi/run-review"): Promise<RunReport | undefined> {
  if (!validations.length) return readLatestReport(workspace, storageDir);
  const reportPath = await latestReportPath(workspace, storageDir);
  if (!reportPath) return undefined;
  const report = JSON.parse(await readFile(reportPath, "utf8")) as RunReport;
  const eventsPath = join(dirname(dirname(reportPath)), "events.jsonl");
  const events = await readEvents(eventsPath);
  const verificationEvents: ReviewEvent[] = validations.map((validation, index) => ({
    schemaVersion: 1,
    eventId: `evt_eval_verification_${index}_${randomUUID()}`,
    runId: report.run.runId,
    sessionId: report.run.sessionId,
    timestamp: new Date().toISOString(),
    type: "verification",
    payload: {
      command: validation.command,
      exitCode: validation.exitCode ?? undefined,
      passed: validation.passed,
      source: "declared",
    },
  }));
  for (const event of verificationEvents) await appendEvent(eventsPath, event);
  const reconciled = analyzeRun([...events, ...verificationEvents], report.run);
  await writeReport(reportPath, reconciled);
  const reportDir = dirname(reportPath);
  await writeFile(join(reportDir, `${reconciled.run.runId}.md`), renderMarkdown(reconciled), "utf8");
  await writeFile(join(reportDir, `${reconciled.run.runId}.html`), renderHtml(reconciled), "utf8");
  return reconciled;
}

export async function runEvalTask(task: EvalTask, config: EvalConfig, options: { rootDir: string; extensionPath: string; piCliPath?: string; keepWorkspace?: boolean }): Promise<EvalResult> {
  const startedAt = Date.now();
  const workspace = await mkdtemp(join(tmpdir(), `pi-run-review-${task.id}-`));
  try {
    const fixtureDir = resolve(options.rootDir, task.fixture);
    for (const entry of await readdir(fixtureDir)) {
      await cp(join(fixtureDir, entry), join(workspace, entry), { recursive: true });
    }
    // Materialize a deterministic local baseline so every task starts from a Git commit.
    await runProcess("git", ["init"], workspace, 30_000);
    await runProcess("git", ["config", "user.email", "pi-run-review@example.invalid"], workspace, 30_000);
    await runProcess("git", ["config", "user.name", "pi-run-review"], workspace, 30_000);
    await runProcess("git", ["add", "."], workspace, 30_000);
    await runProcess("git", ["commit", "-m", "fixture baseline"], workspace, 30_000);
    const args = [
      "-p", "--approve", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--tools", "read,edit,write,grep,find,ls", "--mode", "json", "-e", resolve(options.extensionPath),
    ];
    if (config.provider) args.push("--provider", config.provider);
    if (config.model) args.push("--model", config.model);
    if (config.thinking) args.push("--thinking", config.thinking);
    if (config.systemPrompt) args.push("--system-prompt", config.systemPrompt);
    args.push(`${task.prompt}\n\n评测器会在 Agent 结束后自动执行验证命令；请不要尝试运行命令，只完成文件修改并在完成后结束。`);
    const piResult = await runPiProcess(process.execPath, [options.piCliPath ?? piCliPath(options.rootDir), ...args], workspace, task.timeoutMs ?? 300_000);
    const validations: EvalResult["validations"] = [];
    if (!piResult.timedOut) {
      for (const command of task.validate) {
        const validation = await runProcess(command, [], workspace, task.timeoutMs ?? 300_000, true);
        validations.push({ command, exitCode: validation.exitCode, passed: validation.exitCode === 0, output: validation.output });
      }
    }
    const diff = await runProcess("git", ["status", "--porcelain"], workspace, 30_000);
    const changed = diff.output.split(/\r?\n/).some((line) => line.trim() && !/^\?\? \.pi[\\/]/.test(line));
    const status = piResult.timedOut
      ? "timeout"
      : piResult.exitCode !== 0
        ? "error"
        : validations.every((item) => item.passed) && changed
          ? "success"
          : "failed";
    return {
      taskId: task.id,
      configId: config.id,
      status,
      durationMs: Date.now() - startedAt,
      piExitCode: piResult.exitCode,
      validations,
      report: await reconcileEvalReport(workspace, validations),
      error: status === "error" || status === "timeout" ? (piResult.output || (status === "timeout" ? "Pi process timed out" : undefined)) : !changed ? "Agent 未产生工作区改动" : undefined,
    };
  } finally {
    if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

export async function writeEvalSummary(path: string, results: EvalResult[]): Promise<void> {
  const configs = [...new Set(results.map((item) => item.configId))];
  const byConfig = Object.fromEntries(configs.map((configId) => {
    const selected = results.filter((item) => item.configId === configId);
    const sortedDurations = selected.map((item) => item.durationMs).sort((a, b) => a - b);
    const reports = selected.map((item) => item.report).filter((report): report is RunReport => Boolean(report));
    const findingCounts = reports.flatMap((report) => report.findings).reduce<Record<string, number>>((counts, finding) => ({ ...counts, [finding.ruleId]: (counts[finding.ruleId] ?? 0) + 1 }), {});
    return [configId, {
      runs: selected.length,
      successRate: selected.filter((item) => item.status === "success").length / selected.length,
      failedRate: selected.filter((item) => item.status === "failed" || item.status === "error").length / selected.length,
      timeoutRate: selected.filter((item) => item.status === "timeout").length / selected.length,
      unknownRate: reports.length ? reports.filter((report) => report.outcome.status === "unknown").length / reports.length : null,
      findingRates: Object.fromEntries(Object.entries(findingCounts).map(([ruleId, count]) => [ruleId, count / selected.length])),
      averageDurationMs: Math.round(selected.reduce((sum, item) => sum + item.durationMs, 0) / selected.length),
      p95DurationMs: sortedDurations[Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)],
      averageTurns: reports.length ? reports.reduce((sum, report) => sum + report.run.turnCount, 0) / reports.length : null,
      averageTools: reports.length ? reports.reduce((sum, report) => sum + report.run.toolCount, 0) / reports.length : null,
    }];
  }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), byConfig, results }, null, 2)}\n`, "utf8");
}
