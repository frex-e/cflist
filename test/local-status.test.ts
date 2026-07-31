import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustSummaryCounts,
  formatSummaryCounts,
  nextLocalStatusValue,
  parseSummaryText,
  readLocalStatusView,
  statusAfterOverride,
  statusMatchesSolvedFilter,
} from "../src/views/problems/local-status.js";

test("local status cycles unsolved → skipped → solved → unsolved", () => {
  assert.equal(nextLocalStatusValue("unsolved"), "skipped");
  assert.equal(nextLocalStatusValue("skipped"), "solved");
  assert.equal(nextLocalStatusValue("solved"), "");

  assert.equal(statusAfterOverride("skipped"), "skipped");
  assert.equal(statusAfterOverride("solved"), "solved");
  assert.equal(statusAfterOverride(""), "unsolved");
});

test("readLocalStatusView prefers manual solved over skipped", () => {
  assert.equal(readLocalStatusView({ solved_override: 1, skipped: 1 }), "solved");
  assert.equal(readLocalStatusView({ solved_override: null, skipped: 1 }), "skipped");
  assert.equal(readLocalStatusView({ solved_override: null, skipped: 0 }), "unsolved");
});

test("solved filter visibility matches list filters", () => {
  assert.equal(statusMatchesSolvedFilter("all", "skipped"), true);
  assert.equal(statusMatchesSolvedFilter("unsolved", "skipped"), false);
  assert.equal(statusMatchesSolvedFilter("skipped", "skipped"), true);
  assert.equal(statusMatchesSolvedFilter("solved", "solved"), true);
  assert.equal(statusMatchesSolvedFilter("solved", "unsolved"), false);
});

test("summary counts stay in place when filter keeps the row", () => {
  const next = adjustSummaryCounts(
    { total: 10, solved: 3, skipped: 2, unsolved: 5 },
    "unsolved",
    "skipped",
    "all",
  );
  assert.deepEqual(next, { total: 10, solved: 3, skipped: 3, unsolved: 4 });
});

test("summary counts drop the row when the filter excludes the new status", () => {
  const next = adjustSummaryCounts(
    { total: 5, solved: 0, skipped: 0, unsolved: 5 },
    "unsolved",
    "skipped",
    "unsolved",
  );
  assert.deepEqual(next, { total: 4, solved: 0, skipped: 0, unsolved: 4 });
});

test("summary text round-trips through parse and format", () => {
  const text = formatSummaryCounts(
    { total: 11245, solved: 1000, skipped: 12, unsolved: 10233 },
    "inj",
    (value) => new Intl.NumberFormat("en").format(value),
  );
  assert.equal(
    text,
    "11,245 matched, 1,000 solved, 12 skipped, 10,233 unsolved for inj",
  );
  assert.deepEqual(parseSummaryText(text), {
    counts: { total: 11245, solved: 1000, skipped: 12, unsolved: 10233 },
    cfHandle: "inj",
  });
});
