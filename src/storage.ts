import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseReviewEvent, parseRunReport, type ReviewEvent, type RunReport } from "./schema.js";

export interface InvalidEventLine {
  lineNumber: number;
  error: Error;
}

export interface ReadEventsOptions {
  onInvalidLine?: (issue: InvalidEventLine) => void;
}

export async function appendEvent(path: string, event: ReviewEvent): Promise<void> {
  const validEvent = parseReviewEvent(event);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(validEvent)}\n`, "utf8");
}

export async function readEvents(path: string, options: ReadEventsOptions = {}): Promise<ReviewEvent[]> {
  try {
    const content = await readFile(path, "utf8");
    const events: ReviewEvent[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        events.push(parseReviewEvent(JSON.parse(line)));
      } catch (error) {
        const issue = { lineNumber: index + 1, error: error instanceof Error ? error : new Error(String(error)) };
        if (options.onInvalidLine) options.onInvalidLine(issue);
        else console.warn(`pi-run-review: ignored invalid event at line ${issue.lineNumber}: ${issue.error.message}`);
      }
    }
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readReport(path: string): Promise<RunReport> {
  return parseRunReport(JSON.parse(await readFile(path, "utf8")));
}

export async function writeReport(path: string, report: RunReport): Promise<void> {
  const validReport = parseRunReport(report);
  await mkdir(dirname(path), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify(validReport, null, 2)}\n`, "utf8");
}
