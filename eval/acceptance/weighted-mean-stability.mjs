import assert from "node:assert/strict";
import { add, clamp, weightedMean } from "../../math.js";

function close(actual, expected, tolerance = 1e-12) {
  assert.equal(Number.isFinite(actual), true, `expected a finite result, received ${actual}`);
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance * scale, `${actual} is not close to ${expected}`);
}

assert.equal(add(2, 3), 5);
assert.equal(clamp(11, 0, 10), 10);
close(weightedMean([10, 20], [1, 3]), 17.5);
close(weightedMean([10, 20], [Number.MAX_VALUE, Number.MAX_VALUE]), 15);
close(weightedMean([0, 30], [Number.MAX_VALUE, Number.MAX_VALUE / 2]), 10);
close(weightedMean([10, 20], [Number.MIN_VALUE, Number.MIN_VALUE]), 15);
assert.equal(weightedMean([Number.MAX_VALUE, Number.MAX_VALUE], [1, 1]), Number.MAX_VALUE);
assert.equal(weightedMean([Number.MAX_VALUE, -Number.MAX_VALUE], [1, 1]), 0);
assert.equal(weightedMean([Number.MIN_VALUE, Number.MIN_VALUE], [1, 1]), Number.MIN_VALUE);

const values = [10, 20, 30];
const weights = [1, 2, 3];
const valuesSnapshot = [...values];
const weightsSnapshot = [...weights];
close(weightedMean(values, weights), 140 / 6);
assert.deepEqual(values, valuesSnapshot, "weightedMean must not mutate values");
assert.deepEqual(weights, weightsSnapshot, "weightedMean must not mutate weights");

for (const args of [
  ["1", [1]],
  [[1], "1"],
  [[], []],
  [[1], [1, 2]],
  [[Number.NaN], [1]],
  [[Number.POSITIVE_INFINITY], [1]],
  [[1], [0]],
  [[1], [-1]],
  [[1], [Number.NaN]],
  [[1], [Number.POSITIVE_INFINITY]],
  [[1], ["1"]]
]) {
  assert.throws(() => weightedMean(...args), TypeError);
}
