import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  linkCanonicalIdsByRoundPairs,
  propagateCanonicalSolvedCounts,
  refreshRoundPairs,
} from "../src/cf/sync/canonical-problems.js";
import { migrate } from "../src/db/migrate.js";

const insertContest = (
  db: DatabaseSync,
  id: number,
  division: "Div. 1" | "Div. 2",
  startTimeSeconds: number,
): void => {
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
    ) VALUES (
      @id,
      @name,
      @startTimeSeconds,
      'Codeforces Round',
      @division,
      @name,
      '{}',
      '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({
    id,
    name: `Codeforces Round (${division})`,
    startTimeSeconds,
    division,
  });
};

const insertProblem = (
  db: DatabaseSync,
  contestId: number,
  problemIndex: string,
  name: string,
  canonicalId: string,
  solvedCount: number | null = 100,
): void => {
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
      updated_at,
      canonical_id
    ) VALUES (
      @contestId,
      @problemIndex,
      @name,
      1500,
      @solvedCount,
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
    solvedCount,
    url: `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`,
    canonicalId,
  });
};

test("refreshRoundPairs pairs Div. 1 and Div. 2 when Div. 2 has the higher id", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    insertContest(db, 1205, "Div. 1", 1_700_000_000);
    insertContest(db, 1206, "Div. 2", 1_700_000_000);

    refreshRoundPairs(db);

    const pair = db
      .prepare(
        `
        SELECT contest_id_low AS lowId, contest_id_high AS highId
        FROM contest_round_pairs
      `,
      )
      .get() as { lowId: number; highId: number } | undefined;

    assert.equal(pair?.lowId, 1205);
    assert.equal(pair?.highId, 1206);
  } finally {
    db.close();
  }
});

test("linkCanonicalIdsByRoundPairs merges same-named problems across paired rounds", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    insertContest(db, 1205, "Div. 1", 1_700_000_000);
    insertContest(db, 1206, "Div. 2", 1_700_000_000);
    insertProblem(db, 1205, "A", "Shared Task", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    insertProblem(db, 1206, "C", "Shared Task", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    insertProblem(db, 1206, "D", "Solo Task", "cccccccc-cccc-cccc-cccc-cccccccccccc");

    refreshRoundPairs(db);
    linkCanonicalIdsByRoundPairs(db);

    const shared = db
      .prepare(
        `
        SELECT canonical_id AS canonicalId
        FROM problems
        WHERE name = 'Shared Task'
        ORDER BY contest_id
      `,
      )
      .all() as { canonicalId: string }[];
    const solo = db
      .prepare(`SELECT canonical_id AS canonicalId FROM problems WHERE name = 'Solo Task'`)
      .get() as { canonicalId: string };

    assert.equal(shared.length, 2);
    assert.equal(shared[0]?.canonicalId, shared[1]?.canonicalId);
    assert.equal(shared[0]?.canonicalId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert.equal(solo.canonicalId, "cccccccc-cccc-cccc-cccc-cccccccccccc");
  } finally {
    db.close();
  }
});

test("linkCanonicalIdsByRoundPairs merges skipped overrides across paired rounds", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    insertContest(db, 1205, "Div. 1", 1_700_000_000);
    insertContest(db, 1206, "Div. 2", 1_700_000_000);
    insertProblem(db, 1205, "A", "Shared Task", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    insertProblem(db, 1206, "C", "Shared Task", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    db.prepare(
      `
      INSERT INTO "user" (
        id, name, email, emailVerified, createdAt, updatedAt, cfHandle
      ) VALUES (
        'user-1', 'Test', 'test@example.com', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tourist'
      )
    `,
    ).run();

    db.prepare(
      `
      INSERT INTO user_problem_overrides (
        user_id, canonical_id, solved_override, skipped, note, updated_at
      ) VALUES (
        'user-1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL, 1, NULL, '2026-01-01T00:00:00.000Z'
      )
    `,
    ).run();

    refreshRoundPairs(db);
    linkCanonicalIdsByRoundPairs(db);

    const override = db
      .prepare(
        `
        SELECT canonical_id AS canonicalId, skipped, solved_override AS solvedOverride
        FROM user_problem_overrides
        WHERE user_id = 'user-1'
      `,
      )
      .get() as { canonicalId: string; skipped: number; solvedOverride: number | null };

    assert.equal(override.canonicalId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert.equal(override.skipped, 1);
    assert.equal(override.solvedOverride, null);
  } finally {
    db.close();
  }
});

test("linkCanonicalIdsByRoundPairs copies catalog solved counts onto standings-only siblings", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    insertContest(db, 2255, "Div. 1", 1_700_000_000);
    insertContest(db, 2256, "Div. 2", 1_700_000_000);
    insertProblem(db, 2255, "A", "Hot Potatoes", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 13124);
    insertProblem(db, 2256, "C", "Hot Potatoes", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null);
    insertProblem(db, 2256, "A", "Solo Task", "cccccccc-cccc-cccc-cccc-cccccccccccc", 24367);

    refreshRoundPairs(db);
    linkCanonicalIdsByRoundPairs(db);

    const shared = db
      .prepare(
        `
        SELECT contest_id AS contestId, problem_index AS problemIndex, solved_count AS solvedCount
        FROM problems
        WHERE name = 'Hot Potatoes'
        ORDER BY contest_id
      `,
      )
      .all() as { contestId: number; problemIndex: string; solvedCount: number | null }[];
    const solo = db
      .prepare(`SELECT solved_count AS solvedCount FROM problems WHERE contest_id = 2256 AND problem_index = 'A'`)
      .get() as { solvedCount: number };

    assert.equal(shared.length, 2);
    assert.equal(shared[0]?.contestId, 2255);
    assert.equal(shared[0]?.problemIndex, "A");
    assert.equal(shared[0]?.solvedCount, 13124);
    assert.equal(shared[1]?.contestId, 2256);
    assert.equal(shared[1]?.problemIndex, "C");
    assert.equal(shared[1]?.solvedCount, 13124);
    assert.equal(solo.solvedCount, 24367);
  } finally {
    db.close();
  }
});

test("propagateCanonicalSolvedCounts updates already-linked siblings when catalog counts change", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    insertContest(db, 2255, "Div. 1", 1_700_000_000);
    insertContest(db, 2256, "Div. 2", 1_700_000_000);
    insertProblem(db, 2255, "A", "Hot Potatoes", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 14000);
    insertProblem(db, 2256, "C", "Hot Potatoes", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 13124);

    propagateCanonicalSolvedCounts(db);

    const counts = db
      .prepare(
        `
        SELECT contest_id AS contestId, solved_count AS solvedCount
        FROM problems
        ORDER BY contest_id
      `,
      )
      .all() as { contestId: number; solvedCount: number }[];

    assert.equal(counts.length, 2);
    assert.equal(counts[0]?.contestId, 2255);
    assert.equal(counts[0]?.solvedCount, 14000);
    assert.equal(counts[1]?.contestId, 2256);
    assert.equal(counts[1]?.solvedCount, 14000);
  } finally {
    db.close();
  }
});

