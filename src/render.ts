import type { RunReport } from "./schema.js";

export function renderMarkdown(report: RunReport): string {
  const lines = [
    `# Run Review: ${report.run.runId}`,
    "",
    `- 结果：**${report.outcome.status}**`,
    `- 验证：**${report.outcome.verification}**`,
    `- 模型：${report.run.model ?? "unknown"}`,
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
  return `${lines.join("\n")}\n`;
}

export function renderHtml(report: RunReport): string {
  const markdown = renderMarkdown(report).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>Run Review ${report.run.runId}</title><pre>${markdown}</pre>`;
}
