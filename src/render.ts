import type { ReviewEvent, RunReport } from "./schema.js";

export function renderMarkdown(report: RunReport, evidenceEvents: ReviewEvent[] = []): string {
  const lines = [
    `# Run Review: ${report.run.runId}`,
    "",
    `- 结果：**${report.outcome.status}**`,
    `- 验证：**${report.outcome.verification}**`,
    `- 模型：${report.run.model ?? "unknown"}`,
    `- 项目标识：${report.run.projectId ?? "unknown"}`,
    `- Git commit：${report.run.gitCommit ?? "unknown"}`,
    `- 采集模式：${report.run.captureMode ?? "redacted"}`,
    `- 回合 / 工具：${report.run.turnCount} / ${report.run.toolCount}`,
    `- Findings：${report.findings.length}`,
    "",
    "## Findings",
    "",
  ];
  if (!report.findings.length) lines.push("未发现已定义的问题模式。", "");
  for (const item of report.findings) {
    lines.push(`### ${item.ruleId} (${item.severity}, ${item.confidence})`, "", item.trigger, "", `证据：${item.evidence.join(", ")}`, "", `建议：${item.recommendation}`, "");
  }
  if (report.explanation) {
    lines.push("## LLM Explanation", "", report.explanation.text, "");
  }
  if (evidenceEvents.length) {
    lines.push("## Evidence Details", "");
    for (const event of evidenceEvents) {
      lines.push(`### ${event.eventId} (${event.type})`, "", "```json", JSON.stringify(event.payload, null, 2), "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderHtml(report: RunReport, evidenceEvents: ReviewEvent[] = []): string {
  const markdown = renderMarkdown(report, evidenceEvents).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>Run Review ${report.run.runId}</title><pre>${markdown}</pre>`;
}
