import { transaction, type Db } from "../../db/connection.js";
import { writeEstimatedRatings } from "../../db/writes/problems.js";
import {
  countContestSolves,
  estimateContestProblemRatings,
  isContestEligibleForProblemRatingEstimate,
  oldRatingsFromChanges,
} from "../problem-rating.js";
import type { CodeforcesClient } from "../client.js";
import type { CfContest, CfRatingChange, CfStandings } from "../types.js";
import { getCachedRatingChanges, getOrFetchRatingChanges } from "./cache.js";
import { now } from "./helpers.js";

const listUnratedProblemsNeedingEstimate = (
  db: Db,
  contestId?: number,
): Array<{ contestId: number; problemIndex: string; solvedCount: number | null }> => {
  if (contestId !== undefined) {
    return db
      .prepare(
        `
        SELECT
          contest_id AS contestId,
          problem_index AS problemIndex,
          solved_count AS solvedCount
        FROM problems
        WHERE contest_id = @contestId
          AND rating IS NULL
          AND estimated_rating IS NULL
      `,
      )
      .all({ contestId }) as Array<{ contestId: number; problemIndex: string; solvedCount: number | null }>;
  }

  return db
    .prepare(
      `
      SELECT
        contest_id AS contestId,
        problem_index AS problemIndex,
        solved_count AS solvedCount
      FROM problems
      WHERE rating IS NULL
        AND estimated_rating IS NULL
    `,
    )
    .all() as Array<{ contestId: number; problemIndex: string; solvedCount: number | null }>;
};

const loadContestRow = (db: Db, contestId: number): CfContest | undefined => {
  return db
    .prepare(
      `
      SELECT
        id,
        name,
        phase,
        start_time_seconds AS startTimeSeconds,
        duration_seconds AS durationSeconds
      FROM contests
      WHERE id = @contestId
    `,
    )
    .get({ contestId }) as CfContest | undefined;
};

const applyEstimates = (
  db: Db,
  contestId: number,
  oldRatings: number[],
  solvedByIndex: Map<string, number>,
  problemIndexes: string[],
): number => {
  if (problemIndexes.length === 0 || oldRatings.length === 0) return 0;

  const estimates = estimateContestProblemRatings(oldRatings, solvedByIndex, problemIndexes);
  const estimatedAt = now();
  transaction(db, () => {
    writeEstimatedRatings(
      db,
      estimates.map((estimate) => ({
        contestId,
        problemIndex: estimate.problemIndex,
        estimatedRating: estimate.estimatedRating,
        estimatedAt,
      })),
    );
  });
  return estimates.length;
};

/**
 * After hydration: estimate unrated problems using in-memory standings solve counts
 * when the contest is finished and rating changes are available.
 */
export const maybeEstimateProblemRatingsAfterHydration = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
  standings: CfStandings,
  contest: CfContest | undefined,
): Promise<number> => {
  if (!isContestEligibleForProblemRatingEstimate(contest ?? standings.contest)) return 0;

  const needing = listUnratedProblemsNeedingEstimate(db, contestId);
  if (needing.length === 0) return 0;

  let changes: CfRatingChange[];
  try {
    changes = await getOrFetchRatingChanges(db, client, contestId);
  } catch {
    return 0;
  }
  if (changes.length === 0) return 0;

  const oldRatings = oldRatingsFromChanges(changes);
  const solvedByIndex = countContestSolves(standings);
  return applyEstimates(
    db,
    contestId,
    oldRatings,
    solvedByIndex,
    needing.map((row) => row.problemIndex),
  );
};

/**
 * One-shot pass for unrated problems that still lack an estimate, using cached
 * rating changes and catalog solved_count as a fallback solver count.
 */
export const estimateMissingProblemRatings = async (
  db: Db,
  client: CodeforcesClient,
): Promise<number> => {
  const needing = listUnratedProblemsNeedingEstimate(db);
  if (needing.length === 0) return 0;

  const byContest = new Map<number, typeof needing>();
  for (const row of needing) {
    const list = byContest.get(row.contestId) ?? [];
    list.push(row);
    byContest.set(row.contestId, list);
  }

  let updated = 0;
  for (const [contestId, problems] of byContest) {
    const contest = loadContestRow(db, contestId);
    if (!isContestEligibleForProblemRatingEstimate(contest)) continue;

    let changes = getCachedRatingChanges(db, contestId);
    if (!changes || changes.length === 0) {
      try {
        changes = await getOrFetchRatingChanges(db, client, contestId);
      } catch {
        continue;
      }
    }
    if (!changes || changes.length === 0) continue;

    const oldRatings = oldRatingsFromChanges(changes);
    const solvedByIndex = new Map(
      problems.map((problem) => [problem.problemIndex, problem.solvedCount ?? 0]),
    );
    updated += applyEstimates(
      db,
      contestId,
      oldRatings,
      solvedByIndex,
      problems.map((problem) => problem.problemIndex),
    );
  }

  return updated;
};
