import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { analyzeRun } from "./analyzer.js";
import { experimentFingerprint } from "./experiment.js";
import type { RunReport } from "./schema.js";
import type { ReviewEvent } from "./schema.js";
import { renderHtml, renderMarkdown } from "./render.js";
import { redactText, redactValue } from "./redaction.js";
import { appendEvent, readEvents, readReport, writeReport } from "./storage.js";

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
  expected?: EvalExpected;
  agentTools?: string[];
  agentRunsValidation?: boolean;
  acceptance?: EvalAcceptanceConfig;
}

export type EvalStatus = "success" | "failed" | "timeout" | "error";

export interface EvalExpected {
  status?: EvalStatus;
  findings?: string[];
  verification?: "passed" | "failed" | "missing" | "unknown";
  changed?: boolean;
}

export interface EvalAcceptanceConfig {
  fixture?: string;
  commands?: string[];
  requiredChanges?: string[];
  forbiddenChanges?: string[];
}

export interface EvalAcceptanceResult {
  passed: boolean;
  failures: string[];
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
  sampleIndex?: number;
  status: EvalStatus;
  durationMs: number;
  piExitCode: number | null;
  validations: Array<{ command: string; exitCode: number | null; passed: boolean; output: string }>;
  report?: RunReport;
  error?: string;
  changed?: boolean;
  changedFiles?: string[];
  acceptance?: EvalAcceptanceResult;
  expectationPassed?: boolean;
  failureArtifactDir?: string;
  failureArtifactError?: string;
}

export function parseRepeatCount(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("--repeats 必须是 1 到 100 之间的整数");
  }
  return parsed;
}

export function selectEvalTasks(tasks: EvalTask[], taskId: string | undefined): EvalTask[] {
  if (!taskId) return tasks;
  const selected = tasks.filter((task) => task.id === taskId);
  if (selected.length === 0) throw new Error(`任务目录中不存在任务：${taskId}`);
  return selected;
}

export interface EvalConfigSummary {
  runs: number;
  successRate: number;
  failedRate: number;
  timeoutRate: number;
  unknownRate: number | null;
  expectedRuns: number;
  expectationPassRate: number | null;
  acceptanceRuns: number;
  acceptancePassRate: number | null;
  findingRates: Record<string, number>;
  averageDurationMs: number;
  p95DurationMs: number;
  averageTurns: number | null;
  averageTools: number | null;
  usageRuns: number | null;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  averageTotalTokens: number | null;
  costRuns: number | null;
  averageCost: number | null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function usageMetric(report: RunReport, key: "input" | "output" | "totalTokens"): number | undefined {
  const value = report.run.usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function validateTask(value: unknown): EvalTask {
  if (!value || typeof value !== "object") throw new Error("任务必须是 JSON 对象");
  const task = value as Partial<EvalTask>;
  if (!task.id || !task.prompt || !task.fixture) throw new Error("任务缺少 id、prompt 或 fixture");
  if (!Array.isArray(task.validate) || task.validate.length === 0 || task.validate.some((item) => typeof item !== "string")) {
    throw new Error(`任务 ${task.id} 必须包含至少一个验证命令`);
  }
  if (task.expected !== undefined) {
    if (!task.expected || typeof task.expected !== "object") throw new Error(`任务 ${task.id} 的 expected 必须是对象`);
    const expected = task.expected as Partial<EvalExpected>;
    if (expected.status !== undefined && !["success", "failed", "timeout", "error"].includes(expected.status)) {
      throw new Error(`任务 ${task.id} 的 expected.status 无效`);
    }
    if (expected.findings !== undefined && (!Array.isArray(expected.findings) || expected.findings.some((item) => typeof item !== "string"))) {
      throw new Error(`任务 ${task.id} 的 expected.findings 必须是字符串数组`);
    }
    if (expected.verification !== undefined && !["passed", "failed", "missing", "unknown"].includes(expected.verification)) {
      throw new Error(`任务 ${task.id} 的 expected.verification 无效`);
    }
    if (expected.changed !== undefined && typeof expected.changed !== "boolean") {
      throw new Error(`任务 ${task.id} 的 expected.changed 必须是布尔值`);
    }
  }
  if (task.agentTools !== undefined && (!Array.isArray(task.agentTools) || task.agentTools.length === 0 || task.agentTools.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error(`任务 ${task.id} 的 agentTools 必须是非空字符串数组`);
  }
  if (task.agentRunsValidation !== undefined && typeof task.agentRunsValidation !== "boolean") {
    throw new Error(`任务 ${task.id} 的 agentRunsValidation 必须是布尔值`);
  }
  if (task.acceptance !== undefined) {
    if (!task.acceptance || typeof task.acceptance !== "object") throw new Error(`任务 ${task.id} 的 acceptance 必须是对象`);
    const acceptance = task.acceptance as Partial<EvalAcceptanceConfig>;
    if (acceptance.fixture !== undefined && (typeof acceptance.fixture !== "string" || !acceptance.fixture.trim())) {
      throw new Error(`任务 ${task.id} 的 acceptance.fixture 必须是非空字符串`);
    }
    for (const field of ["commands", "requiredChanges", "forbiddenChanges"] as const) {
      const paths = acceptance[field];
      if (paths !== undefined && (!Array.isArray(paths) || paths.length === 0 || paths.some((item) => typeof item !== "string" || !item.trim()))) {
        throw new Error(`任务 ${task.id} 的 acceptance.${field} 必须是非空字符串数组`);
      }
    }
    if (!acceptance.fixture && !acceptance.commands && !acceptance.requiredChanges && !acceptance.forbiddenChanges) {
      throw new Error(`任务 ${task.id} 的 acceptance 至少需要一项检查`);
    }
  }
  return task as EvalTask;
}

function normalizedWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function evaluateAcceptance(config: EvalAcceptanceConfig | undefined, changedFiles: string[], validations: EvalResult["validations"] = []): EvalAcceptanceResult | undefined {
  if (!config) return undefined;
  const changed = new Set(changedFiles.map(normalizedWorkspacePath));
  const failures: string[] = [];
  for (const path of config.requiredChanges ?? []) {
    if (!changed.has(normalizedWorkspacePath(path))) failures.push(`缺少必需改动: ${path}`);
  }
  for (const path of config.forbiddenChanges ?? []) {
    if (changed.has(normalizedWorkspacePath(path))) failures.push(`出现禁止改动: ${path}`);
  }
  for (const command of config.commands ?? []) {
    const validation = validations.find((item) => item.command === command);
    if (!validation) failures.push(`隐藏验收未执行: ${command}`);
    else if (!validation.passed) failures.push(`隐藏验收失败: ${command}`);
  }
  return { passed: failures.length === 0, failures };
}

function changedFilesFromStatus(output: string): string[] {
  return output.split(/\r?\n/)
    .filter((line) => line.trim() && !/^\?\? \.pi[\\/]/.test(line))
    .map((line) => line.slice(3).trim().split(" -> ").at(-1) ?? "")
    .filter(Boolean)
    .map(normalizedWorkspacePath)
    .sort();
}

function artifactSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function diffSummary(workspace: string, changedFiles: string[]): Promise<{ changedFiles: string[]; trackedChanges: Array<{ path: string; additions: number | null; deletions: number | null }> }> {
  const changed = new Set(changedFiles);
  const numstat = await runProcess("git", ["diff", "--numstat", "HEAD", "--"], workspace, 30_000);
  const trackedChanges = numstat.output.split(/\r?\n/).flatMap((line) => {
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = normalizedWorkspacePath(pathParts.join("\t"));
    if (!path || !changed.has(path)) return [];
    return [{
      path,
      additions: added === "-" ? null : Number.parseInt(added ?? "", 10),
      deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "", 10),
    }];
  });
  return { changedFiles, trackedChanges };
}

async function exportFailureArtifacts(
  workspace: string,
  rootDir: string,
  task: EvalTask,
  config: EvalConfig,
  result: EvalResult,
): Promise<string> {
  const runId = result.report?.run.runId ?? `run_${randomUUID()}`;
  const sample = result.sampleIndex ?? 1;
  const artifactDir = resolve(rootDir, `${artifactSegment(config.id)}__${artifactSegment(task.id)}__sample-${sample}__${artifactSegment(runId)}`);
  await mkdir(artifactDir, { recursive: true });
  const redactionOptions = { cwd: workspace };
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    taskId: task.id,
    configId: config.id,
    sampleIndex: sample,
    status: result.status,
    runId,
    changed: result.changed ?? false,
    acceptance: result.acceptance,
    error: result.error,
  };
  const validations = result.validations.map((validation) => ({
    ...validation,
    output: redactText(validation.output, redactionOptions),
  }));
  const eventsPath = join(workspace, ".pi", "run-review", "events.jsonl");
  let events: ReviewEvent[] = [];
  try {
    events = await readEvents(eventsPath);
  } catch {
    // A process startup failure may occur before the extension creates its event log.
  }
  await Promise.all([
    writeFile(join(artifactDir, "manifest.json"), serializeJson(redactValue(manifest, redactionOptions)), "utf8"),
    writeFile(join(artifactDir, "config.json"), serializeJson(redactValue(config, redactionOptions)), "utf8"),
    writeFile(join(artifactDir, "validations.json"), serializeJson(redactValue(validations, redactionOptions)), "utf8"),
    writeFile(join(artifactDir, "diff-summary.json"), serializeJson(redactValue(await diffSummary(workspace, result.changedFiles ?? []), redactionOptions)), "utf8"),
    writeFile(join(artifactDir, "events.jsonl"), events.map((event) => JSON.stringify(redactValue(event, redactionOptions))).join("\n") + (events.length ? "\n" : ""), "utf8"),
  ]);
  if (result.report) {
    const report = redactValue(result.report, redactionOptions) as RunReport;
    await Promise.all([
      writeFile(join(artifactDir, "report.json"), serializeJson(report), "utf8"),
      writeFile(join(artifactDir, "report.md"), redactText(renderMarkdown(report), redactionOptions), "utf8"),
      writeFile(join(artifactDir, "report.html"), redactText(renderHtml(report), redactionOptions), "utf8"),
    ]);
  }
  return artifactDir;
}

export function evaluateExpectation(expected: EvalExpected | undefined, result: Pick<EvalResult, "status" | "report" | "changed">): boolean | undefined {
  if (!expected) return undefined;
  if (expected.status !== undefined && expected.status !== result.status) return false;
  if (expected.changed !== undefined && expected.changed !== result.changed) return false;
  if (expected.verification !== undefined && expected.verification !== result.report?.outcome.verification) return false;
  if (expected.findings?.some((ruleId) => !result.report?.findings.some((finding) => finding.ruleId === ruleId))) return false;
  return true;
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
  return path ? readReport(path) : undefined;
}

export async function reconcileEvalReport(workspace: string, validations: EvalResult["validations"], storageDir = ".pi/run-review"): Promise<RunReport | undefined> {
  if (!validations.length) return readLatestReport(workspace, storageDir);
  const reportPath = await latestReportPath(workspace, storageDir);
  if (!reportPath) return undefined;
  const report = await readReport(reportPath);
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

export async function runEvalTask(task: EvalTask, config: EvalConfig, options: { rootDir: string; extensionPath: string; piCliPath?: string; keepWorkspace?: boolean; sampleIndex?: number; failureArtifactsDir?: string }): Promise<EvalResult> {
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
    const agentTools = task.agentTools ?? ["read", "edit", "write", "grep", "find", "ls"];
    const args = [
      "-p", "--approve", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--tools", agentTools.join(","), "--mode", "json", "-e", resolve(options.extensionPath),
    ];
    if (config.provider) args.push("--provider", config.provider);
    if (config.model) args.push("--model", config.model);
    if (config.thinking) args.push("--thinking", config.thinking);
    if (config.systemPrompt) args.push("--system-prompt", config.systemPrompt);
    const validationInstruction = task.agentRunsValidation
      ? "请按任务要求自行运行验证命令；评测器会在 Agent 结束后再次复核。"
      : "评测器会在 Agent 结束后自动执行验证命令；请不要尝试运行命令，只完成文件修改并在完成后结束。";
    args.push(`${task.prompt}\n\n${validationInstruction}`);
    const piResult = await runPiProcess(process.execPath, [options.piCliPath ?? piCliPath(options.rootDir), ...args], workspace, task.timeoutMs ?? 300_000);
    const diff = await runProcess("git", ["status", "--porcelain", "--untracked-files=all"], workspace, 30_000);
    const changedFiles = changedFilesFromStatus(diff.output);
    const changed = changedFiles.length > 0;
    if (task.acceptance?.fixture) {
      const acceptanceSource = resolve(options.rootDir, task.acceptance.fixture);
      const acceptanceTarget = join(workspace, ".eval", "acceptance");
      await mkdir(acceptanceTarget, { recursive: true });
      for (const entry of await readdir(acceptanceSource)) {
        await cp(join(acceptanceSource, entry), join(acceptanceTarget, entry), { recursive: true });
      }
    }
    const validations: EvalResult["validations"] = [];
    if (!piResult.timedOut) {
      for (const command of [...task.validate, ...(task.acceptance?.commands ?? [])]) {
        const validation = await runProcess(command, [], workspace, task.timeoutMs ?? 300_000, true);
        validations.push({ command, exitCode: validation.exitCode, passed: validation.exitCode === 0, output: validation.output });
      }
    }
    const acceptance = evaluateAcceptance(task.acceptance, changedFiles, validations);
    const status = piResult.timedOut
      ? "timeout"
      : piResult.exitCode !== 0
        ? "error"
        : validations.every((item) => item.passed) && changed && acceptance?.passed !== false
          ? "success"
          : "failed";
    const result: EvalResult = {
      taskId: task.id,
      configId: config.id,
      sampleIndex: options.sampleIndex,
      status,
      durationMs: Date.now() - startedAt,
      piExitCode: piResult.exitCode,
      validations,
      report: await reconcileEvalReport(workspace, validations),
      changed,
      changedFiles,
      acceptance,
      error: status === "error" || status === "timeout"
        ? (piResult.output || (status === "timeout" ? "Pi process timed out" : undefined))
        : !changed
          ? "Agent 未产生工作区改动"
          : acceptance?.passed === false
            ? acceptance.failures.join("; ")
            : undefined,
    };
    result.expectationPassed = evaluateExpectation(task.expected, result);
    if (result.status !== "success" && options.failureArtifactsDir) {
      try {
        result.failureArtifactDir = await exportFailureArtifacts(workspace, options.failureArtifactsDir, task, config, result);
      } catch (error) {
        result.failureArtifactError = redactText(error instanceof Error ? error.message : String(error), { cwd: workspace });
      }
    }
    return result;
  } finally {
    if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

export async function writeEvalSummary(path: string, results: EvalResult[], inputs?: { tasks: EvalTask[]; configs: EvalConfig[] }): Promise<void> {
  const configs = [...new Set(results.map((item) => item.configId))];
  const taskIds = [...new Set(results.map((item) => item.taskId))];
  const byConfig = Object.fromEntries(configs.map((configId) => {
    const selected = results.filter((item) => item.configId === configId);
    const sortedDurations = selected.map((item) => item.durationMs).sort((a, b) => a - b);
    const reports = selected.map((item) => item.report).filter((report): report is RunReport => Boolean(report));
    const findingCounts = reports.flatMap((report) => [...new Set(report.findings.map((finding) => finding.ruleId))]).reduce<Record<string, number>>((counts, ruleId) => ({ ...counts, [ruleId]: (counts[ruleId] ?? 0) + 1 }), {});
    const inputTokens = reports.map((report) => usageMetric(report, "input")).filter((value): value is number => value !== undefined);
    const outputTokens = reports.map((report) => usageMetric(report, "output")).filter((value): value is number => value !== undefined);
    const totalTokens = reports.map((report) => usageMetric(report, "totalTokens")).filter((value): value is number => value !== undefined);
    const costs = reports.map((report) => report.run.cost).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const summary: EvalConfigSummary = {
      runs: selected.length,
      successRate: selected.filter((item) => item.status === "success").length / selected.length,
      failedRate: selected.filter((item) => item.status === "failed" || item.status === "error").length / selected.length,
      timeoutRate: selected.filter((item) => item.status === "timeout").length / selected.length,
      unknownRate: reports.length ? reports.filter((report) => report.outcome.status === "unknown").length / reports.length : null,
      expectedRuns: selected.filter((item) => item.expectationPassed !== undefined).length,
      expectationPassRate: selected.some((item) => item.expectationPassed !== undefined)
        ? selected.filter((item) => item.expectationPassed === true).length / selected.filter((item) => item.expectationPassed !== undefined).length
        : null,
      acceptanceRuns: selected.filter((item) => item.acceptance !== undefined).length,
      acceptancePassRate: selected.some((item) => item.acceptance !== undefined)
        ? selected.filter((item) => item.acceptance?.passed === true).length / selected.filter((item) => item.acceptance !== undefined).length
        : null,
      findingRates: Object.fromEntries(Object.entries(findingCounts).map(([ruleId, count]) => [ruleId, count / selected.length])),
      averageDurationMs: Math.round(selected.reduce((sum, item) => sum + item.durationMs, 0) / selected.length),
      p95DurationMs: sortedDurations[Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)],
      averageTurns: reports.length ? reports.reduce((sum, report) => sum + report.run.turnCount, 0) / reports.length : null,
      averageTools: reports.length ? reports.reduce((sum, report) => sum + report.run.toolCount, 0) / reports.length : null,
      usageRuns: totalTokens.length,
      averageInputTokens: average(inputTokens),
      averageOutputTokens: average(outputTokens),
      averageTotalTokens: average(totalTokens),
      costRuns: costs.length,
      averageCost: average(costs),
    };
    return [configId, summary];
  }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : {}),
    ...(inputs ? {
      inputFingerprints: {
        tasks: Object.fromEntries(inputs.tasks.map((task) => [task.id, experimentFingerprint(task)])),
        configs: Object.fromEntries(inputs.configs.map((config) => [config.id, experimentFingerprint(config)])),
      },
    } : {}),
    byConfig,
    results,
  }, null, 2)}\n`, "utf8");
}
