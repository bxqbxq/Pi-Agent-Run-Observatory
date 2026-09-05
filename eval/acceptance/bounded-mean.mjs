import assert from "node:assert/strict";
import { add, boundedMean, clamp } from "../../math.js";

assert.equal(add(2, 3), 5);
assert.equal(clamp(11, 0, 10), 10);
assert.equal(boundedMean([1, 5, 10], 2, 8), 5);
assert.equal(boundedMean([-10, 0, 20, 30], 0, 20), 10);
assert.equal(boundedMean([2.5, 4.5], 0.5, 8.5), 3.5);

const original = [-4, 5, 20];
const snapshot = [...original];
assert.equal(boundedMean(original, 0, 10), 5);
assert.deepEqual(original, snapshot, "boundedMean must not mutate numbers");

for (const args of [
  ["123", 0, 10],
  [[], 0, 10],
  [[1, "2"], 0, 10],
  [[1, Number.NaN], 0, 10],
  [[1, Number.POSITIVE_INFINITY], 0, 10],
  [[1, 2], "0", 10],
  [[1, 2], Number.NaN, 10],
  [[1, 2], 0, Number.NEGATIVE_INFINITY],
  [[1, 2], 10, 0]
]) {
  assert.throws(() => boundedMean(...args), TypeError);
}
