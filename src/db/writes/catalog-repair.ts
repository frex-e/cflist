import type { Db } from "../connection.js";
import { enqueueContestHydrationJobs } from "../../cf/sync/contest-queue.js";

export type CatalogLookup =
  | { kind: "contest"; contestId: number }
  | { kind: "problem"; contestId: number; problemIndex: string };

export const parseCatalogLookup = (raw: string): CatalogLookup | undefined => {
  const value = raw.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) {
    const contestId = Number.parseInt(value, 10);
    return Number.isFinite(contestId) ? { kind: "contest", contestId } : undefined;
  }

  const match = /^(\d+)([A-Za-z]\w*)$/.exec(value);
  if (!match) return undefined;
  return {
    kind: "problem",
    contestId: Number.parseInt(match[1]!, 10),
    // Codeforces indices are stored uppercase (A, B1, …); normalize lookup input.
    problemIndex: match[2]!.toUpperCase(),
  };
};

export const confirmLookupMatches = (
  typed: string | undefined,
  expected: string,
): boolean => typed?.trim().toLowerCase() === expected.trim().toLowerCase();

export type ContestRepairSummary = {
  contestId: number;
  name: string;
  phase: string | null;
  problemCount: number;
  estimatedCount: number;
  hasRatingChangesCache: boolean;
  userResultCount: number;
  hydratedUserCount: number;
};

export type ProblemRepairSummary = {
  contestId: number;
  problemIndex: string;
  name: string;
  rating: number | null;
  estimatedRating: number | null;
  canonicalId: string;
  contestName: string;
};

export const getContestRepairSummary = (
  db: Db,
  contestId: number,
): ContestRepairSummary | undefined => {
  const contest = db
    .prepare(
      `
      SELECT id, name, phase
      FROM contests
      WHERE id = @contestId
    `,
    )
    .get({ contestId }) as { id: number; name: string; phase: string | null } | undefined;
  if (!contest) return undefined;

  const problemStats = db
    .prepare(
      `
      SELECT
        COUNT(*) AS problemCount,
        COALESCE(SUM(CASE WHEN estimated_rating IS NOT NULL THEN 1 ELSE 0 END), 0) AS estimatedCount
      FROM problems
      WHERE contest_id = @contestId
    `,
    )
    .get({ contestId }) as { problemCount: number; estimatedCount: number };

  const cache = db
    .prepare(
      `
      SELECT 1 AS present
      FROM contest_rating_changes_cache
      WHERE contest_id = @contestId
    `,
    )
    .get({ contestId }) as { present: number } | undefined;

  const userStats = db
    .prepare(
      `
      SELECT
        COUNT(*) AS userResultCount,
        COALESCE(SUM(CASE WHEN standings_checked_at IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS hydratedUserCount
      FROM user_contest_results
      WHERE contest_id = @contestId
    `,
    )
    .get({ contestId }) as { userResultCount: number; hydratedUserCount: number };

  return {
    contestId: contest.id,
    name: contest.name,
    phase: contest.phase,
    problemCount: Number(problemStats.problemCount),
    estimatedCount: Number(problemStats.estimatedCount),
    hasRatingChangesCache: Boolean(cache),
    userResultCount: Number(userStats.userResultCount),
    hydratedUserCount: Number(userStats.hydratedUserCount),
  };
};

export const getProblemRepairSummary = (
  db: Db,
  contestId: number,
  problemIndex: string,
): ProblemRepairSummary | undefined => {
  const row = db
    .prepare(
      `
      SELECT
        p.contest_id AS contestId,
        p.problem_index AS problemIndex,
        p.name AS name,
        p.rating AS rating,
        p.estimated_rating AS estimatedRating,
        p.canonical_id AS canonicalId,
        c.name AS contestName
      FROM problems p
      JOIN contests c ON c.id = p.contest_id
      WHERE p.contest_id = @contestId AND p.problem_index = @problemIndex
    `,
    )
    .get({ contestId, problemIndex }) as ProblemRepairSummary | undefined;
  return row;
};

export const clearProblemEstimate = (
  db: Db,
  contestId: number,
  problemIndex: string,
): number => {
  const result = db
    .prepare(
      `
      UPDATE problems
      SET estimated_rating = NULL, estimated_rating_at = NULL
      WHERE contest_id = @contestId AND problem_index = @problemIndex
    `,
    )
    .run({ contestId, problemIndex });
  return Number(result.changes);
};

export const clearContestEstimates = (db: Db, contestId: number): number => {
  const result = db
    .prepare(
      `
      UPDATE problems
      SET estimated_rating = NULL, estimated_rating_at = NULL
      WHERE contest_id = @contestId
    `,
    )
    .run({ contestId });
  return Number(result.changes);
};

export const dropContestRatingChangesCache = (db: Db, contestId: number): number => {
  const result = db
    .prepare("DELETE FROM contest_rating_changes_cache WHERE contest_id = @contestId")
    .run({ contestId });
  return Number(result.changes);
};

/**
 * Soft-invalidate shared caches and all users' standings freshness for a contest,
 * then requeue hydration jobs. Does not delete contest/problem rows or solved status.
 */
export const forceRehydrateContestForAllUsers = (db: Db, contestId: number): number => {
  db.prepare("DELETE FROM contest_rating_changes_cache WHERE contest_id = @contestId").run({
    contestId,
  });
  // Leave performance (row + cache) alone; hydration recalculates and overwrites.
  db.prepare(
    `
    UPDATE user_contest_results
    SET standings_checked_at = NULL
    WHERE contest_id = @contestId
  `,
  ).run({ contestId });

  const users = db
    .prepare(
      `
      SELECT ucr.user_id AS userId, u.cfHandle AS cfHandle
      FROM user_contest_results ucr
      JOIN "user" u ON u.id = ucr.user_id
      WHERE ucr.contest_id = @contestId
    `,
    )
    .all({ contestId }) as Array<{ userId: string; cfHandle: string }>;

  for (const user of users) {
    if (!user.cfHandle?.trim()) continue;
    enqueueContestHydrationJobs(db, user.userId, user.cfHandle, [
      { contestId, priority: 0 },
    ]);
  }

  return users.length;
};
