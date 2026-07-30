import { randomUUID } from "node:crypto";
import type { Db } from "../../db/connection.js";
import { transaction } from "../../db/connection.js";

export const refreshRoundPairs = (db: Db): void => {
  const columns = db.prepare(`PRAGMA table_info(contests)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === "start_time_seconds")) return;
  if (!columns.some((column) => column.name === "derived_division")) return;

  db.exec("DELETE FROM contest_round_pairs");
  db.exec(`
    INSERT INTO contest_round_pairs (contest_id_low, contest_id_high, start_time_seconds)
    SELECT
      CASE WHEN d1.id < d2.id THEN d1.id ELSE d2.id END,
      CASE WHEN d1.id < d2.id THEN d2.id ELSE d1.id END,
      d1.start_time_seconds
    FROM contests d1
    JOIN contests d2
      ON d2.start_time_seconds = d1.start_time_seconds
      AND d1.id != d2.id
    WHERE d1.derived_division = 'Div. 1'
      AND d2.derived_division = 'Div. 2'
      AND d1.start_time_seconds IS NOT NULL
  `);
};

export const getPairedContestId = (db: Db, contestId: number): number | undefined => {
  const row = db
    .prepare(
      `
      SELECT contest_id_high AS pairedId
      FROM contest_round_pairs
      WHERE contest_id_low = @contestId
      UNION ALL
      SELECT contest_id_low AS pairedId
      FROM contest_round_pairs
      WHERE contest_id_high = @contestId
      LIMIT 1
    `,
    )
    .get({ contestId }) as { pairedId: number } | undefined;
  return row?.pairedId;
};

export const lookupCanonicalIdByNameInContest = (
  db: Db,
  contestId: number,
  name: string,
): string | undefined => {
  const row = db
    .prepare(
      `
      SELECT canonical_id AS canonicalId
      FROM problems
      WHERE contest_id = @contestId AND name = @name
      LIMIT 1
    `,
    )
    .get({ contestId, name }) as { canonicalId: string } | undefined;
  return row?.canonicalId;
};

export const resolveCanonicalIdForUpsert = (
  db: Db,
  contestId: number,
  problemIndex: string,
  name: string,
  source: "catalog" | "standings",
): string => {
  const existing = db
    .prepare(
      `
      SELECT canonical_id AS canonicalId
      FROM problems
      WHERE contest_id = @contestId AND problem_index = @problemIndex
    `,
    )
    .get({ contestId, problemIndex }) as { canonicalId: string } | undefined;

  if (existing?.canonicalId) return existing.canonicalId;

  if (source === "standings") {
    const pairedId = getPairedContestId(db, contestId);
    if (pairedId !== undefined) {
      const partnerCanonicalId = lookupCanonicalIdByNameInContest(db, pairedId, name);
      if (partnerCanonicalId) return partnerCanonicalId;
    }
  }

  return randomUUID();
};

const unifyCanonicalIds = (db: Db, targetId: string, sourceId: string): void => {
  if (targetId === sourceId) return;
  db.prepare(
    `
    UPDATE problems
    SET canonical_id = @targetId
    WHERE canonical_id = @sourceId
  `,
  ).run({ targetId, sourceId });

  const overrideTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_problem_overrides'`)
    .get() as { name: string } | undefined;
  if (!overrideTable) return;

  const sourceOverrides = db
    .prepare(
      `
      SELECT
        user_id AS userId,
        solved_override AS solvedOverride,
        skipped,
        note,
        updated_at AS updatedAt
      FROM user_problem_overrides
      WHERE canonical_id = @sourceId
    `,
    )
    .all({ sourceId }) as {
    userId: string;
    solvedOverride: number | null;
    skipped: number;
    note: string | null;
    updatedAt: string;
  }[];

  const updateOverride = db.prepare(`
    UPDATE user_problem_overrides
    SET canonical_id = @targetId
    WHERE user_id = @userId AND canonical_id = @sourceId
  `);
  const mergeOverride = db.prepare(`
    UPDATE user_problem_overrides
    SET
      solved_override = @solvedOverride,
      skipped = @skipped,
      note = @note,
      updated_at = @updatedAt
    WHERE user_id = @userId AND canonical_id = @targetId
  `);
  const deleteOverride = db.prepare(`
    DELETE FROM user_problem_overrides
    WHERE user_id = @userId AND canonical_id = @sourceId
  `);
  const findTargetOverride = db.prepare(`
    SELECT
      solved_override AS solvedOverride,
      skipped,
      note,
      updated_at AS updatedAt
    FROM user_problem_overrides
    WHERE user_id = @userId AND canonical_id = @targetId
  `);

  for (const source of sourceOverrides) {
    const target = findTargetOverride.get({ userId: source.userId, targetId }) as
      | { solvedOverride: number | null; skipped: number; note: string | null; updatedAt: string }
      | undefined;

    if (!target) {
      updateOverride.run({ userId: source.userId, targetId, sourceId });
      continue;
    }

    const solvedOverride =
      source.solvedOverride === 1 || target.solvedOverride === 1
        ? 1
        : (source.solvedOverride ?? target.solvedOverride);
    // Solved wins over skipped when either side is marked solved.
    const skipped =
      solvedOverride === 1
        ? 0
        : source.skipped === 1 || target.skipped === 1
          ? 1
          : 0;
    const note =
      source.updatedAt >= target.updatedAt
        ? (source.note ?? target.note)
        : (target.note ?? source.note);
    const updatedAt =
      source.updatedAt >= target.updatedAt ? source.updatedAt : target.updatedAt;

    mergeOverride.run({
      userId: source.userId,
      targetId,
      solvedOverride,
      skipped,
      note,
      updatedAt,
    });
    deleteOverride.run({ userId: source.userId, sourceId });
  }
};

export const linkCanonicalIdsByRoundPairs = (db: Db): void => {
  const pairs = db
    .prepare(`SELECT contest_id_low AS lowId, contest_id_high AS highId FROM contest_round_pairs`)
    .all() as { lowId: number; highId: number }[];

  for (const pair of pairs) {
    const lowProblems = db
      .prepare(
        `
        SELECT name, canonical_id AS canonicalId
        FROM problems
        WHERE contest_id = @contestId
      `,
      )
      .all({ contestId: pair.lowId }) as { name: string; canonicalId: string }[];

    for (const problem of lowProblems) {
      const partner = db
        .prepare(
          `
          SELECT canonical_id AS canonicalId
          FROM problems
          WHERE contest_id = @contestId AND name = @name
          LIMIT 1
        `,
        )
        .get({ contestId: pair.highId, name: problem.name }) as { canonicalId: string } | undefined;

      if (!partner) continue;

      const targetId =
        problem.canonicalId < partner.canonicalId ? problem.canonicalId : partner.canonicalId;
      unifyCanonicalIds(db, targetId, problem.canonicalId);
      unifyCanonicalIds(db, targetId, partner.canonicalId);
    }
  }
};

export const backfillCanonicalIds = (db: Db): void => {
  refreshRoundPairs(db);

  transaction(db, () => {
    const rows = db
      .prepare(`SELECT contest_id AS contestId, problem_index AS problemIndex FROM problems`)
      .all() as { contestId: number; problemIndex: string }[];

    for (const row of rows) {
      const existing = db
        .prepare(
          `
          SELECT canonical_id AS canonicalId
          FROM problems
          WHERE contest_id = @contestId AND problem_index = @problemIndex
        `,
        )
        .get(row) as { canonicalId: string | null } | undefined;

      if (existing?.canonicalId) continue;

      db.prepare(
        `
        UPDATE problems
        SET canonical_id = @canonicalId
        WHERE contest_id = @contestId AND problem_index = @problemIndex
      `,
      ).run({
        contestId: row.contestId,
        problemIndex: row.problemIndex,
        canonicalId: randomUUID(),
      });
    }

    linkCanonicalIdsByRoundPairs(db);
  });
};

export const getProblemCanonicalId = (
  db: Db,
  contestId: number,
  problemIndex: string,
): string | undefined => {
  const row = db
    .prepare(
      `
      SELECT canonical_id AS canonicalId
      FROM problems
      WHERE contest_id = @contestId AND problem_index = @problemIndex
    `,
    )
    .get({ contestId, problemIndex }) as { canonicalId: string } | undefined;
  return row?.canonicalId;
};
