import assert from "node:assert/strict";
import { add } from "../../math.js";

for (const args of [["2", 3], [2, Number.NaN], [Number.POSITIVE_INFINITY, 3]]) {
  assert.throws(() => add(...args), { name: "TypeError", message: "add expects finite numbers" });
}
