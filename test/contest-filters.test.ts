import assert from "node:assert/strict";
import test from "node:test";
import { buildContestShowWhere } from "../src/db/queries.js";
import type { ContestResultRow } from "../src/db/queries.js";
import {
  contestTableFilterQuery,
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

test("parseContestTableFilters reads show mode and page from query params", () => {
  assert.deepEqual(parseContestTableFilters(new URLSearchParams()), {
    show: "all",
    page: 1,
    pageSize: 50,
  });
  assert.deepEqual(parseContestTableFilters(new URLSearchParams("show=participated")), {
    show: "participated",
    page: 1,
    pageSize: 50,
  });
  assert.deepEqual(parseContestTableFilters(new URLSearchParams("show=rated&page=3")), {
    show: "rated",
    page: 3,
    pageSize: 50,
  });
  assert.deepEqual(parseContestTableFilters(new URLSearchParams("show=invalid&page=0")), {
    show: "all",
    page: 1,
    pageSize: 50,
  });
});

test("contestTableFilterQuery omits defaults and serializes active filters", () => {
  assert.equal(contestTableFilterQuery({ show: "all", page: 1, pageSize: 50 }), "");
  assert.equal(contestTableFilterQuery({ show: "participated", page: 1, pageSize: 50 }), "?show=participated");
  assert.equal(contestTableFilterQuery({ show: "rated", page: 2, pageSize: 50 }), "?show=rated&page=2");
});

test("buildContestShowWhere maps show modes to SQL clauses", () => {
  assert.equal(buildContestShowWhere("all").clause, "");
  assert.match(buildContestShowWhere("participated").clause, /rank IS NULL/);
  assert.match(buildContestShowWhere("rated").clause, /new_rating IS NOT NULL/);
});

test("contest table filters classify unrated and upsolve-only rows", () => {
  assert.equal(isUnratedContest(row()), false);
  assert.equal(isUnratedContest(row({ new_rating: null, rating_delta: null })), true);
  assert.equal(isUpsolveOnlyContest(row()), false);
  assert.equal(isUpsolveOnlyContest(row({ rank: null, points: null })), true);
});

test("filterContestTableRows applies mutually exclusive show modes", () => {
  const rows = [
    row({ contest_id: 1, contest_name: "Rated" }),
    row({ contest_id: 2, contest_name: "Unrated", new_rating: null, rating_delta: null }),
    row({ contest_id: 3, contest_name: "Upsolve", rank: null, points: null, new_rating: null, rating_delta: null }),
  ];

  assert.deepEqual(
    filterContestTableRows(rows, { show: "all", page: 1, pageSize: 50 }).map((item) => item.contest_id),
    [1, 2, 3],
  );
  assert.deepEqual(
    filterContestTableRows(rows, { show: "participated", page: 1, pageSize: 50 }).map((item) => item.contest_id),
    [1, 2],
  );
  assert.deepEqual(
    filterContestTableRows(rows, { show: "rated", page: 1, pageSize: 50 }).map((item) => item.contest_id),
    [1],
  );
});
