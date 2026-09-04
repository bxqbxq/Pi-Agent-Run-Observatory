import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clamp } from "../../math.js";

assert.equal(clamp(1.25, 0.5, 2.5), 1.25);
assert.equal(clamp(0.25, 0.5, 2.5), 0.5);
assert.equal(clamp(2.75, 0.5, 2.5), 2.5);
const source = await readFile("math.test.js", "utf8");
assert.match(source, /clamp\s*\([^)]*\d+\.\d+[^)]*\)/, "math.test.js must exercise clamp with decimal literals");
