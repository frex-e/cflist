import { transaction, type Db } from "../../db/connection.js";
import { writeEstimatedRatings } from "../../db/writes/problems.js";
import { contestEndTime } from "../contest-results.js";
import {
  DEFAULT_MAX_PROBLEM_RATING,
  countContestSolves,
  estimateProblemRating,
  isContestEligibleForProblemRatingEstimate,
  oldRatingsFromChanges,
} from "../problem-rating.js";
import type { CodeforcesClient } from "../client.js";
import type { CfContest, CfRatingChange, CfStandings } from "../types.js";
import { getCachedRatingChanges, getOrFetchRatingChanges } from "./cache.js";
import { getPairedContestId } from "./canonical-problems.js";
import { now } from "./helpers.js";

/** Highest official problem rating tag in the catalog (fallback 3500). */
export const maxOfficialProblemRatingTag = (db: Db): number => {
  const row = db
    .prepare(
      `
      SELECT MAX(rating) AS maxRating
      FROM problems
      WHERE rating IS NOT NULL
    `,
    )
    .get() as { maxRating: number | null } | undefined;
  return row?.maxRating ?? DEFAULT_MAX_PROBLEM_RATING;
};

const listUnratedProblemsNeedingEstimate = (
  db: Db,
  contestId?: number,
): Array<{ contestId: number; problemIndex: string }> => {
  if (contestId !== undefined) {
    return db
      .prepare(
        `
        SELECT
          contest_id AS contestId,
          problem_index AS problemIndex
        FROM problems
        WHERE contest_id = @contestId
          AND rating IS NULL
          AND estimated_rating IS NULL
      `,
      )
      .all({ contestId }) as Array<{ contestId: number; problemIndex: string }>;
  }

  return db
    .prepare(
      `
      SELECT
        contest_id AS contestId,
        problem_index AS problemIndex
      FROM problems
      WHERE rating IS NULL
        AND estimated_rating IS NULL
    `,
    )
    .all() as Array<{ contestId: number; problemIndex: string }>;
};

/**
 * Unrated placements in `contestId` that share a canonical_id with the paired
 * contest — included even when an estimate already exists so a solo/provisional
 * value can be upgraded to a combined Div. 1 + Div. 2 estimate.
 */
const listSharedUnratedProblemsForPair = (
  db: Db,
  contestId: number,
  pairedContestId: number,
): Array<{ contestId: number; problemIndex: string; siblingIndex: string }> => {
  return db
    .prepare(
      `
      SELECT
        p.contest_id AS contestId,
        p.problem_index AS problemIndex,
        sibling.problem_index AS siblingIndex
      FROM problems p
      JOIN problems sibling
        ON sibling.canonical_id = p.canonical_id
        AND sibling.contest_id = @pairedContestId
      WHERE p.contest_id = @contestId
        AND p.rating IS NULL
        AND sibling.rating IS NULL
    `,
    )
    .all({ contestId, pairedContestId }) as Array<{
    contestId: number;
    problemIndex: string;
    siblingIndex: string;
  }>;
};

const findCanonicalSiblingIndex = (
  db: Db,
  contestId: number,
  problemIndex: string,
  pairedContestId: number,
): string | undefined => {
  const row = db
    .prepare(
      `
      SELECT sibling.problem_index AS siblingIndex
      FROM problems p
      JOIN problems sibling
        ON sibling.canonical_id = p.canonical_id
        AND sibling.contest_id = @pairedContestId
      WHERE p.contest_id = @contestId
        AND p.problem_index = @problemIndex
      LIMIT 1
    `,
    )
    .get({ contestId, problemIndex, pairedContestId }) as { siblingIndex: string } | undefined;
  return row?.siblingIndex;
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

type FieldSnapshot = {
  contestId: number;
  oldRatings: number[];
  solvedByIndex: Map<string, number>;
};

const applyEstimateRows = (
  db: Db,
  rows: Array<{ contestId: number; problemIndex: string; estimatedRating: number }>,
): number => {
  if (rows.length === 0) return 0;
  const estimatedAt = now();
  // Dedup by contest+index so shared writes from both loops don't double-count.
  const unique = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    unique.set(`${row.contestId}:${row.problemIndex}`, row);
  }
  const deduped = [...unique.values()];
  transaction(db, () => {
    writeEstimatedRatings(
      db,
      deduped.map((row) => ({
        contestId: row.contestId,
        problemIndex: row.problemIndex,
        estimatedRating: row.estimatedRating,
        estimatedAt,
      })),
    );
  });
  return deduped.length;
};

/**
 * Estimate problems for a contest. Shared Div. 1 / Div. 2 placements use the
 * combined rated field when the paired contest snapshot is available; otherwise
 * the local estimate is written to both placements so the deduped problems list
 * and both contest pill rows agree.
 */
const buildEstimateRows = (
  db: Db,
  local: FieldSnapshot,
  problemIndexes: string[],
  paired: FieldSnapshot | undefined,
  maxRating: number,
): Array<{ contestId: number; problemIndex: string; estimatedRating: number }> => {
  if (problemIndexes.length === 0 || local.oldRatings.length === 0) return [];

  const pairedId = paired?.contestId ?? getPairedContestId(db, local.contestId);
  const rows: Array<{ contestId: number; problemIndex: string; estimatedRating: number }> = [];

  for (const problemIndex of problemIndexes) {
    const siblingIndex =
      pairedId !== undefined
        ? findCanonicalSiblingIndex(db, local.contestId, problemIndex, pairedId)
        : undefined;

    if (siblingIndex !== undefined && paired && paired.oldRatings.length > 0) {
      const estimatedRating = estimateProblemRating(
        [...local.oldRatings, ...paired.oldRatings],
        (local.solvedByIndex.get(problemIndex) ?? 0) +
          (paired.solvedByIndex.get(siblingIndex) ?? 0),
        maxRating,
      );
      rows.push({
        contestId: local.contestId,
        problemIndex,
        estimatedRating,
      });
      rows.push({
        contestId: paired.contestId,
        problemIndex: siblingIndex,
        estimatedRating,
      });
      continue;
    }

    const estimatedRating = estimateProblemRating(
      local.oldRatings,
      local.solvedByIndex.get(problemIndex) ?? 0,
      maxRating,
    );
    rows.push({
      contestId: local.contestId,
      problemIndex,
      estimatedRating,
    });
    if (siblingIndex !== undefined && pairedId !== undefined) {
      // Provisional: keep both placements identical until the pair can combine.
      rows.push({
        contestId: pairedId,
        problemIndex: siblingIndex,
        estimatedRating,
      });
    }
  }

  return rows;
};

const estimateFromStandings = (
  db: Db,
  contestId: number,
  standings: CfStandings,
  changes: CfRatingChange[],
  problemIndexes: string[],
  paired: FieldSnapshot | undefined,
  maxRating: number,
): number => {
  const local: FieldSnapshot = {
    contestId,
    oldRatings: oldRatingsFromChanges(changes),
    solvedByIndex: countContestSolves(standings),
  };
  return applyEstimateRows(
    db,
    buildEstimateRows(db, local, problemIndexes, paired, maxRating),
  );
};

const loadPairedFieldSnapshot = async (
  db: Db,
  client: CodeforcesClient,
  pairedContestId: number,
  standings?: CfStandings,
): Promise<FieldSnapshot | undefined> => {
  let changes = getCachedRatingChanges(db, pairedContestId);
  if (!changes || changes.length === 0) {
    try {
      changes = await getOrFetchRatingChanges(db, client, pairedContestId);
    } catch {
      return undefined;
    }
  }
  if (!changes || changes.length === 0) return undefined;

  let pairedStandings = standings;
  if (!pairedStandings) {
    try {
      pairedStandings = await client.contestStandings(pairedContestId);
    } catch {
      return undefined;
    }
  }

  return {
    contestId: pairedContestId,
    oldRatings: oldRatingsFromChanges(changes),
    solvedByIndex: countContestSolves(pairedStandings),
  };
};

const problemIndexesForEstimate = (
  db: Db,
  contestId: number,
  needing: Array<{ contestId: number; problemIndex: string }>,
  pairedContestId: number | undefined,
  hasPairedSnapshot: boolean,
): string[] => {
  const indexes = new Set(needing.map((row) => row.problemIndex));
  if (pairedContestId !== undefined && hasPairedSnapshot) {
    for (const shared of listSharedUnratedProblemsForPair(db, contestId, pairedContestId)) {
      indexes.add(shared.problemIndex);
    }
  }
  return [...indexes];
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
  const pairedContestId = getPairedContestId(db, contestId);
  const paired =
    pairedContestId !== undefined
      ? await loadPairedFieldSnapshot(db, client, pairedContestId)
      : undefined;

  const problemIndexes = problemIndexesForEstimate(
    db,
    contestId,
    needing,
    pairedContestId,
    paired !== undefined,
  );
  if (problemIndexes.length === 0) return 0;

  let changes: CfRatingChange[];
  try {
    changes = await getOrFetchRatingChanges(db, client, contestId);
  } catch {
    return 0;
  }
  if (changes.length === 0) return 0;

  return estimateFromStandings(
    db,
    contestId,
    standings,
    changes,
    problemIndexes,
    paired,
    maxOfficialProblemRatingTag(db),
  );
};

/**
 * One-shot pass for unrated problems that still lack an estimate. Uses cached
 * (or fetched) rating changes plus a fresh standings fetch for in-contest solve
 * counts — never catalog solved_count, which includes upsolves worldwide.
 *
 * Do not hard-gate on the local contests row: phase/duration can lag until the
 * next catalog sync. Only skip early when the DB end time is clearly still in
 * the future; final eligibility uses standings.contest.
 *
 * Div. 1 / Div. 2 round pairs are processed together when possible so shared
 * problems get one combined-field estimate on both placements.
 */
export const estimateMissingProblemRatings = async (
  db: Db,
  client: CodeforcesClient,
  options: { skipContestIds?: ReadonlySet<number> } = {},
): Promise<number> => {
  const needing = listUnratedProblemsNeedingEstimate(db);
  if (needing.length === 0) return 0;

  const byContest = new Map<number, typeof needing>();
  for (const row of needing) {
    if (options.skipContestIds?.has(row.contestId)) continue;
    const list = byContest.get(row.contestId) ?? [];
    list.push(row);
    byContest.set(row.contestId, list);
  }
  if (byContest.size === 0) return 0;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxRating = maxOfficialProblemRatingTag(db);
  const processed = new Set<number>();
  let updated = 0;

  // Newest contests first so a just-finished Div. 3 is estimated before we burn
  // the CF rate limit on older permanently-unrated rounds (April Fools, etc.).
  const contestIds = [...byContest.keys()].sort((a, b) => {
    const aStart = loadContestRow(db, a)?.startTimeSeconds ?? 0;
    const bStart = loadContestRow(db, b)?.startTimeSeconds ?? 0;
    if (aStart !== bStart) return bStart - aStart;
    return b - a;
  });

  for (const contestId of contestIds) {
    if (processed.has(contestId)) continue;
    const problems = byContest.get(contestId)!;

    const contest = loadContestRow(db, contestId);
    const dbEndTime = contest ? contestEndTime(contest) : undefined;
    // Cheap skip only when we know the round is still running.
    if (dbEndTime !== undefined && dbEndTime > nowSeconds) continue;

    let changes = getCachedRatingChanges(db, contestId);
    if (!changes || changes.length === 0) {
      try {
        changes = await getOrFetchRatingChanges(db, client, contestId);
      } catch {
        continue;
      }
    }
    if (!changes || changes.length === 0) continue;

    let standings: CfStandings;
    try {
      standings = await client.contestStandings(contestId);
    } catch {
      continue;
    }

    // Prefer fresh standings contest metadata over a possibly stale DB row.
    if (!isContestEligibleForProblemRatingEstimate(standings.contest ?? contest, nowSeconds)) {
      continue;
    }

    const pairedContestId = getPairedContestId(db, contestId);
    let paired: FieldSnapshot | undefined;
    if (pairedContestId !== undefined) {
      const pairedContest = loadContestRow(db, pairedContestId);
      const pairedEnd = pairedContest ? contestEndTime(pairedContest) : undefined;
      if (pairedEnd === undefined || pairedEnd <= nowSeconds) {
        paired = await loadPairedFieldSnapshot(db, client, pairedContestId);
      }
    }

    const problemIndexes = problemIndexesForEstimate(
      db,
      contestId,
      problems,
      pairedContestId,
      paired !== undefined,
    );

    updated += estimateFromStandings(
      db,
      contestId,
      standings,
      changes,
      problemIndexes,
      paired,
      maxRating,
    );

    processed.add(contestId);
    if (pairedContestId !== undefined && paired !== undefined) {
      // Shared problems were written for both contests; skip the pair's solo pass.
      processed.add(pairedContestId);
    }
  }

  return updated;
};
