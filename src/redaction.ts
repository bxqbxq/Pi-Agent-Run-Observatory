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
    output = output.split(cwd).join("<project>");
  }
  const maxChars = options.maxChars ?? 1000;
  return output.length > maxChars ? `${output.slice(0, maxChars)}…` : output;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|api.?key|private.?key/i.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = redactValue(item, options);
      }
    }
    return result;
  }
  return value;
}
