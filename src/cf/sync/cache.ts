import type { Db } from "../../db/connection.js";
import { estimateContestPerformance } from "../rating.js";
import type { CfRatingChange } from "../types.js";
import type { CodeforcesClient } from "../client.js";

const now = (): string => new Date().toISOString();

export const parseCachedJson = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const getOrFetchRatingChangesCache = async (
  db: Db,
  contestId: number,
  fetcher: () => Promise<CfRatingChange[]>,
): Promise<CfRatingChange[]> => {
  const cached = db
    .prepare("SELECT raw_json FROM contest_rating_changes_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { raw_json: string } | undefined;
  const parsed = parseCachedJson<CfRatingChange[]>(cached?.raw_json);
  if (parsed !== undefined) return parsed;

  const data = await fetcher();
  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
    ON CONFLICT(contest_id) DO UPDATE SET
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at
  `,
  ).run({ contestId, rawJson: JSON.stringify(data), fetchedAt: now() });
  return data;
};

export const getCachedRatingChanges = (db: Db, contestId: number): CfRatingChange[] | undefined => {
  const cached = db
    .prepare("SELECT raw_json FROM contest_rating_changes_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { raw_json: string } | undefined;
  return parseCachedJson<CfRatingChange[]>(cached?.raw_json);
};

export const invalidateContestCaches = (db: Db, userId: string, contestId: number): void => {
  // Drop rating-change source data so hydration refetches it. Leave performance
  // (row + cache) alone; hydration recalculates and overwrites when ready.
  db.prepare("DELETE FROM contest_rating_changes_cache WHERE contest_id = @contestId").run({ contestId });
  db.prepare(
    `
    UPDATE user_contest_results
    SET standings_checked_at = NULL
    WHERE user_id = @userId AND contest_id = @contestId
  `,
  ).run({ userId, contestId });
};

export const calculatePerformanceFromCache = (
  db: Db,
  userId: string,
  contestId: number,
  handle: string,
): number | null => {
  const changes = getCachedRatingChanges(db, contestId);
  if (!changes) return null;

  const ratedContestIndex = getRatedContestIndex(db, userId, contestId);
  return estimateContestPerformance(changes, handle, ratedContestIndex)?.performance ?? null;
};

const persistContestPerformance = (
  db: Db,
  userId: string,
  contestId: number,
  performance: number | null,
): void => {
  db.prepare(
    `
    UPDATE user_contest_results
    SET performance = @performance
    WHERE user_id = @userId AND contest_id = @contestId
  `,
  ).run({ userId, contestId, performance });

  db.prepare(
    `
    INSERT INTO contest_performance_cache (
      contest_id,
      user_id,
      performance,
      calculated_at
    ) VALUES (
      @contestId,
      @userId,
      @performance,
      @calculatedAt
    )
    ON CONFLICT(contest_id, user_id) DO UPDATE SET
      performance = excluded.performance,
      calculated_at = excluded.calculated_at
  `,
  ).run({
    contestId,
    userId,
    performance,
    calculatedAt: now(),
  });
};

export const backfillUserContestPerformances = (db: Db, userId: string): void => {
  const cachedRows = db.prepare(
    `
    SELECT ucr.contest_id, cpc.performance
    FROM user_contest_results ucr
    JOIN contest_performance_cache cpc
      ON cpc.contest_id = ucr.contest_id
      AND cpc.user_id = ucr.user_id
    WHERE ucr.user_id = @userId
      AND ucr.new_rating IS NOT NULL
      AND ucr.performance IS NULL
      AND (ucr.rank IS NULL OR ucr.rank != 1)
      AND cpc.performance IS NOT NULL
  `,
  ).all({ userId }) as { contest_id: number; performance: number }[];

  for (const row of cachedRows) {
    db.prepare(
      `
      UPDATE user_contest_results
      SET performance = @performance
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    ).run({ userId, contestId: row.contest_id, performance: row.performance });
  }

  const handleRow = db
    .prepare(`SELECT cfHandle FROM "user" WHERE id = @userId`)
    .get({ userId }) as { cfHandle: string } | undefined;
  const handle = handleRow?.cfHandle;
  if (!handle) return;

  const rows = db.prepare(
    `
    SELECT contest_id, rank
    FROM user_contest_results
    WHERE user_id = @userId
      AND new_rating IS NOT NULL
      AND performance IS NULL
      AND (rank IS NULL OR rank != 1)
  `,
  ).all({ userId }) as { contest_id: number; rank: number | null }[];

  for (const row of rows) {
    const performance = calculatePerformanceFromCache(db, userId, row.contest_id, handle);
    if (performance === null) continue;
    persistContestPerformance(db, userId, row.contest_id, performance);
  }
};

export const getOrFetchRatingChanges = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
): Promise<CfRatingChange[]> => {
  return getOrFetchRatingChangesCache(db, contestId, () => client.contestRatingChanges(contestId));
};

export const getRatedContestIndex = (db: Db, userId: string, contestId: number): number | undefined => {
  const rows = db.prepare(`
    SELECT ucr.contest_id
    FROM user_contest_results ucr
    JOIN contests c ON c.id = ucr.contest_id
    WHERE ucr.user_id = @userId
      AND ucr.new_rating IS NOT NULL
    ORDER BY c.start_time_seconds ASC, ucr.contest_id ASC
  `).all({ userId }) as { contest_id: number }[];

  const index = rows.findIndex((row) => row.contest_id === contestId);
  return index >= 0 ? index + 1 : undefined;
};

export const calculateAndPersistPerformance = async (
  db: Db,
  client: CodeforcesClient,
  userId: string,
  contestId: number,
  handle: string,
): Promise<number | null> => {
  const changes = await getOrFetchRatingChanges(db, client, contestId);
  const ratedContestIndex = getRatedContestIndex(db, userId, contestId);
  const performance = estimateContestPerformance(changes, handle, ratedContestIndex)?.performance ?? null;
  persistContestPerformance(db, userId, contestId, performance);
  return performance;
};
