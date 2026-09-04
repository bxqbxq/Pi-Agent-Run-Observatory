import assert from "node:assert/strict";
import { add } from "../../math.js";

assert.equal(add(2, 3), 5);
for (const args of [["2", 3], [2, null], [undefined, 3]]) {
  assert.throws(() => add(...args), TypeError);
}
