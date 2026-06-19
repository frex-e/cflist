import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFilters } from "../src/db/queries.js";
import { safeReturnTo, safeReturnToWithDefault } from "../src/http/return-to.js";

test("normalizeFilters defaults invalid values safely", () => {
  const filters = normalizeFilters(new URLSearchParams("page=abc&sort=invalid&solved=maybe"), "user-1", "tourist");
  assert.equal(filters.page, 1);
  assert.equal(filters.sort, "contest");
  assert.equal(filters.solved, "all");
  assert.equal(filters.tagMode, "any");
});

test("normalizeFilters preserves explicit multi-select values", () => {
  const params = new URLSearchParams();
  params.append("division", "Div. 2");
  params.append("division", "Div. 3");
  params.append("tags", "dp");
  params.append("tags", "graphs");
  params.set("tagMode", "all");

  const filters = normalizeFilters(params, "user-1", "tourist");
  assert.deepEqual(filters.divisions, ["Div. 2", "Div. 3"]);
  assert.deepEqual(filters.tags, ["dp", "graphs"]);
  assert.equal(filters.tagMode, "all");
});

test("safeReturnTo rejects external redirects", () => {
  assert.equal(safeReturnTo("//evil.test/phish"), undefined);
  assert.equal(safeReturnTo("https://evil.test"), undefined);
  assert.equal(safeReturnTo("/\\evil.test"), undefined);
  assert.equal(safeReturnTo("/problems?solved=unsolved"), "/problems?solved=unsolved");
});

test("safeReturnToWithDefault falls back to /problems", () => {
  assert.equal(safeReturnToWithDefault(undefined), "/problems");
  assert.equal(safeReturnToWithDefault("/contests"), "/contests");
});
