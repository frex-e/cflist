import assert from "node:assert/strict";
import test from "node:test";
import type { ContestResultRow } from "../src/db/queries.js";
import {
  filterContestTableRows,
  isUnratedContest,
  isUpsolveOnlyContest,
  parseContestTableFilters,
} from "../src/views/contests/filters.js";

const row = (overrides: Partial<ContestResultRow> = {}): ContestResultRow => ({
  contest_id: 1,
  contest_name: "Test",
  start_time_seconds: 1_000,
  derived_label: null,
  rank: 10,
  points: 2,
  penalty: 0,
  participant_type: "CONTESTANT",
  old_rating: 1500,
  new_rating: 1550,
  rating_delta: 50,
  performance: 1600,
  problems: [],
  ...overrides,
});

test("parseContestTableFilters reads hide flags from query params", () => {
  assert.deepEqual(parseContestTableFilters(new URLSearchParams()), {
    hideUnrated: false,
    hideUpsolveOnly: false,
  });
  assert.deepEqual(parseContestTableFilters(new URLSearchParams("hideUnrated=1")), {
    hideUnrated: true,
    hideUpsolveOnly: false,
  });
  assert.deepEqual(parseContestTableFilters(new URLSearchParams("hideUpsolve=1")), {
    hideUnrated: false,
    hideUpsolveOnly: true,
  });
});

test("contest table filters classify unrated and upsolve-only rows", () => {
  assert.equal(isUnratedContest(row()), false);
  assert.equal(isUnratedContest(row({ new_rating: null, rating_delta: null })), true);
  assert.equal(isUpsolveOnlyContest(row()), false);
  assert.equal(isUpsolveOnlyContest(row({ rank: null, points: null })), true);
});

test("filterContestTableRows hides selected contest categories", () => {
  const rows = [
    row({ contest_id: 1, contest_name: "Rated" }),
    row({ contest_id: 2, contest_name: "Unrated", new_rating: null, rating_delta: null }),
    row({ contest_id: 3, contest_name: "Upsolve", rank: null, points: null, new_rating: null, rating_delta: null }),
  ];

  assert.deepEqual(
    filterContestTableRows(rows, { hideUnrated: true, hideUpsolveOnly: false }).map((item) => item.contest_id),
    [1],
  );
  assert.deepEqual(
    filterContestTableRows(rows, { hideUnrated: false, hideUpsolveOnly: true }).map((item) => item.contest_id),
    [1, 2],
  );
  assert.deepEqual(
    filterContestTableRows(rows, { hideUnrated: true, hideUpsolveOnly: true }).map((item) => item.contest_id),
    [1],
  );
});
