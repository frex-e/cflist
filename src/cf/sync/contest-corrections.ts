import type { Db } from "../../db/connection.js";
import { config } from "../../config.js";
import { isLiveOrPendingContestPhase } from "../problem-rating.js";
import type { CfRatingChange } from "../types.js";
import { invalidateContestCaches } from "./cache.js";

type StoredContestResult = {
  contest_id: number;
  rank: number | null;
  old_rating: number | null;
  new_rating: number | null;
};

export const detectContestCorrections = (
  db: Db,
  userId: string,
  ratingsByContestId: Map<number, CfRatingChange>,
): number[] => {
  const storedRows = db
    .prepare(
      `
      SELECT contest_id, rank, old_rating, new_rating
      FROM user_contest_results
      WHERE user_id = @userId
    `,
    )
    .all({ userId }) as StoredContestResult[];

  const correctedContestIds: number[] = [];
  for (const stored of storedRows) {
    const apiChange = ratingsByContestId.get(stored.contest_id);
    if (!apiChange) continue;

    // Compare ratings only. Standings `rank` and `/user.rating` rank often differ
    // for the same contest (rated vs full field), so rank mismatches are not a
    // reliable signal and caused every sync to re-hydrate the same contests.
    if (
      apiChange.oldRating !== stored.old_rating
      || apiChange.newRating !== stored.new_rating
    ) {
      correctedContestIds.push(stored.contest_id);
    }
  }

  return correctedContestIds;
};

const cacheFetchedAt = (
  db: Db,
  userId: string,
  contestId: number,
): {
  standingsFetchedAt: string | null;
  ratingChangesFetchedAt: string | null;
  rated: boolean;
} | undefined => {
  const contestResult = db
    .prepare(
      `
      SELECT standings_checked_at, new_rating
      FROM user_contest_results
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .get({ userId, contestId }) as {
      standings_checked_at: string | null;
      new_rating: number | null;
    } | undefined;
  if (!contestResult) return undefined;

  const ratingChanges = db
    .prepare("SELECT raw_json, fetched_at FROM contest_rating_changes_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { raw_json: string; fetched_at: string } | undefined;

  let ratingChangesFetchedAt: string | null = null;
  if (ratingChanges) {
    try {
      const parsed = JSON.parse(ratingChanges.raw_json) as unknown;
      // Empty [] is a negative cache ("unavailable"), not usable rating data.
      if (Array.isArray(parsed) && parsed.length > 0) {
        ratingChangesFetchedAt = ratingChanges.fetched_at;
      }
    } catch {
      ratingChangesFetchedAt = null;
    }
  }

  return {
    standingsFetchedAt: contestResult.standings_checked_at,
    ratingChangesFetchedAt,
    rated: contestResult.new_rating !== null,
  };
};

export const isContestCacheStale = (
  db: Db,
  userId: string,
  contestId: number,
  ttlDays: number,
): boolean => {
  const freshness = cacheFetchedAt(db, userId, contestId);
  if (!freshness) return false;

  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
  if (!freshness.standingsFetchedAt || freshness.standingsFetchedAt < cutoff) return true;
  if (!freshness.rated) return false;
  return !freshness.ratingChangesFetchedAt || freshness.ratingChangesFetchedAt < cutoff;
};

export const contestsWithStaleCache = (
  db: Db,
  userId: string,
  sortedContestIds: number[],
  ttlDays: number = config.contestCacheTtlDays,
  recentCount: number = config.contestCacheRecentCount,
): number[] => {
  const contestIdsToCheck = sortedContestIds.slice(0, recentCount);
  return contestIdsToCheck.filter((contestId) => isContestCacheStale(db, userId, contestId, ttlDays));
};

export const invalidateContestCachesForContests = (
  db: Db,
  userId: string,
  contestIds: Iterable<number>,
): void => {
  for (const contestId of contestIds) {
    invalidateContestCaches(db, userId, contestId);
  }
};

export const contestsInLiveOrPendingPhase = (db: Db, userId: string): number[] => {
  const rows = db
    .prepare(
      `
      SELECT ucr.contest_id AS contest_id, c.phase AS phase
      FROM user_contest_results ucr
      JOIN contests c ON c.id = ucr.contest_id
      WHERE ucr.user_id = @userId
    `,
    )
    .all({ userId }) as { contest_id: number; phase: string | null }[];

  return rows
    .filter((row) => isLiveOrPendingContestPhase(row.phase))
    .map((row) => row.contest_id);
};

export const collectContestsNeedingRefresh = (
  db: Db,
  userId: string,
  ratingsByContestId: Map<number, CfRatingChange>,
  sortedContestIds: number[],
): number[] => {
  const refreshContestIds = new Set<number>([
    ...detectContestCorrections(db, userId, ratingsByContestId),
    ...contestsWithStaleCache(db, userId, sortedContestIds),
    // Keep pills aligned with standings while system tests rewrite verdicts.
    ...contestsInLiveOrPendingPhase(db, userId),
  ]);
  return [...refreshContestIds];
};
