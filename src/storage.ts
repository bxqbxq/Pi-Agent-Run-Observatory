import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReviewEvent, RunReport } from "./schema.js";

export async function appendEvent(path: string, event: ReviewEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readEvents(path: string): Promise<ReviewEvent[]> {
  try {
    const content = await readFile(path, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ReviewEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeReport(path: string, report: RunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
