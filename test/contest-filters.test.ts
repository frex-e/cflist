import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildContestShowWhere, countCatalogContests, listUserContestResults } from "../src/db/queries.js";
import type { ContestResultRow } from "../src/db/queries.js";
import { migrate } from "../src/db/migrate.js";
import {
  contestTableFilterQuery,
  filterContestTableRows,
  isUnratedContest,
  isUpsolveOnlyContest,
  matchesUpsolvedFilter,
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
  assert.deepEqual(parseContestTableFilters(new URLSearchParams("show=upsolved&page=2")), {
    show: "upsolved",
    page: 2,
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
  assert.equal(contestTableFilterQuery({ show: "upsolved", page: 1, pageSize: 50 }), "?show=upsolved");
  assert.equal(contestTableFilterQuery({ show: "participated", page: 1, pageSize: 50 }), "?show=participated");
  assert.equal(contestTableFilterQuery({ show: "rated", page: 2, pageSize: 50 }), "?show=rated&page=2");
});

test("buildContestShowWhere maps show modes to SQL clauses", () => {
  assert.equal(buildContestShowWhere("all").clause, "");
  assert.match(buildContestShowWhere("upsolved").clause, /upsolved = 1/);
  assert.match(buildContestShowWhere("upsolved").clause, /rank IS NULL/);
  assert.match(buildContestShowWhere("participated").clause, /rank IS NULL/);
  assert.match(buildContestShowWhere("rated").clause, /new_rating IS NOT NULL/);
});

test("contest table filters classify unrated and upsolve-only rows", () => {
  assert.equal(isUnratedContest(row()), false);
  assert.equal(isUnratedContest(row({ new_rating: null, rating_delta: null })), true);
  assert.equal(isUpsolveOnlyContest(row()), false);
  assert.equal(isUpsolveOnlyContest(row({ rank: null, points: null })), true);
  assert.equal(matchesUpsolvedFilter(row()), true);
  assert.equal(matchesUpsolvedFilter(row({ rank: null, points: null })), false);
  assert.equal(
    matchesUpsolvedFilter(row({
      rank: null,
      points: null,
      problems: [{
        contest_id: 1,
        problem_index: "B",
        name: "B",
        url: "",
        rating: null,
        estimated_rating: null,
        solved_in_contest: 0,
        upsolved: 1,
        skipped: 0,
        points: null,
        rejected_attempt_count: null,
        best_submission_time_seconds: null,
      }],
    })),
    true,
  );
});

test("filterContestTableRows applies mutually exclusive show modes", () => {
  const rows = [
    row({ contest_id: 1, contest_name: "Rated" }),
    row({ contest_id: 2, contest_name: "Unrated", new_rating: null, rating_delta: null }),
    row({
      contest_id: 3,
      contest_name: "Upsolve",
      rank: null,
      points: null,
      new_rating: null,
      rating_delta: null,
      problems: [{
        contest_id: 3,
        problem_index: "B",
        name: "B",
        url: "",
        rating: null,
        estimated_rating: null,
        solved_in_contest: 0,
        upsolved: 1,
        skipped: 0,
        points: null,
        rejected_attempt_count: null,
        best_submission_time_seconds: null,
      }],
    }),
  ];

  assert.deepEqual(
    filterContestTableRows(rows, { show: "all", page: 1, pageSize: 50 }).map((item) => item.contest_id),
    [1, 2, 3],
  );
  assert.deepEqual(
    filterContestTableRows(rows, { show: "upsolved", page: 1, pageSize: 50 }).map((item) => item.contest_id),
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

test("listUserContestResults all mode lists every catalog contest with user stats when synced", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const userId = "user-catalog-all";
  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@userId, 'Test User', 'user@example.com', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'inj')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      start_time_seconds,
      derived_label,
      raw_json,
      updated_at
    ) VALUES
      (100, 'Oldest Catalog', 1000, NULL, '{}', '2026-01-01T00:00:00.000Z'),
      (101, 'Synced Rated', 2000, NULL, '{}', '2026-01-01T00:00:00.000Z'),
      (102, 'Synced Unrated', 3000, NULL, '{}', '2026-01-01T00:00:00.000Z'),
      (103, 'Catalog Only', 4000, NULL, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (103, 'A', 'Problem A', '[]', 'https://codeforces.com/contest/103/problem/A', '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
  ).run({ canonicalId: randomUUID() });

  for (const contestId of [101, 102]) {
    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (@contestId, 'A', 'Problem A', '[]', @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
    ).run({
      contestId,
      url: `https://codeforces.com/contest/${contestId}/problem/A`,
      canonicalId: randomUUID(),
    });
  }

  for (const contestId of [101, 102]) {
    db.prepare(
      `
      INSERT INTO user_contest_results (
        user_id,
        contest_id,
        rank,
        points,
        last_checked_at
      ) VALUES (@userId, @contestId, 10, 1, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId, contestId });
  }

  db.prepare(
    `
    UPDATE user_contest_results
    SET new_rating = 1500, rating_delta = 50
    WHERE user_id = @userId AND contest_id = 101
  `,
  ).run({ userId });

  try {
    assert.equal(countCatalogContests(db), 3);

    const { rows, total } = listUserContestResults(db, userId, { show: "all" });
    assert.equal(total, 3);
    assert.deepEqual(rows.map((row) => row.contest_id), [103, 102, 101]);

    const catalogOnly = rows.find((row) => row.contest_id === 103);
    assert.ok(catalogOnly);
    assert.equal(catalogOnly.rank, null);
    assert.equal(catalogOnly.points, null);
    assert.equal(catalogOnly.new_rating, null);
    assert.deepEqual(catalogOnly.problems.map((problem) => problem.problem_index), ["A"]);
    assert.equal(catalogOnly.problems[0]?.upsolved, 0);
    assert.equal(catalogOnly.problems[0]?.solved_in_contest, 0);

    const syncedRated = rows.find((row) => row.contest_id === 101);
    assert.ok(syncedRated);
    assert.equal(syncedRated.rank, 10);
    assert.equal(syncedRated.new_rating, 1500);

    const filtered = listUserContestResults(db, userId, { show: "rated" });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.rows[0]?.contest_id, 101);
  } finally {
    db.close();
  }
});

test("listUserContestResults all mode excludes future catalog contests", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const userId = "user-future-filter";
  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@userId, 'Test User', 'user@example.com', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'inj')
  `,
  ).run({ userId });

  const now = Math.floor(Date.now() / 1000);
  const futureStart = now + 86_400;
  db.prepare(
    `
    INSERT INTO contests (id, name, start_time_seconds, raw_json, updated_at)
    VALUES
      (200, 'Past Contest', @pastStart, '{}', '2026-01-01T00:00:00.000Z'),
      (201, 'Future Contest', @futureStart, '{}', '2026-01-01T00:00:00.000Z'),
      (202, 'Past Without Problems', @pastStart, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run({ pastStart: now - 86_400, futureStart });

  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (200, 'A', 'Problem A', '[]', 'https://codeforces.com/contest/200/problem/A', '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
  `,
  ).run({ canonicalId: randomUUID() });

  try {
    assert.equal(countCatalogContests(db), 1);

    const { rows, total } = listUserContestResults(db, userId, { show: "all" });
    assert.equal(total, 1);
    assert.deepEqual(rows.map((row) => row.contest_id), [200]);
  } finally {
    db.close();
  }
});

test("listUserContestResults all mode falls back to catalog problems for stub user rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const userId = "user-stub-catalog";
  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@userId, 'Test User', 'user@example.com', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'inj')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO contests (id, name, start_time_seconds, raw_json, updated_at)
    VALUES (500, 'Stub Contest', 5000, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES
      (500, 'A', 'Problem A', '[]', 'https://codeforces.com/contest/500/problem/A', '{}', '2026-01-01T00:00:00.000Z', @canonicalA),
      (500, 'B', 'Problem B', '[]', 'https://codeforces.com/contest/500/problem/B', '{}', '2026-01-01T00:00:00.000Z', @canonicalB)
  `,
  ).run({ canonicalA: randomUUID(), canonicalB: randomUUID() });

  db.prepare(
    `
    INSERT INTO user_contest_results (user_id, contest_id, last_checked_at)
    VALUES (@userId, 500, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });

  try {
    const { rows } = listUserContestResults(db, userId, { show: "all" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.problems.map((problem) => problem.problem_index), ["A", "B"]);
    assert.equal(rows[0]?.problems[0]?.solved_in_contest, 0);
  } finally {
    db.close();
  }
});

test("listUserContestResults all mode sorts catalog problem pills by index", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const userId = "user-problem-order";
  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@userId, 'Test User', 'user@example.com', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'inj')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO contests (id, name, start_time_seconds, raw_json, updated_at)
    VALUES (600, 'Ordered Round', 1000, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  for (const index of ["F", "E", "D", "C", "B", "A", "I1", "I2"]) {
    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (600, @index, @name, '[]', @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
    ).run({
      index,
      name: `Problem ${index}`,
      url: `https://codeforces.com/contest/600/problem/${index}`,
      canonicalId: randomUUID(),
    });
  }

  try {
    const { rows } = listUserContestResults(db, userId, { show: "all" });
    assert.equal(rows.length, 1);
    assert.deepEqual(
      rows[0]?.problems.map((problem) => problem.problem_index),
      ["A", "B", "C", "D", "E", "F", "I1", "I2"],
    );
  } finally {
    db.close();
  }
});
