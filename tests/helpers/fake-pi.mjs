import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = process.cwd();
const storageDir = join(cwd, ".pi", "run-review");
const reportsDir = join(storageDir, "reports");
const runId = "run_fake_integration";
const delayedReport = process.argv.some((arg) => arg.includes("DELAY_REPORT"));

if (process.argv.some((arg) => arg.includes("CHECK_HIDDEN_ACCEPTANCE"))) {
  try {
    await access(join(cwd, ".eval", "acceptance"));
    throw new Error("hidden acceptance fixture was visible to the Agent");
  } catch (error) {
    if ((error).code !== "ENOENT") throw error;
  }
}

await mkdir(reportsDir, { recursive: true });
await writeFile(join(cwd, "agent-change.txt"), "created by fake pi\n", "utf8");
await appendFile(join(storageDir, "events.jsonl"), `${JSON.stringify({
  schemaVersion: 1,
  eventId: "fake-edit",
  runId,
  timestamp: new Date().toISOString(),
  type: "tool_finished",
  payload: { toolName: "edit", isError: false },
})}\n`, "utf8");
const report = `${JSON.stringify({
  schemaVersion: 1,
  run: { runId, startedAt: new Date().toISOString(), turnCount: 1, toolCount: 1 },
  outcome: { status: "unknown", source: "unknown", verification: "missing" },
  findings: [],
}, null, 2)}\n`;
if (!delayedReport) await writeFile(join(reportsDir, `${runId}.json`), report, "utf8");
console.log(JSON.stringify({ type: "agent_settled" }));
if (delayedReport) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await writeFile(join(reportsDir, `${runId}.json`), report, "utf8");
}
