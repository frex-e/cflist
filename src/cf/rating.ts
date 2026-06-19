import type { CfRatingChange } from "./types.js";

const DEFAULT_RATING = 1400;
const MIN_RATING = -500;
const MAX_RATING = 6000;

export const CF_BOOTSTRAP_BONUSES = [500, 350, 250, 150, 100, 50] as const;
export const CF_BOOTSTRAP_CONTEST_COUNT = CF_BOOTSTRAP_BONUSES.length;

const effectiveRating = (rating: number): number => rating > 0 ? rating : DEFAULT_RATING;

export const bootstrapOffsetBeforeContest = (ratedContestIndex: number): number => {
  if (ratedContestIndex <= 1) return DEFAULT_RATING;
  if (ratedContestIndex > CF_BOOTSTRAP_CONTEST_COUNT) return 0;

  const bonusesBefore = CF_BOOTSTRAP_BONUSES.slice(0, ratedContestIndex - 1);
  return DEFAULT_RATING - bonusesBefore.reduce((total, bonus) => total + bonus, 0);
};

export const internalRatingBeforeContest = (displayOldRating: number, ratedContestIndex: number): number => {
  if (ratedContestIndex > CF_BOOTSTRAP_CONTEST_COUNT) {
    return effectiveRating(displayOldRating);
  }

  return displayOldRating + bootstrapOffsetBeforeContest(ratedContestIndex);
};

export const bootstrapAdjustedDelta = (
  displayOldRating: number,
  displayNewRating: number,
  ratedContestIndex: number,
): number => {
  const displayDelta = displayNewRating - displayOldRating;
  if (ratedContestIndex >= 1 && ratedContestIndex <= CF_BOOTSTRAP_CONTEST_COUNT) {
    return displayDelta - CF_BOOTSTRAP_BONUSES[ratedContestIndex - 1];
  }

  return displayDelta;
};

const trunc = (value: number): number => value < 0 ? Math.ceil(value) : Math.floor(value);

const opponentBeats = (assumedRating: number, opponentRating: number): number => {
  return 1 / (1 + Math.pow(10, (assumedRating - opponentRating) / 400));
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

type Participant = {
  handle: string;
  rank: number;
  oldRating: number;
  newRating: number;
};

export type PerformanceEstimate = {
  performance: number | null;
  adjustment: number;
};

export const estimateContestPerformance = (
  changes: CfRatingChange[],
  handle: string,
  targetRatedContestIndex?: number,
): PerformanceEstimate | undefined => {
  const targetChange = changes.find((change) => change.handle.toLowerCase() === handle.toLowerCase());
  if (!targetChange) return undefined;
  if (targetChange.rank === 1) return { performance: null, adjustment: 0 };

  const participants: Participant[] = changes.map((change) => {
    const isTarget = change.handle.toLowerCase() === handle.toLowerCase();
    const oldRating = isTarget && targetRatedContestIndex !== undefined
      ? internalRatingBeforeContest(change.oldRating, targetRatedContestIndex)
      : effectiveRating(change.oldRating);

    return {
      handle: change.handle,
      rank: change.rank,
      oldRating,
      newRating: change.newRating,
    };
  });
  const target = participants.find((participant) => participant.handle.toLowerCase() === handle.toLowerCase());
  if (!target) return undefined;

  const seed = (assumedRating: number, selfRating: number): number => {
    let value = 1;
    for (const participant of participants) {
      value += opponentBeats(assumedRating, participant.oldRating);
    }
    return value - opponentBeats(assumedRating, selfRating);
  };

  const rankToRating = (rank: number, selfRating: number): number => {
    return firstTrue(2, MAX_RATING, (rating) => seed(rating, selfRating) < rank) - 1;
  };

  const rawDelta = (assumedRating: number): number => {
    const midRank = Math.sqrt(target.rank * seed(assumedRating, target.oldRating));
    const needRating = rankToRating(midRank, target.oldRating);
    return trunc((needRating - assumedRating) / 2);
  };

  const actualDelta = targetRatedContestIndex !== undefined
    ? bootstrapAdjustedDelta(targetChange.oldRating, targetChange.newRating, targetRatedContestIndex)
    : target.newRating - target.oldRating;
  const adjustment = actualDelta - rawDelta(target.oldRating);
  const performance = firstTrue(MIN_RATING, MAX_RATING, (assumedRating) => rawDelta(assumedRating) + adjustment <= 0);

  return { performance, adjustment };
};
