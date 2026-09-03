import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

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
  reportPath?: string;
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
    const child = spawn(command, args, { cwd, shell, windowsHide: true, env: process.env });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolveResult({ exitCode: null, output: `${output}\n${error.message}`.trim(), timedOut }); });
    child.on("close", (exitCode) => { clearTimeout(timer); resolveResult({ exitCode, output: output.slice(-4000), timedOut }); });
  });
}

async function findLatestReport(workspace: string): Promise<string | undefined> {
  const reportsDir = join(workspace, ".pi", "run-review", "reports");
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const candidates = await Promise.all((await readdir(reportsDir)).filter((file) => file.endsWith(".json")).map(async (file) => ({ file, mtime: (await stat(join(reportsDir, file))).mtimeMs })));
    const latest = candidates.sort((a, b) => b.mtime - a.mtime)[0];
    return latest ? join(reportsDir, latest.file) : undefined;
  } catch {
    return undefined;
  }
}

export async function runEvalTask(task: EvalTask, config: EvalConfig, options: { rootDir: string; extensionPath: string; keepWorkspace?: boolean }): Promise<EvalResult> {
  const startedAt = Date.now();
  const workspace = await mkdtemp(join(tmpdir(), `pi-run-review-${task.id}-`));
  try {
    await cp(resolve(options.rootDir, task.fixture), workspace, { recursive: true });
    const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";
    const args = ["-p", "--no-session", "--no-extensions", "-e", resolve(options.extensionPath)];
    if (config.provider) args.push("--provider", config.provider);
    if (config.model) args.push("--model", config.model);
    if (config.thinking) args.push("--thinking", config.thinking);
    if (config.systemPrompt) args.push("--system-prompt", config.systemPrompt);
    args.push(task.prompt);
    const piResult = await runProcess(piCommand, args, workspace, task.timeoutMs ?? 300_000);
    const validations: EvalResult["validations"] = [];
    if (!piResult.timedOut) {
      for (const command of task.validate) {
        const validation = await runProcess(command, [], workspace, task.timeoutMs ?? 300_000, true);
        validations.push({ command, exitCode: validation.exitCode, passed: validation.exitCode === 0, output: validation.output });
      }
    }
    const status = piResult.timedOut ? "timeout" : piResult.exitCode !== 0 ? "error" : validations.every((item) => item.passed) ? "success" : "failed";
    return { taskId: task.id, configId: config.id, status, durationMs: Date.now() - startedAt, piExitCode: piResult.exitCode, validations, reportPath: await findLatestReport(workspace), error: status === "error" ? piResult.output : undefined };
  } finally {
    if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

export async function writeEvalSummary(path: string, results: EvalResult[]): Promise<void> {
  const configs = [...new Set(results.map((item) => item.configId))];
  const byConfig = Object.fromEntries(configs.map((configId) => {
    const selected = results.filter((item) => item.configId === configId);
    return [configId, { runs: selected.length, successRate: selected.filter((item) => item.status === "success").length / selected.length, failedRate: selected.filter((item) => item.status === "failed" || item.status === "error").length / selected.length, timeoutRate: selected.filter((item) => item.status === "timeout").length / selected.length, averageDurationMs: Math.round(selected.reduce((sum, item) => sum + item.durationMs, 0) / selected.length) }];
  }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), byConfig, results }, null, 2)}\n`, "utf8");
}
