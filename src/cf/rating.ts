import type { CfRatingChange } from "./types.js";

const DEFAULT_RATING = 1400;
const MIN_RATING = -500;
const MAX_RATING = 6000;

const effectiveRating = (rating: number): number => rating > 0 ? rating : DEFAULT_RATING;

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
  ratingBefore: number;
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
): PerformanceEstimate | undefined => {
  const participants: Participant[] = changes.map((change) => ({
    handle: change.handle,
    rank: change.rank,
    ratingBefore: change.oldRating,
    oldRating: effectiveRating(change.oldRating),
    newRating: change.newRating,
  }));
  const target = participants.find((participant) => participant.handle.toLowerCase() === handle.toLowerCase());
  if (!target) return undefined;
  if (target.rank === 1) return { performance: null, adjustment: 0 };

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

  const actualDelta = target.newRating - target.ratingBefore;
  const adjustment = actualDelta - rawDelta(target.oldRating);
  const performance = firstTrue(MIN_RATING, MAX_RATING, (assumedRating) => rawDelta(assumedRating) + adjustment <= 0);

  return { performance, adjustment };
};
