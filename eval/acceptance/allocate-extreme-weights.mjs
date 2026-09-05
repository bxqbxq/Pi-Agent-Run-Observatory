import assert from "node:assert/strict";
import { add, allocateByWeight, clamp } from "../../math.js";

assert.equal(add(2, 3), 5);
assert.equal(clamp(11, 0, 10), 10);

assert.deepEqual(allocateByWeight(10, [1, 1, 1]), [4, 3, 3]);
assert.deepEqual(allocateByWeight(3, [Number.MAX_VALUE, Number.MAX_VALUE]), [2, 1]);
assert.deepEqual(allocateByWeight(6, [Number.MAX_VALUE, Number.MAX_VALUE / 2]), [4, 2]);
assert.deepEqual(allocateByWeight(7, [Number.MAX_VALUE, Number.MAX_VALUE / 2, Number.MAX_VALUE / 4]), [4, 2, 1]);
assert.deepEqual(allocateByWeight(5, [Number.MIN_VALUE, Number.MIN_VALUE]), [3, 2]);
assert.deepEqual(allocateByWeight(1, [Number.MAX_VALUE, Number.MIN_VALUE]), [1, 0]);

const weights = [Number.MAX_VALUE, Number.MAX_VALUE / 2];
const snapshot = [...weights];
const allocation = allocateByWeight(17, weights);
assert.deepEqual(weights, snapshot, "allocateByWeight must not mutate weights");
assert.equal(allocation.reduce((sum, value) => sum + value, 0), 17);
assert.equal(allocation.every((value) => Number.isSafeInteger(value) && value >= 0), true);

for (const args of [
  [-1, [1]],
  [1.5, [1]],
  [Number.MAX_SAFE_INTEGER + 1, [1]],
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
