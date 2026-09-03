import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText, redactValue } from "../src/redaction.js";

test("文本脱敏凭据、项目路径并截断", () => {
  const output = redactText("token=super-secret-value at C:\\repo\\src\\index.ts", { cwd: "C:\\repo", maxChars: 80 });
  assert.equal(output.includes("super-secret-value"), false);
  assert.equal(output.includes("C:\\repo"), false);
  assert.equal(output.includes("<project>"), true);
});

test("对象脱敏敏感字段", () => {
  const output = redactValue({ apiKey: "abc", nested: { password: "xyz", ok: "yes" } }) as Record<string, unknown>;
  assert.equal(output.apiKey, "<redacted>");
  assert.deepEqual(output.nested, { password: "<redacted>", ok: "yes" });
});
