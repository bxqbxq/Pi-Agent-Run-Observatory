import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText, redactValue, summarizeMessageContent, summarizeValue } from "../src/redaction.js";

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

test("token 计数保留数值但真实 token 字符串仍脱敏", () => {
  assert.deepEqual(redactValue({ totalTokens: 123, inputTokens: 80, accessToken: "private-token-value", token: "private-token-value" }), {
    totalTokens: 123,
    inputTokens: 80,
    accessToken: "<redacted>",
    token: "<redacted>",
  });
});

test("未提供长度限制时保留完整脱敏文本", () => {
  const input = "x".repeat(1200);
  assert.equal(redactText(input).length, 1200);
});

test("参数摘要只保留结构和稳定哈希", () => {
  const input = { command: "npm test -- --token=super-secret-value", path: "C:\\private\\project\\file.ts", nested: { enabled: true } };
  const first = summarizeValue(input);
  const second = summarizeValue({ nested: { enabled: true }, path: "C:\\private\\project\\file.ts", command: "npm test -- --token=super-secret-value" });
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("npm test"), false);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.equal(serialized.includes("C:\\private"), false);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.structure, {
    type: "object",
    fields: { command: "string", nested: { type: "object", fields: { enabled: "boolean" } }, path: "string" },
  });
});

test("项目外绝对路径会被整体替换", () => {
  assert.equal(redactText("read C:\\Users\\alice\\secret.txt"), "read <external-path>");
  assert.equal(redactText("read /home/alice/secret.txt"), "read <external-path>");
});

test("消息摘要不保留原文但保留完成声明信号", () => {
  const summary = summarizeMessageContent("任务已经完成，测试已通过。内部代号 alpha-42");
  assert.equal(JSON.stringify(summary).includes("alpha-42"), false);
  assert.equal(summary.completionClaim, true);
  assert.equal(summarizeMessageContent("测试失败，任务尚未完成").failureDisclosure, true);
});

test("消息同时披露失败和声称完成时保留两个独立信号", () => {
  const summary = summarizeMessageContent("测试失败，但任务完成，测试已通过。");
  assert.equal(summary.failureDisclosure, true);
  assert.equal(summary.completionClaim, true);
});
