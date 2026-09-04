import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { evaluateAcceptance, evaluateExpectation, loadTasks, parseRepeatCount, piCliPath, reconcileEvalReport, runEvalTask, selectEvalTasks, validateTask, writeEvalSummary } from "../src/eval.js";
import { appendEvent, writeReport } from "../src/storage.js";
import { renderHtml, renderMarkdown } from "../src/render.js";
import type { RunReport } from "../src/schema.js";

const execFileAsync = promisify(execFile);

test("任务 schema 要求验证命令", () => {
  assert.throws(() => validateTask({ id: "bad", prompt: "x", fixture: "y", validate: [] }), /验证命令/);
  assert.deepEqual(validateTask({ id: "ok", prompt: "x", fixture: "y", validate: ["npm test"] }).id, "ok");
  assert.deepEqual(validateTask({
    id: "negative",
    prompt: "x",
    fixture: "y",
    validate: ["npm test"],
    expected: { status: "failed", findings: ["tool-failure-unrecovered"], verification: "passed", changed: false },
  }).expected, { status: "failed", findings: ["tool-failure-unrecovered"], verification: "passed", changed: false });
  assert.deepEqual(validateTask({
    id: "agent-validation",
    prompt: "x",
    fixture: "y",
    validate: ["npm test"],
    agentTools: ["read", "bash"],
    agentRunsValidation: true,
  }).agentTools, ["read", "bash"]);
  assert.throws(() => validateTask({ id: "bad-expected", prompt: "x", fixture: "y", validate: ["npm test"], expected: { status: "bogus" } }), /expected/);
  assert.throws(() => validateTask({ id: "bad-tools", prompt: "x", fixture: "y", validate: ["npm test"], agentTools: [] }), /agentTools/);
  assert.deepEqual(validateTask({
    id: "acceptance",
    prompt: "x",
    fixture: "y",
    validate: ["npm test"],
    acceptance: { fixture: "eval/acceptance", commands: ["node .eval/acceptance/check.mjs"], requiredChanges: ["math.js"], forbiddenChanges: ["package.json"] },
  }).acceptance?.requiredChanges, ["math.js"]);
  assert.throws(() => validateTask({ id: "bad-acceptance", prompt: "x", fixture: "y", validate: ["npm test"], acceptance: { requiredChanges: [] } }), /acceptance/);
});

test("重复次数和单任务筛选拒绝无效输入", () => {
  assert.equal(parseRepeatCount(undefined), 1);
  assert.equal(parseRepeatCount("3"), 3);
  assert.throws(() => parseRepeatCount("0"), /1 到 100/);
  assert.throws(() => parseRepeatCount("1.5"), /1 到 100/);
  const tasks = [
    { id: "a", prompt: "a", fixture: "fixture", validate: ["npm test"] },
    { id: "b", prompt: "b", fixture: "fixture", validate: ["npm test"] },
  ];
  assert.deepEqual(selectEvalTasks(tasks, "b").map((task) => task.id), ["b"]);
  assert.throws(() => selectEvalTasks(tasks, "missing"), /不存在任务/);
});

test("任务级验收检查必改和禁改文件", () => {
  assert.deepEqual(evaluateAcceptance(undefined, ["math.js"]), undefined);
  assert.deepEqual(evaluateAcceptance({ requiredChanges: ["math.js"], forbiddenChanges: ["package.json"] }, ["math.js"]), {
    passed: true,
    failures: [],
  });
  assert.deepEqual(evaluateAcceptance({ requiredChanges: ["math.test.js"], forbiddenChanges: ["package.json"] }, ["package.json"]), {
    passed: false,
    failures: ["缺少必需改动: math.test.js", "出现禁止改动: package.json"],
  });
  assert.deepEqual(evaluateAcceptance(
    { commands: ["node .eval/acceptance/check.mjs"] },
    ["math.js"],
    [{ command: "node .eval/acceptance/check.mjs", exitCode: 1, passed: false, output: "failed" }],
  ), {
    passed: false,
    failures: ["隐藏验收失败: node .eval/acceptance/check.mjs"],
  });
});

test("Pi CLI 固定使用项目本地依赖", () => {
  assert.equal(
    piCliPath("C:\\project"),
    normalize("C:\\project\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js"),
  );
});

test("fixture 内容直接复制到评测工作区根目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-review-fixture-test-"));
  const fixture = join(dir, "fixture");
  const workspace = join(dir, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(fixture));
  await writeFile(join(fixture, "package.json"), "{}\n", "utf8");
  for (const entry of await (await import("node:fs/promises")).readdir(fixture)) {
    await cp(join(fixture, entry), join(workspace, entry), { recursive: true });
  }
  assert.equal(await readFile(join(workspace, "package.json"), "utf8"), "{}\n");
});

test("评测汇总按配置计算成功率", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-review-test-"));
  const path = join(dir, "summary.json");
  await writeEvalSummary(path, [
    {
      taskId: "a", configId: "baseline", status: "success", durationMs: 100, piExitCode: 0, validations: [], expectationPassed: true, acceptance: { passed: true, failures: [] },
      report: { schemaVersion: 1, run: { runId: "run_a", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 2, toolCount: 3, usage: { input: 10, output: 5, totalTokens: 15 }, cost: 0.01 }, outcome: { status: "success", source: "rule", verification: "passed" }, findings: [] },
    },
    {
      taskId: "b", configId: "baseline", status: "failed", durationMs: 300, piExitCode: 0, validations: [], acceptance: { passed: false, failures: ["x"] },
      report: { schemaVersion: 1, run: { runId: "run_b", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 4, toolCount: 5, usage: { input: 30, output: 15, totalTokens: 45 }, cost: 0.03 }, outcome: { status: "failed", source: "rule", verification: "failed" }, findings: [] },
    },
  ]);
  const summary = JSON.parse(await readFile(path, "utf8"));
  assert.equal(summary.byConfig.baseline.successRate, 0.5);
  assert.equal(summary.byConfig.baseline.expectationPassRate, 1);
  assert.equal(summary.byConfig.baseline.expectedRuns, 1);
  assert.equal(summary.byConfig.baseline.acceptanceRuns, 2);
  assert.equal(summary.byConfig.baseline.acceptancePassRate, 0.5);
  assert.equal(summary.byConfig.baseline.averageDurationMs, 200);
  assert.equal(summary.byConfig.baseline.usageRuns, 2);
  assert.equal(summary.byConfig.baseline.averageInputTokens, 20);
  assert.equal(summary.byConfig.baseline.averageOutputTokens, 10);
  assert.equal(summary.byConfig.baseline.averageTotalTokens, 30);
  assert.equal(summary.byConfig.baseline.costRuns, 2);
  assert.equal(summary.byConfig.baseline.averageCost, 0.02);
});

test("失败任务按状态、finding、验证和改动状态匹配预期", () => {
  assert.equal(evaluateExpectation(
    { status: "failed", findings: ["tool-failure-unrecovered"], verification: "passed", changed: false },
    { status: "failed", report: { findings: [{ ruleId: "tool-failure-unrecovered" } as never], outcome: { verification: "passed" } } as never, changed: false },
  ), true);
  assert.equal(evaluateExpectation(
    { status: "failed", findings: ["verification-failure-ignored"] },
    { status: "failed", report: { findings: [], outcome: { verification: "failed" } } as never, changed: true },
  ), false);
  assert.equal(evaluateExpectation(undefined, { status: "success" }), undefined);
});

test("负向任务集包含四个带预期的独立场景", async () => {
  const tasks = await loadTasks(join(process.cwd(), "eval", "failure-tasks"));
  assert.deepEqual(tasks.map((task) => task.id), [
    "tool-failure-unrecovered",
    "ineffective-duplicate-call",
    "verification-failure-ignored",
    "no-change",
  ]);
  assert.equal(tasks.every((task) => task.expected !== undefined), true);
});

test("八个正常任务都有不可见且能拒绝原始基线的验收器", async () => {
  const tasks = await loadTasks(join(process.cwd(), "eval", "tasks"));
  assert.equal(tasks.length, 8);
  assert.equal(tasks.every((task) => task.acceptance?.fixture === "eval/acceptance"), true);

  for (const task of tasks) {
    const workspace = await mkdtemp(join(tmpdir(), `pi-run-review-acceptance-${task.id}-`));
    for (const entry of await (await import("node:fs/promises")).readdir(join(process.cwd(), "fixtures", "tiny-node"))) {
      await cp(join(process.cwd(), "fixtures", "tiny-node", entry), join(workspace, entry), { recursive: true });
    }
    const acceptanceDir = join(workspace, ".eval", "acceptance");
    await mkdir(acceptanceDir, { recursive: true });
    for (const entry of await (await import("node:fs/promises")).readdir(join(process.cwd(), "eval", "acceptance"))) {
      await cp(join(process.cwd(), "eval", "acceptance", entry), join(acceptanceDir, entry), { recursive: true });
    }
    const validator = task.acceptance?.commands?.find((command) => command.startsWith("node .eval/acceptance/"));
    assert.ok(validator, `${task.id} 缺少隐藏验收命令`);
    await assert.rejects(execFileAsync(process.execPath, [join(".eval", "acceptance", basename(validator))], { cwd: workspace }), `${task.id} 的验收器不应接受原始 fixture`);
  }
});

test("八个隐藏验收器都接受满足公开要求的最小候选", async () => {
  const candidates: Record<string, Record<string, string>> = {
    "add-negative": {
      "math.test.js": `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, clamp } from "./math.js";\ntest("add", () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); assert.equal(add(-2, -3), -5); });\ntest("clamp", () => assert.equal(clamp(11, 0, 10), 10));\n`,
    },
    "add-validation": {
      "math.js": `export function add(a, b) { if (typeof a !== "number" || typeof b !== "number") throw new TypeError("numbers required"); return a + b; }\nexport function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }\n`,
    },
    "clamp-decimals": {
      "math.test.js": `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, clamp } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("clamp decimals", () => { assert.equal(clamp(1.25, 0.5, 2.5), 1.25); assert.equal(clamp(0.25, 0.5, 2.5), 0.5); assert.equal(clamp(2.75, 0.5, 2.5), 2.5); });\n`,
    },
    readme: {
      "README.md": "# Tiny math\n\nExports `add` and `clamp`. Run tests with `npm test`.\n",
    },
    "refactor-clamp": {
      "math.js": `export function add(a, b) { return a + b; }\nexport function clamp(value, min, max) { if (value < min) return min; if (value > max) return max; return value; }\n`,
    },
    "add-average": {
      "math.js": `export function add(a, b) { return a + b; }\nexport function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }\nexport function average(numbers) { if (!Array.isArray(numbers) || numbers.length === 0 || numbers.some((value) => typeof value !== "number")) throw new TypeError("number array required"); return numbers.reduce((sum, value) => sum + value, 0) / numbers.length; }\n`,
    },
    "error-message": {
      "math.js": `export function add(a, b) { if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError("add expects finite numbers"); return a + b; }\nexport function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }\n`,
    },
    "test-organization": {
      "math.test.js": `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, clamp } from "./math.js";\nfunction assertClampCases(cases) { for (const [value, min, max, expected] of cases) assert.equal(clamp(value, min, max), expected); }\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("clamp", () => assertClampCases([[-1, 0, 10, 0], [5, 0, 10, 5], [11, 0, 10, 10]]));\n`,
    },
  };
  const tasks = await loadTasks(join(process.cwd(), "eval", "tasks"));
  for (const task of tasks) {
    const workspace = await mkdtemp(join(tmpdir(), `pi-run-review-candidate-${task.id}-`));
    for (const entry of await (await import("node:fs/promises")).readdir(join(process.cwd(), "fixtures", "tiny-node"))) {
      await cp(join(process.cwd(), "fixtures", "tiny-node", entry), join(workspace, entry), { recursive: true });
    }
    for (const [file, content] of Object.entries(candidates[task.id] ?? {})) await writeFile(join(workspace, file), content, "utf8");
    const acceptanceDir = join(workspace, ".eval", "acceptance");
    await mkdir(acceptanceDir, { recursive: true });
    for (const entry of await (await import("node:fs/promises")).readdir(join(process.cwd(), "eval", "acceptance"))) {
      await cp(join(process.cwd(), "eval", "acceptance", entry), join(acceptanceDir, entry), { recursive: true });
    }
    const validator = task.acceptance?.commands?.find((command) => command.startsWith("node .eval/acceptance/"));
    assert.ok(validator);
    await execFileAsync(process.execPath, ["--test"], { cwd: workspace });
    await execFileAsync(process.execPath, [join(".eval", "acceptance", basename(validator))], { cwd: workspace });
  }
});

test("外部验证结果回写报告并消除未验证误报", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-run-review-reconcile-test-"));
  const reportDir = join(workspace, ".pi", "run-review", "reports");
  const report: RunReport = {
    schemaVersion: 1,
    run: { runId: "run_reconcile", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 1, toolCount: 1 },
    outcome: { status: "unknown", source: "unknown", verification: "missing" },
    findings: [{
      findingId: "change-without-verification:e1",
      ruleId: "change-without-verification",
      severity: "high",
      confidence: "high",
      evidence: ["e1"],
      trigger: "检测到文件改动，但 run 结束前没有成功验证命令",
      recommendation: "运行任务声明的测试、构建、类型检查或 lint 命令",
    }],
  };
  await mkdir(reportDir, { recursive: true });
  await appendEvent(join(workspace, ".pi", "run-review", "events.jsonl"), {
    schemaVersion: 1,
    eventId: "e1",
    runId: report.run.runId,
    timestamp: "2026-09-03T00:00:01.000Z",
    type: "tool_finished",
    payload: { toolName: "edit", isError: false },
  });
  await writeReport(join(reportDir, "run_reconcile.json"), report);

  const reconciled = await reconcileEvalReport(workspace, [{ command: "npm test", exitCode: 0, passed: true, output: "" }]);

  assert.equal(reconciled?.outcome.status, "success");
  assert.equal(reconciled?.outcome.verification, "passed");
  assert.equal(reconciled?.findings.some((item) => item.ruleId === "change-without-verification"), false);
});

test("协调报告同步更新三种格式并支持自定义存储目录", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-run-review-reconcile-format-test-"));
  const reportDir = join(workspace, ".pi", "custom-review", "reports");
  const report: RunReport = {
    schemaVersion: 1,
    run: { runId: "run_format", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 1, toolCount: 1 },
    outcome: { status: "unknown", source: "unknown", verification: "missing" },
    findings: [],
  };
  await mkdir(reportDir, { recursive: true });
  const eventsPath = join(workspace, ".pi", "custom-review", "events.jsonl");
  await appendEvent(eventsPath, {
    schemaVersion: 1,
    eventId: "format-edit",
    runId: report.run.runId,
    timestamp: "2026-09-03T00:00:01.000Z",
    type: "tool_finished",
    payload: { toolName: "edit", isError: false },
  });
  const reportPath = join(reportDir, "run_format.json");
  await writeReport(reportPath, report);
  await writeFile(join(reportDir, "run_format.md"), renderMarkdown(report), "utf8");
  await writeFile(join(reportDir, "run_format.html"), renderHtml(report), "utf8");

  const reconciled = await reconcileEvalReport(workspace, [{ command: "npm test", exitCode: 0, passed: true, output: "" }], ".pi/custom-review");
  const markdown = await readFile(join(reportDir, "run_format.md"), "utf8");
  const html = await readFile(join(reportDir, "run_format.html"), "utf8");
  const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });

  assert.equal(reconciled?.outcome.status, "success");
  assert.equal(reconciled?.outcome.verification, "passed");
  assert.match(markdown, /结果：\*\*success\*\*/);
  assert.match(markdown, /验证：\*\*passed\*\*/);
  assert.match(html, /结果：\*\*success\*\*/);
  assert.match(html, /验证：\*\*passed\*\*/);
  assert.equal(events.filter((event) => event.type === "verification").length, 1);
});

test("报告明确标记完整采集模式", () => {
  const report: RunReport = {
    schemaVersion: 1,
    run: { runId: "run_full", startedAt: "2026-09-03T00:00:00.000Z", turnCount: 1, toolCount: 0, captureMode: "full" },
    outcome: { status: "unknown", source: "unknown", verification: "missing" },
    findings: [],
  };
  assert.match(renderMarkdown(report), /采集模式：full/);
  assert.match(renderHtml(report), /采集模式：full/);
});

test("评测 runner 端到端执行假 Pi、验证并协调报告", async () => {
  const result = await runEvalTask(
    { id: "integration", prompt: "完成任务", fixture: "fixtures/tiny-node", validate: ["npm test"], timeoutMs: 5_000 },
    { id: "fake" },
    {
      rootDir: process.cwd(),
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi.mjs"),
      keepWorkspace: false,
      sampleIndex: 2,
    },
  );

  assert.equal(result.status, "success");
  assert.equal(result.sampleIndex, 2);
  assert.equal(result.validations.length, 1);
  assert.equal(result.validations[0]?.passed, true);
  assert.equal(result.report?.outcome.status, "success");
  assert.equal(result.report?.outcome.verification, "passed");
});

test("隐藏验收夹具仅在 Agent 结束后注入并记录实际改动文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-run-review-hidden-acceptance-test-"));
  const fixture = join(root, "fixture");
  const acceptance = join(root, "acceptance");
  await mkdir(fixture, { recursive: true });
  await mkdir(acceptance, { recursive: true });
  await writeFile(join(fixture, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  await writeFile(join(acceptance, "check.mjs"), "import assert from 'node:assert/strict'; import { access } from 'node:fs/promises'; await assert.doesNotReject(access('agent-change.txt'));\n", "utf8");

  const result = await runEvalTask(
    {
      id: "hidden-acceptance",
      prompt: "CHECK_HIDDEN_ACCEPTANCE",
      fixture: "fixture",
      validate: ["node --version"],
      acceptance: { fixture: "acceptance", commands: ["node .eval/acceptance/check.mjs"], requiredChanges: ["agent-change.txt"] },
      timeoutMs: 5_000,
    },
    { id: "fake" },
    {
      rootDir: root,
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi.mjs"),
      keepWorkspace: false,
    },
  );

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedFiles, ["agent-change.txt"]);
  assert.deepEqual(result.acceptance, { passed: true, failures: [] });
  assert.equal(result.validations.length, 2);
  assert.equal(result.validations.every((validation) => validation.passed), true);
});

test("基础验证通过但缺少任务要求的改动时仍判失败", async () => {
  const result = await runEvalTask(
    {
      id: "missing-required-change",
      prompt: "完成任务",
      fixture: "fixtures/tiny-node",
      validate: ["npm test"],
      acceptance: { requiredChanges: ["math.js"] },
      timeoutMs: 5_000,
    },
    { id: "fake" },
    {
      rootDir: process.cwd(),
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi.mjs"),
      keepWorkspace: false,
    },
  );

  assert.equal(result.validations[0]?.passed, true);
  assert.equal(result.changed, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.acceptance, { passed: false, failures: ["缺少必需改动: math.js"] });
  assert.match(result.error ?? "", /缺少必需改动/);
});

test("评测 runner 标记预期成功的失败场景", async () => {
  const result = await runEvalTask(
    {
      id: "integration-failure-expected",
      prompt: "FAIL_VALIDATION",
      fixture: "fixtures/tiny-node",
      validate: ["npm test"],
      expected: { status: "failed", verification: "failed", findings: ["verification-failure-ignored"], changed: true },
      timeoutMs: 5_000,
    },
    { id: "fake", model: "FAIL_VALIDATION" },
    {
      rootDir: process.cwd(),
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi-failure.mjs"),
      keepWorkspace: false,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.changed, true);
  assert.equal(result.expectationPassed, true);
});

test("评测 runner 端到端保留验证失败诊断", async () => {
  const result = await runEvalTask(
    { id: "integration-failure", prompt: "FAIL_VALIDATION", fixture: "fixtures/tiny-node", validate: ["npm test"], timeoutMs: 5_000 },
    { id: "fake", model: "FAIL_VALIDATION" },
    {
      rootDir: process.cwd(),
      extensionPath: "unused-extension.ts",
      piCliPath: join(process.cwd(), "tests", "helpers", "fake-pi-failure.mjs"),
      keepWorkspace: false,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.validations[0]?.passed, false);
  assert.equal(result.report?.outcome.status, "failed");
  assert.equal(result.report?.outcome.verification, "failed");
  assert.equal(result.report?.findings.some((item) => item.ruleId === "verification-failure-ignored"), true);
});
