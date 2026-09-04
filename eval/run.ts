import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

if (!configPath) {
  console.error("用法：npm run eval -- --configs eval/configs.json [--tasks eval/tasks] [--task task-id] [--repeats 3] [--output eval/results/latest.json]");
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
        results.push(await runEvalTask(task, config, {
          rootDir,
          extensionPath: resolve(rootDir, "extensions/run-review.ts"),
          sampleIndex,
        }));
      }
    }
  }
  await writeEvalSummary(output, results);
  console.log(`评测完成：${output}`);
}
