import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { loadTasks, parseRepeatCount, runEvalTask, selectEvalTasks, writeEvalSummary, type EvalConfig, type EvalResult } from "../src/eval.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const rootDir = resolve(valueAfter(args, "--root") ?? process.cwd());
const tasksDir = resolve(rootDir, valueAfter(args, "--tasks") ?? "eval/tasks");
const output = resolve(rootDir, valueAfter(args, "--output") ?? "eval/results/latest.json");
const configPath = valueAfter(args, "--configs");
const taskId = valueAfter(args, "--task");
const repeats = parseRepeatCount(valueAfter(args, "--repeats"));
const explicitFailureArtifacts = valueAfter(args, "--failure-artifacts");
const failureArtifactsDir = explicitFailureArtifacts
  ? resolve(rootDir, explicitFailureArtifacts)
  : args.includes("--keep-failures")
    ? resolve(dirname(output), `${basename(output, extname(output))}-failures`)
    : undefined;

if (!configPath) {
  console.error("用法：npm run eval -- --configs eval/configs.json [--tasks eval/tasks] [--task task-id] [--repeats 3] [--keep-failures | --failure-artifacts path] [--output eval/results/latest.json]");
  process.exitCode = 2;
} else {
  const configs = JSON.parse(await readFile(resolve(rootDir, configPath), "utf8")) as EvalConfig[];
  if (!Array.isArray(configs) || configs.length === 0 || configs.some((config) => !config.id)) throw new Error("configs 必须是包含 id 的非空数组");
  const tasks = selectEvalTasks(await loadTasks(tasksDir), taskId);
  const results: EvalResult[] = [];
  for (const config of configs) {
    for (const task of tasks) {
      for (let sampleIndex = 1; sampleIndex <= repeats; sampleIndex += 1) {
        console.log(`[${config.id}] ${task.id} (${sampleIndex}/${repeats})`);
        const result = await runEvalTask(task, config, {
          rootDir,
          extensionPath: resolve(rootDir, "extensions/run-review.ts"),
          sampleIndex,
          failureArtifactsDir,
        });
        results.push(result);
        if (result.failureArtifactDir) console.log(`失败证据：${result.failureArtifactDir}`);
        if (result.failureArtifactError) console.warn(`失败证据导出失败：[${config.id}] ${task.id}：${result.failureArtifactError}`);
      }
    }
  }
  await writeEvalSummary(output, results, { tasks, configs });
  console.log(`评测完成：${output}`);
}
