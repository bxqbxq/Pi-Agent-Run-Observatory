import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = process.cwd();
const storageDir = join(cwd, ".pi", "run-review");
const reportsDir = join(storageDir, "reports");
const runId = "run_fake_integration";

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
await writeFile(join(reportsDir, `${runId}.json`), `${JSON.stringify({
  schemaVersion: 1,
  run: { runId, startedAt: new Date().toISOString(), turnCount: 1, toolCount: 1 },
  outcome: { status: "unknown", source: "unknown", verification: "missing" },
  findings: [],
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ type: "agent_settled" }));
