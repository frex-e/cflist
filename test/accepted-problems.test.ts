import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  acceptedProblemsFromDb,
  expandAcceptedProblemsByCanonicalId,
  problemKey,
  type AcceptedProblem,
} from "../src/cf/accepted-problems.js";
import { migrate } from "../src/db/migrate.js";

const userId = "user-1";
const canonicalId = "11111111-1111-1111-1111-111111111111";

const insertProblem = (
  db: DatabaseSync,
  contestId: number,
  problemIndex: string,
  name: string,
  problemCanonicalId: string,
): void => {
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
    ) VALUES (
      @contestId,
      @problemIndex,
      @name,
      '[]',
      @url,
      '{}',
      '2026-01-01T00:00:00.000Z',
      @canonicalId
    )
  `,
  ).run({
    contestId,
    problemIndex,
    name,
    url: `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`,
    canonicalId: problemCanonicalId,
  });
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
      duration_seconds,
      start_time_seconds,
      derived_division,
      raw_json,
      updated_at
    ) VALUES
      (2219, 'Codeforces Round (Div. 1)', 7200, 1760000000, 'Div. 1', '{}', '2026-01-01T00:00:00.000Z'),
      (2220, 'Codeforces Round (Div. 2)', 7200, 1760000000, 'Div. 2', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
  insertProblem(db, 2219, "A", "Shared Task", canonicalId);
  insertProblem(db, 2220, "C", "Shared Task", canonicalId);
  insertProblem(db, 2220, "D", "Different Task", "22222222-2222-2222-2222-222222222222");

  try {
    fn(db);
  } finally {
    db.close();
  }
};

test("accepted problems expand to every placement with the same canonical id", () => {
  withDb((db) => {
    const acceptedAt = 1_760_000_060;
    const source: AcceptedProblem = {
      contestId: 2219,
      problemIndex: "A",
      firstSubmissionId: 10,
      firstAcceptedAtSeconds: acceptedAt,
      acceptedCount: 1,
    };
    const expanded = expandAcceptedProblemsByCanonicalId(
      db,
      new Map([[problemKey(source.contestId, source.problemIndex), source]]),
    );

    assert.deepEqual([...expanded.keys()].sort(), ["2219:A", "2220:C"]);
    assert.deepEqual(expanded.get("2220:C"), {
      ...source,
      contestId: 2220,
      problemIndex: "C",
    });
    assert.equal(expanded.has("2220:D"), false);
  });
});

test("database accepted status expands canonically for queued contest hydration", () => {
  withDb((db) => {
    db.prepare(
      `
      INSERT INTO user_problem_status (
        user_id,
        contest_id,
        problem_index,
        solved,
        first_accepted_submission_id,
        first_accepted_at_seconds,
        accepted_count,
        last_checked_at
      ) VALUES (
        @userId,
        2219,
        'A',
        1,
        10,
        1760007300,
        1,
        '2026-01-01T00:00:00.000Z'
      )
    `,
    ).run({ userId });

    const accepted = acceptedProblemsFromDb(db, userId);

    assert.equal(accepted.get("2219:A")?.firstAcceptedAtSeconds, 1_760_007_300);
    assert.equal(accepted.get("2220:C")?.firstAcceptedAtSeconds, 1_760_007_300);
    assert.equal(accepted.has("2220:D"), false);
  });
});
