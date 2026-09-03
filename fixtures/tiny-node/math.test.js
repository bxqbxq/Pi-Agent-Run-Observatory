import assert from "node:assert/strict";
import { test } from "node:test";
import { add, clamp } from "./math.js";

test("add sums two numbers", () => assert.equal(add(2, 3), 5));
test("clamp keeps values in range", () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(11, 0, 10), 10);
});
