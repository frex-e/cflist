import assert from "node:assert/strict";
import test from "node:test";
import { classifyContest } from "../src/cf/classify.js";

test("classifies Codeforces Round divisions", () => {
  const result = classifyContest({
    id: 1900,
    name: "Codeforces Round 900 (Div. 3)",
    startTimeSeconds: 1700000000,
  });

  assert.equal(result.family, "Codeforces Round");
  assert.equal(result.division, "Div. 3");
  assert.equal(result.label, "Codeforces Round (Div. 3)");
  assert.equal(result.year, 2023);
});

test("classifies educational rounds", () => {
  const result = classifyContest({
    id: 1901,
    name: "Educational Codeforces Round 160 (Rated for Div. 2)",
  });

  assert.equal(result.family, "Educational");
  assert.equal(result.division, "Div. 2");
});

test("falls back to unknown division", () => {
  const result = classifyContest({
    id: 1902,
    name: "Codeforces Global Round 26",
  });

  assert.equal(result.family, "Global");
  assert.equal(result.division, "Unknown");
});

