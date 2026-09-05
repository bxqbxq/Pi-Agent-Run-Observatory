import assert from "node:assert/strict";
import { add, allocateByWeight, clamp } from "../../math.js";

assert.equal(add(2, 3), 5);
assert.equal(clamp(11, 0, 10), 10);
assert.deepEqual(allocateByWeight(10, [1, 1, 1]), [4, 3, 3]);
assert.deepEqual(allocateByWeight(7, [1, 2]), [2, 5]);
assert.deepEqual(allocateByWeight(11, [5, 3, 2]), [6, 3, 2]);
assert.deepEqual(allocateByWeight(5, [1, 3, 1]), [1, 3, 1]);
assert.deepEqual(allocateByWeight(2, [1, 1, 1, 1]), [1, 1, 0, 0]);
assert.deepEqual(allocateByWeight(0, [2, 3]), [0, 0]);

const weights = [1, 2, 3];
const snapshot = [...weights];
const allocation = allocateByWeight(17, weights);
assert.deepEqual(weights, snapshot, "allocateByWeight must not mutate weights");
assert.equal(allocation.reduce((sum, value) => sum + value, 0), 17);
assert.equal(allocation.every((value) => Number.isInteger(value) && value >= 0), true);

for (const args of [
  [-1, [1]],
  [1.5, [1]],
  [Number.NaN, [1]],
  [1, "1"],
  [1, []],
  [1, [0]],
  [1, [-1]],
  [1, [Number.NaN]],
  [1, [Number.POSITIVE_INFINITY]],
  [1, ["1"]]
]) {
  assert.throws(() => allocateByWeight(...args), TypeError);
}
