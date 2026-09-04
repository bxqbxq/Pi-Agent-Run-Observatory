import assert from "node:assert/strict";
import { average } from "../../math.js";

assert.equal(average([2, 4, 6]), 4);
assert.equal(average([-2, 2]), 0);
assert.throws(() => average([]), TypeError);
assert.throws(() => average([1, "2"]), TypeError);
assert.throws(() => average("123"), TypeError);
