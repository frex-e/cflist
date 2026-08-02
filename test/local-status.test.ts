import assert from "node:assert/strict";
import test from "node:test";
import { nextLocalStatusValue, readLocalStatusView } from "../src/views/problems/local-status.js";

test("local status cycles unsolved → skipped → solved → unsolved", () => {
  assert.equal(nextLocalStatusValue("unsolved"), "skipped");
  assert.equal(nextLocalStatusValue("skipped"), "solved");
  assert.equal(nextLocalStatusValue("solved"), "");
});

test("readLocalStatusView prefers manual solved over skipped", () => {
  assert.equal(readLocalStatusView({ solved_override: 1, skipped: 1 }), "solved");
  assert.equal(readLocalStatusView({ solved_override: null, skipped: 1 }), "skipped");
  assert.equal(readLocalStatusView({ solved_override: null, skipped: 0 }), "unsolved");
});
