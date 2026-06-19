import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listProblems, listUserContestResults, type ProblemFilters } from "../src/db/queries.js";
import { migrate } from "../src/db/migrate.js";

const userId = "user-1";

const filters = (overrides: Partial<ProblemFilters> = {}): ProblemFilters => ({
  tags: [],
  tagMode: "any",
  divisions: [],
  solved: "all",
  showTags: false,
  sort: "contest",
  sortDirection: "desc",
  page: 1,
  pageSize: 50,
  userId,
  cfHandle: "tourist",
  ...overrides,
});

const insertProblem = (
  db: DatabaseSync,
  contestId: number,
  problemIndex: string,
  name: string,
  rating: number,
): void => {
  const tags = JSON.stringify(["graphs"]);
  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at
    ) VALUES (
      @contestId,
      @problemIndex,
      @name,
      @rating,
      100,
      @tags,
      @url,
      '{}',
      '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({
    contestId,
    problemIndex,
    name,
    rating,
    tags,
    url: `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`,
  });

  db.prepare(
    `
    INSERT INTO problem_tags (contest_id, problem_index, tag)
    VALUES (@contestId, @problemIndex, 'graphs')
  `,
  ).run({ contestId, problemIndex });
};

const withDb = (fn: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@userId, 'Test User', 'user@example.com', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tourist')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      start_time_seconds,
      derived_family,
      derived_division,
      derived_label,
      raw_json,
      updated_at
    ) VALUES
      (2219, 'Codeforces Round (Div. 1)', 1760000000, 'Codeforces Round', 'Div. 1', 'Codeforces Round (Div. 1)', '{}', '2026-01-01T00:00:00.000Z'),
      (2220, 'Codeforces Round (Div. 2)', 1760003600, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  insertProblem(db, 2219, "A", "Grid L", 1400);
  insertProblem(db, 2220, "C", "Grid L", 1400);
  insertProblem(db, 2220, "D", "Different Problem", 1600);

  try {
    fn(db);
  } finally {
    db.close();
  }
};

test("problem list collapses shared contest aliases into one displayed row", () => {
  withDb((db) => {
    db.prepare(
      `
      INSERT INTO user_problem_status (
        user_id,
        cf_handle,
        contest_id,
        problem_index,
        solved,
        accepted_count,
        last_checked_at
      ) VALUES (@userId, 'tourist', 2219, 'A', 1, 1, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId });

    const result = listProblems(db, filters());
    const gridRows = result.rows.filter((row) => row.name === "Grid L");

    assert.equal(result.total, 2);
    assert.equal(gridRows.length, 1);
    assert.equal(gridRows[0]?.contest_id, 2220);
    assert.equal(gridRows[0]?.problem_index, "C");
    assert.equal(gridRows[0]?.cf_solved, 1);
    assert.equal(gridRows[0]?.effective_solved, 1);

    const unsolved = listProblems(db, filters({ solved: "unsolved" }));
    assert.deepEqual(unsolved.rows.map((row) => row.name), ["Different Problem"]);
  });
});

test("problem list keeps the matching alias when filters narrow to one contest division", () => {
  withDb((db) => {
    const result = listProblems(db, filters({ divisions: ["Div. 1"] }));

    assert.equal(result.total, 1);
    assert.equal(result.rows[0]?.contest_id, 2219);
    assert.equal(result.rows[0]?.problem_index, "A");
  });
});

test("problem list search matches contest names", () => {
  withDb((db) => {
    const result = listProblems(db, filters({ q: "Div. 1" }));

    assert.equal(result.total, 1);
    assert.equal(result.rows[0]?.contest_id, 2219);
    assert.equal(result.rows[0]?.contest_name, "Codeforces Round (Div. 1)");
  });
});

test("contest result listing keeps contest-specific problem placements", () => {
  withDb((db) => {
    for (const contestId of [2219, 2220]) {
      db.prepare(
        `
        INSERT INTO user_contest_results (
          user_id,
          cf_handle,
          contest_id,
          points,
          last_checked_at
        ) VALUES (@userId, 'tourist', @contestId, 1, '2026-01-01T00:00:00.000Z')
      `,
      ).run({ userId, contestId });
    }

    db.prepare(
      `
      INSERT INTO user_contest_problem_results (user_id, contest_id, problem_index, solved_in_contest, upsolved)
      VALUES
        (@userId, 2219, 'A', 1, 0),
        (@userId, 2220, 'C', 1, 0)
    `,
    ).run({ userId });

    const { rows } = listUserContestResults(db, userId);
    const placements = rows.flatMap((row) => row.problems.map((problem) => `${problem.contest_id}${problem.problem_index}`));

    assert.deepEqual(placements, ["2220C", "2219A"]);
  });
});
