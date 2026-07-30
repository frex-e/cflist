import { contestEndTime } from "./contest-results.js";
import type { CfContest, CfRatingChange, CfStandings, CfStandingsRow } from "./types.js";

const MIN_RATING = 0;
const MAX_RATING = 5000;
const DEFAULT_PARTICIPANT_RATING = 1400;

const opponentBeats = (assumedRating: number, opponentRating: number): number => {
  return 1 / (1 + Math.pow(10, (assumedRating - opponentRating) / 400));
};

const expectedSolves = (assumedDifficulty: number, oldRatings: number[]): number => {
  let solves = 0;
  for (const rating of oldRatings) {
    // P(rating R solves difficulty D) = 1 / (1 + 10^((D - R) / 400))
    solves += opponentBeats(assumedDifficulty, rating);
  }
  return solves;
};

const firstTrue = (low: number, high: number, predicate: (value: number) => boolean): number => {
  let left = low;
  let right = high;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (predicate(mid)) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }

  return left;
};

const effectiveOldRating = (rating: number): number => (rating > 0 ? rating : DEFAULT_PARTICIPANT_RATING);

/**
 * Classic CF/clist problem rating: difficulty D such that the field's expected
 * solve count equals the observed solver count (blog/entry/46304).
 */
export const estimateProblemRating = (oldRatings: number[], solvedCount: number): number => {
  if (oldRatings.length === 0) return MAX_RATING;
  if (solvedCount <= 0) return MAX_RATING;
  if (solvedCount >= oldRatings.length) return MIN_RATING;

  const ratings = oldRatings.map(effectiveOldRating);

  // Higher difficulty => fewer expected solves. Find lowest D with expectedSolves(D) <= S.
  return firstTrue(MIN_RATING, MAX_RATING, (assumed) => expectedSolves(assumed, ratings) <= solvedCount);
};

export const oldRatingsFromChanges = (changes: CfRatingChange[]): number[] =>
  changes.map((change) => change.oldRating);

const isContestantRow = (row: CfStandingsRow): boolean => {
  const type = row.party.participantType;
  return type === undefined || type === "CONTESTANT";
};

const rowSolvedProblem = (row: CfStandingsRow, problemOffset: number): boolean => {
  const result = row.problemResults[problemOffset];
  if (!result) return false;
  if (result.points > 0) return true;
  return result.bestSubmissionTimeSeconds !== undefined && result.bestSubmissionTimeSeconds !== null;
};

/** Count in-contest solves per problem index from standings (CONTESTANT rows). */
export const countContestSolves = (standings: CfStandings): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const problem of standings.problems) {
    counts.set(problem.index, 0);
  }

  for (const row of standings.rows) {
    if (!isContestantRow(row)) continue;
    for (let index = 0; index < standings.problems.length; index += 1) {
      if (!rowSolvedProblem(row, index)) continue;
      const problemIndex = standings.problems[index].index;
      counts.set(problemIndex, (counts.get(problemIndex) ?? 0) + 1);
    }
  }

  return counts;
};

const LIVE_OR_PENDING_PHASES = new Set([
  "BEFORE",
  "CODING",
  "PENDING_SYSTEM_TEST",
  "SYSTEM_TEST",
]);

export const isContestEligibleForProblemRatingEstimate = (
  contest: CfContest | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean => {
  if (!contest) return false;

  const endTime = contestEndTime(contest);
  if (endTime === undefined || endTime > nowSeconds) return false;

  if (contest.phase && LIVE_OR_PENDING_PHASES.has(contest.phase)) return false;
  if (contest.phase && contest.phase !== "FINISHED") return false;

  return true;
};

export const estimateContestProblemRatings = (
  oldRatings: number[],
  solvedByIndex: Map<string, number>,
  problemIndexes: string[],
): Array<{ problemIndex: string; estimatedRating: number }> => {
  if (oldRatings.length === 0) return [];

  return problemIndexes.map((problemIndex) => ({
    problemIndex,
    estimatedRating: estimateProblemRating(oldRatings, solvedByIndex.get(problemIndex) ?? 0),
  }));
};
