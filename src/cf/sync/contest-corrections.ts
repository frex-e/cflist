import type { Db } from "../../db/connection.js";
import { config } from "../../config.js";
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

    if (
      apiChange.rank !== stored.rank
      || apiChange.oldRating !== stored.old_rating
      || apiChange.newRating !== stored.new_rating
    ) {
      correctedContestIds.push(stored.contest_id);
    }
  }

  return correctedContestIds;
};

const cacheFetchedAt = (
  db: Db,
  contestId: number,
): { standingsFetchedAt: string | null; ratingChangesFetchedAt: string | null } => {
  const standings = db
    .prepare("SELECT fetched_at FROM contest_standings_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { fetched_at: string } | undefined;
  const ratingChanges = db
    .prepare("SELECT fetched_at FROM contest_rating_changes_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { fetched_at: string } | undefined;

  return {
    standingsFetchedAt: standings?.fetched_at ?? null,
    ratingChangesFetchedAt: ratingChanges?.fetched_at ?? null,
  };
};

export const isContestCacheStale = (db: Db, contestId: number, ttlDays: number): boolean => {
  const { standingsFetchedAt, ratingChangesFetchedAt } = cacheFetchedAt(db, contestId);
  if (!standingsFetchedAt && !ratingChangesFetchedAt) return false;

  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
  if (!standingsFetchedAt || !ratingChangesFetchedAt) return true;
  return standingsFetchedAt < cutoff || ratingChangesFetchedAt < cutoff;
};

export const contestsWithStaleCache = (
  db: Db,
  sortedContestIds: number[],
  ttlDays: number = config.contestCacheTtlDays,
  recentCount: number = config.contestCacheRecentCount,
): number[] => {
  const contestIdsToCheck = sortedContestIds.slice(0, recentCount);
  return contestIdsToCheck.filter((contestId) => isContestCacheStale(db, contestId, ttlDays));
};

export const invalidateContestCachesForContests = (db: Db, contestIds: Iterable<number>): void => {
  for (const contestId of contestIds) {
    invalidateContestCaches(db, contestId);
  }
};

export const collectContestsNeedingRefresh = (
  db: Db,
  userId: string,
  ratingsByContestId: Map<number, CfRatingChange>,
  sortedContestIds: number[],
): number[] => {
  const refreshContestIds = new Set<number>([
    ...detectContestCorrections(db, userId, ratingsByContestId),
    ...contestsWithStaleCache(db, sortedContestIds),
  ]);
  return [...refreshContestIds];
};
