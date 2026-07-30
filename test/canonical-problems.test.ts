import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  linkCanonicalIdsByRoundPairs,
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
      100,
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
