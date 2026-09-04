import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("math.test.js", "utf8");
const negativeCalls = source.match(/add\s*\([^)]*-\s*\d[^)]*\)/g) ?? [];
assert.ok(negativeCalls.length >= 2, "math.test.js must contain at least two add calls with negative literals");
