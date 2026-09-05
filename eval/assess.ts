import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readEvalSummary } from "../src/diff.js";
import { assessExperiment, parseExperimentPlan } from "../src/experiment.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const rootDir = process.cwd();
const planPath = valueAfter(args, "--plan");
const resultPath = valueAfter(args, "--result");
const outputPath = valueAfter(args, "--output");

if (!planPath || !resultPath) {
  console.error("用法：npm run eval:assess -- --plan eval/experiments/plan.json --result eval/results/result.json [--output eval/results/assessment.json]");
  process.exitCode = 2;
} else {
  const plan = parseExperimentPlan(JSON.parse(await readFile(resolve(rootDir, planPath), "utf8")));
  const summary = await readEvalSummary(resolve(rootDir, resultPath));
  const assessment = assessExperiment(plan, summary);
  const serialized = `${JSON.stringify(assessment, null, 2)}\n`;
  if (outputPath) {
    const absoluteOutput = resolve(rootDir, outputPath);
    await mkdir(dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, serialized, "utf8");
  }
  console.log(serialized.trimEnd());
}
