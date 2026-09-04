import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readme = (await readFile("README.md", "utf8")).toLowerCase();
for (const required of ["add", "clamp", "npm test"]) {
  assert.ok(readme.includes(required), `README.md must mention ${required}`);
}
