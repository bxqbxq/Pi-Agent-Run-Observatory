import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clamp } from "../../math.js";

assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(11, 0, 10), 10);
const source = await readFile("math.js", "utf8");
assert.doesNotMatch(source, /Math\.(?:min|max)/, "clamp must use explicit early returns instead of nested Math.min/Math.max");
