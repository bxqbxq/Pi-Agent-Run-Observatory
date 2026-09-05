import assert from "node:assert/strict";
import { add, clamp, weightedMean } from "../../math.js";

function close(actual, expected, tolerance = 1e-12) {
  assert.equal(Number.isFinite(actual), true, `expected a finite result, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not close to ${expected}`);
}

assert.equal(add(2, 3), 5);
assert.equal(clamp(11, 0, 10), 10);
close(weightedMean([10, 20], [1, 3]), 17.5);
close(weightedMean([10, 20], [Number.MAX_VALUE, Number.MAX_VALUE]), 15);
close(weightedMean([0, 30], [Number.MAX_VALUE, Number.MAX_VALUE / 2]), 10);
close(weightedMean([10, 20], [Number.MIN_VALUE, Number.MIN_VALUE]), 15);
close(weightedMean([10, 20], [Number.MAX_VALUE, Number.MIN_VALUE]), 10);

const values = [10, 20, 30];
const weights = [Number.MAX_VALUE, Number.MAX_VALUE / 2, Number.MAX_VALUE / 4];
const valuesSnapshot = [...values];
const weightsSnapshot = [...weights];
close(weightedMean(values, weights), 110 / 7);
assert.deepEqual(values, valuesSnapshot);
assert.deepEqual(weights, weightsSnapshot);

for (const args of [
  ["1", [1]], [[1], "1"], [[], []], [[1], [1, 2]],
  [[Number.NaN], [1]], [[1000001], [1]], [[-1000001], [1]],
  [[1], [0]], [[1], [-1]], [[1], [Number.NaN]], [[1], [Number.POSITIVE_INFINITY]]
]) {
  assert.throws(() => weightedMean(...args), TypeError);
}
