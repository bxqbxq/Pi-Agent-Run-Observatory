import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseRunReviewConfig } from "../src/config.js";
import { parseReviewEvent, parseRunReport, type ReviewEvent, type RunReport } from "../src/schema.js";
import { appendEvent, readEvents, readReport, writeReport } from "../src/storage.js";

const validEvent: ReviewEvent = {
  schemaVersion: 1,
  eventId: "evt_schema",
  runId: "run_schema",
  timestamp: "2026-09-04T00:00:00.000Z",
  type: "message",
  payload: { role: "assistant" },
};

const validReport: RunReport = {
  schemaVersion: 1,
  run: { runId: "run_schema", startedAt: "2026-09-04T00:00:00.000Z", turnCount: 1, toolCount: 0 },
  outcome: { status: "unknown", source: "unknown", verification: "missing" },
  findings: [],
};

test("事件和报告运行时 schema 接受有效数据并拒绝错误版本", () => {
  assert.equal(parseReviewEvent(validEvent).eventId, validEvent.eventId);
  assert.equal(parseRunReport(validReport).run.runId, validReport.run.runId);
  assert.throws(() => parseReviewEvent({ ...validEvent, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => parseReviewEvent({ ...validEvent, timestamp: "not-a-date" }), /有效时间/);
  assert.throws(() => parseRunReport({ ...validReport, outcome: { ...validReport.outcome, status: "done" } }), /status/);
  assert.throws(() => parseRunReport({ ...validReport, run: { ...validReport.run, toolCount: -1 } }), /toolCount/);
  assert.throws(() => parseRunReport({ ...validReport, findings: [{ findingId: "f1", ruleId: "rule", severity: "high", confidence: "high", evidence: [], trigger: "x", recommendation: "y" }] }), /evidence/);
});

test("配置 schema 对无效类型整份拒绝", () => {
  const config = parseRunReviewConfig({ summaryMaxChars: 500, captureFullContent: false });
  assert.equal(config.summaryMaxChars, 500);
  assert.equal(config.captureFullContent, false);
  assert.throws(() => parseRunReviewConfig({ captureFullContent: "yes" }), /captureFullContent/);
  assert.throws(() => parseRunReviewConfig({ duplicateWindow: 0 }), /duplicateWindow/);
  assert.throws(() => parseRunReviewConfig({ maxEventsPerRun: 0 }), /maxEventsPerRun/);
  assert.throws(() => parseRunReviewConfig({ verificationCommands: [] }), /verificationCommands/);
});

test("JSONL 读取跳过损坏和 schema 无效行并保留有效事件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-review-schema-jsonl-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, [
    JSON.stringify(validEvent),
    "{broken-json",
    JSON.stringify({ ...validEvent, eventId: "evt_wrong_version", schemaVersion: 2 }),
    JSON.stringify({ ...validEvent, eventId: "evt_second" }),
    "",
  ].join("\n"), "utf8");
  const issues: number[] = [];
  const events = await readEvents(path, { onInvalidLine: (issue) => issues.push(issue.lineNumber) });
  assert.deepEqual(events.map((event) => event.eventId), ["evt_schema", "evt_second"]);
  assert.deepEqual(issues, [2, 3]);
});

test("存储写入前校验 schema，报告读取时不信任磁盘 JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-review-schema-storage-"));
  const eventPath = join(dir, "events.jsonl");
  const reportPath = join(dir, "report.json");
  await appendEvent(eventPath, validEvent);
  await writeReport(reportPath, validReport);
  assert.equal((await readEvents(eventPath))[0]?.eventId, validEvent.eventId);
  assert.equal((await readReport(reportPath)).run.runId, validReport.run.runId);
  await assert.rejects(appendEvent(eventPath, { ...validEvent, type: "invalid" } as unknown as ReviewEvent), /event.type/);
  await writeFile(reportPath, JSON.stringify({ ...validReport, schemaVersion: 9 }), "utf8");
  await assert.rejects(readReport(reportPath), /schemaVersion/);
  assert.match(await readFile(eventPath, "utf8"), /evt_schema/);
});
