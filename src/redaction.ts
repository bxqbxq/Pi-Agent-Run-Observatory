import { createHash } from "node:crypto";

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:api[_-]?key|token|password|secret|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
];

export interface RedactionOptions {
  maxChars?: number;
  cwd?: string;
}

export interface ValueSummary {
  structure: unknown;
  hash: string;
}

export interface MessageContentSummary {
  charCount: number;
  lineCount: number;
  completionClaim: boolean;
  failureDisclosure: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function valueStructure(value: unknown, depth = 0): unknown {
  if (depth >= 6) return "truncated";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 20).map((item) => valueStructure(item, depth + 1)),
      ...(value.length > 20 ? { truncated: true } : {}),
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return {
      type: "object",
      fields: Object.fromEntries(entries.slice(0, 50).map(([key, item]) => [key, valueStructure(item, depth + 1)])),
      ...(entries.length > 50 ? { truncated: true } : {}),
    };
  }
  return typeof value;
}

export function redactText(value: string, options: RedactionOptions = {}): string {
  const cwd = options.cwd?.replace(/[\\/]+$/, "");
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const key = match.split(/\s*[:=]\s*/)[0];
      return key && key !== match ? `${key}=<redacted>` : "<redacted>";
    });
  }
  if (cwd) {
    const cwdPattern = cwd.replaceAll("\\", "/").split("/").map(escapeRegExp).join("[\\\\/]");
    output = output.replace(new RegExp(cwdPattern, "gi"), "<project>");
  }
  output = output.replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|,;]*/g, "<external-path>");
  output = output.replace(/\/(?:Users|home|tmp|var|opt|workspace|workspaces)\/[^\s"'<>|,;]*/g, "<external-path>");
  const maxChars = options.maxChars;
  return maxChars !== undefined && output.length > maxChars ? `${output.slice(0, maxChars)}…` : output;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const numericTokenMetric = typeof item === "number" && /token/i.test(key);
      if (!numericTokenMetric && /token|secret|password|api.?key|private.?key/i.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = redactValue(item, options);
      }
    }
    return result;
  }
  return value;
}

export function summarizeValue(value: unknown, options: Pick<RedactionOptions, "cwd"> = {}): ValueSummary {
  const redacted = stableValue(redactValue(value, options));
  const serialized = JSON.stringify(redacted) ?? String(redacted);
  return {
    structure: valueStructure(value),
    hash: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}

export function summarizeMessageContent(value: string): MessageContentSummary {
  const failureDisclosure = /未完成|没有完成|尚未完成|无法完成|不能完成|失败|未通过|没有通过|错误|阻塞|\b(?:failed|failure|error|blocked|incomplete|not\s+(?:done|complete|completed|finished|successful)|did not|could not)\b/i.test(value);
  const reportsCompletion = /任务(?:已经|已)?完成|测试(?:已经|已)?通过|验证(?:已经|已)?通过|\b(?:done|completed|finished|success(?:ful)?|tests?\s+passed)\b/i.test(value);
  return {
    charCount: value.length,
    lineCount: value ? value.split(/\r?\n/).length : 0,
    completionClaim: reportsCompletion && !failureDisclosure,
    failureDisclosure,
  };
}
