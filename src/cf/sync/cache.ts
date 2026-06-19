import type { Db } from "../../db/connection.js";
import { estimateContestPerformance } from "../rating.js";
import type { CfRatingChange, CfStandings } from "../types.js";
import type { CodeforcesClient } from "../client.js";

const now = (): string => new Date().toISOString();

const handleKey = (handle: string): string => handle.toLowerCase();

export const parseCachedJson = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

type ContestCacheKind = "standings" | "ratingChanges";

const CACHE_TABLES: Record<ContestCacheKind, string> = {
  standings: "contest_standings_cache",
  ratingChanges: "contest_rating_changes_cache",
};

export const getOrFetchContestCache = async <T>(
  db: Db,
  kind: ContestCacheKind,
  contestId: number,
  fetcher: () => Promise<T>,
): Promise<T> => {
  const table = CACHE_TABLES[kind];
  const cached = db
    .prepare(`SELECT raw_json FROM ${table} WHERE contest_id = @contestId`)
    .get({ contestId }) as { raw_json: string } | undefined;
  const parsed = parseCachedJson<T>(cached?.raw_json);
  if (parsed !== undefined) return parsed;

  const data = await fetcher();
  db.prepare(
    `
    INSERT INTO ${table} (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
    ON CONFLICT(contest_id) DO UPDATE SET
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at
  `,
  ).run({ contestId, rawJson: JSON.stringify(data), fetchedAt: now() });
  return data;
};

export const getCachedStandings = (db: Db, contestId: number): CfStandings | undefined => {
  const cached = db
    .prepare("SELECT raw_json FROM contest_standings_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { raw_json: string } | undefined;
  return parseCachedJson<CfStandings>(cached?.raw_json);
};

export const getOrFetchRatingChanges = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
): Promise<CfRatingChange[]> => {
  return getOrFetchContestCache(db, "ratingChanges", contestId, () => client.contestRatingChanges(contestId));
};

export const getOrFetchStandings = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
): Promise<CfStandings> => {
  return getOrFetchContestCache(db, "standings", contestId, () => client.contestStandings(contestId));
};

export const getOrCalculatePerformance = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
  handle: string,
): Promise<number | null> => {
  const key = handleKey(handle);
  const cached = db
    .prepare(
      `
      SELECT performance
      FROM contest_performance_cache
      WHERE contest_id = @contestId AND handle_key = @handleKey
    `,
    )
    .get({ contestId, handleKey: key }) as { performance: number | null } | undefined;
  if (cached) return cached.performance;

  const changes = await getOrFetchRatingChanges(db, client, contestId);
  const performance = estimateContestPerformance(changes, handle)?.performance ?? null;
  db.prepare(
    `
    INSERT INTO contest_performance_cache (
      contest_id,
      handle_key,
      handle,
      performance,
      calculated_at
    ) VALUES (
      @contestId,
      @handleKey,
      @handle,
      @performance,
      @calculatedAt
    )
    ON CONFLICT(contest_id, handle_key) DO UPDATE SET
      handle = excluded.handle,
      performance = excluded.performance,
      calculated_at = excluded.calculated_at
  `,
  ).run({
    contestId,
    handleKey: key,
    handle,
    performance,
    calculatedAt: now(),
  });
  return performance;
};
