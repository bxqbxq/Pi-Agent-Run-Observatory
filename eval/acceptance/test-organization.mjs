import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("math.test.js", "utf8");
assert.match(source, /(?:function|const)\s+assertClampCases\b/, "math.test.js must define assertClampCases");
assert.match(source, /assertClampCases\s*\(/, "math.test.js must use assertClampCases");
