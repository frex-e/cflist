import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CodeforcesClient } from "../src/cf/client.js";
import {
  invalidateContestCaches,
} from "../src/cf/sync/cache.js";
import {
  collectContestsNeedingRefresh,
  contestsWithStaleCache,
  detectContestCorrections,
  detectVanishedRatedContests,
  isContestCacheStale,
} from "../src/cf/sync/contest-corrections.js";
import { hydrateUserContestResult } from "../src/cf/sync/contest-hydration.js";
import { syncState, syncUserStatus } from "../src/cf/sync.js";
import type { CfContest, CfProblemset, CfRatingChange, CfStandings, CfSubmission } from "../src/cf/types.js";
import { migrate } from "../src/db/migrate.js";
import { seedProblem } from "./helpers.js";

const userId = "user-1";
const cfHandle = "inj";
const contestId = 100;
const keptContestId = 90;
const recentCatalogSyncAt = new Date(Date.now() - 60_000).toISOString();
const freshCheck = (): string => new Date().toISOString();
const staleCheck = (): string => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const insertUser = (db: DatabaseSync): void => {
  db.prepare(
    `
    INSERT INTO "user" (
      id, name, email, emailVerified, createdAt, updatedAt, cfHandle
    ) VALUES (
      @id, 'Test User', 'user@example.com', 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', @cfHandle
    )
  `,
  ).run({ id: userId, cfHandle });
};

const seedContestRow = (db: DatabaseSync, id: number, startTimeSeconds = 1000): void => {
  db.prepare(
    `
    INSERT INTO contests (id, name, start_time_seconds, duration_seconds, raw_json, updated_at)
    VALUES (@id, @name, @startTimeSeconds, 7200, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run({ id, name: `Codeforces Round ${id} (Div. 2)`, startTimeSeconds });
};

const seedContest = (db: DatabaseSync): void => {
  seedContestRow(db, contestId);
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, message)
    VALUES (@finishedAt, @finishedAt, 'success', 'codeforces:catalog', 'fresh')
  `,
  ).run({ finishedAt: recentCatalogSyncAt });
};

const setupBase = (db: DatabaseSync): void => {
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  seedContest(db);
};

const seedStoredContestResult = (
  db: DatabaseSync,
  values: {
    contestId?: number;
    rank?: number | null;
    oldRating?: number | null;
    newRating?: number | null;
    performance?: number | null;
    standingsCheckedAt?: string | null;
  } = {},
): void => {
  const id = values.contestId ?? contestId;
  const rank = values.rank ?? 2;
  const oldRating = values.oldRating === undefined ? 1500 : values.oldRating;
  const newRating = values.newRating === undefined ? 1510 : values.newRating;
  seedProblem(db, { contestId: id, index: "A", name: "A", canonicalId: `${id}A` });
  db.prepare(
    `
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, points, penalty, old_rating, new_rating, rating_delta,
      performance, last_checked_at, standings_checked_at
    ) VALUES (
      @userId, @contestId, @rank, 1, 30, @oldRating, @newRating, @ratingDelta,
      @performance, '2026-01-01T00:00:00.000Z', @standingsCheckedAt
    )
  `,
  ).run({
    userId,
    contestId: id,
    rank,
    oldRating,
    newRating,
    ratingDelta: oldRating !== null && newRating !== null ? newRating - oldRating : null,
    performance: values.performance === undefined ? 1600 : values.performance,
    standingsCheckedAt: values.standingsCheckedAt ?? "2026-01-01T00:00:00.000Z",
  });
  db.prepare(
    `
    INSERT INTO user_contest_problem_results (
      user_id, contest_id, problem_index, points, penalty, rejected_attempt_count,
      best_submission_time_seconds, solved_in_contest, upsolved
    ) VALUES (
      @userId, @contestId, 'A', 1, 0, 0, 1200, 1, 0
    )
  `,
  ).run({ userId, contestId: id });
};

const seedCaches = (db: DatabaseSync, fetchedAt: string, id: number = contestId): void => {
  const ratingChanges: CfRatingChange[] = [ratingChangeFor(id, 1500, 1510)];

  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
  `,
  ).run({ contestId: id, rawJson: JSON.stringify(ratingChanges), fetchedAt });
  db.prepare(
    `
    INSERT INTO contest_performance_cache (contest_id, user_id, performance, calculated_at)
    VALUES (@contestId, @userId, 1600, @fetchedAt)
  `,
  ).run({ contestId: id, userId, fetchedAt });
};

const ratingChangeFor = (
  id: number,
  oldRating: number,
  newRating: number,
  rank = 2,
): CfRatingChange => ({
  contestId: id,
  contestName: `Codeforces Round ${id} (Div. 2)`,
  handle: cfHandle,
  rank,
  ratingUpdateTimeSeconds: 9000,
  oldRating,
  newRating,
});

const contestResultRow = (db: DatabaseSync, id: number = contestId) => {
  return db.prepare(
    `
    SELECT rank, points, penalty, old_rating, new_rating, rating_delta, performance, standings_checked_at
    FROM user_contest_results
    WHERE user_id = @userId AND contest_id = @contestId
  `,
  ).get({ userId, contestId: id }) as {
    rank: number | null;
    points: number | null;
    penalty: number | null;
    old_rating: number | null;
    new_rating: number | null;
    rating_delta: number | null;
    performance: number | null;
    standings_checked_at: string | null;
  };
};

const pillCount = (db: DatabaseSync, id: number = contestId): number => {
  const row = db.prepare(
    `
    SELECT COUNT(*) AS count
    FROM user_contest_problem_results
    WHERE user_id = @userId AND contest_id = @contestId
  `,
  ).get({ userId, contestId: id }) as { count: number };
  return row.count;
};

const queuedContestIds = (db: DatabaseSync): number[] => {
  const rows = db.prepare(
    "SELECT contest_id FROM contest_sync_jobs WHERE user_id = @userId ORDER BY contest_id",
  ).all({ userId }) as { contest_id: number }[];
  return rows.map((row) => row.contest_id);
};

const latestUserSyncMessage = (db: DatabaseSync): string => {
  const syncRun = db.prepare(
    "SELECT message FROM sync_runs WHERE source = 'codeforces:user' ORDER BY id DESC LIMIT 1",
  ).get() as { message: string };
  return syncRun.message;
};

class CorrectionClient {
  standingsCalls = 0;
  ratingChangesCalls = 0;
  apiRank = 3;
  apiNewRating = 1520;
  ratingHistory: CfRatingChange[] | undefined = undefined;
  statusContestIds: number[] = [contestId];

  async contests(): Promise<CfContest[]> {
    const ids = new Set<number>([
      contestId,
      ...this.statusContestIds,
      ...(this.ratingHistory ?? []).map((change) => change.contestId),
    ]);
    return [...ids].map((id) => ({
      id,
      name: `Codeforces Round ${id} (Div. 2)`,
      phase: "FINISHED",
      startTimeSeconds: 1000,
      durationSeconds: 7200,
    }));
  }

  async problemset(): Promise<CfProblemset> {
    const ids = new Set<number>([
      contestId,
      ...this.statusContestIds,
      ...(this.ratingHistory ?? []).map((change) => change.contestId),
    ]);
    return {
      problems: [...ids].map((id) => ({ contestId: id, index: "A", name: "A", tags: [] })),
      problemStatistics: [...ids].map((id) => ({ contestId: id, index: "A", solvedCount: 100 })),
    };
  }

  async userStatus(): Promise<CfSubmission[]> {
    return this.statusContestIds.map((id, index) => ({
      id: index + 1,
      contestId: id,
      creationTimeSeconds: 1200,
      verdict: "OK",
      problem: { contestId: id, index: "A", name: "A", tags: [] },
    }));
  }

  async userRating(): Promise<CfRatingChange[]> {
    if (this.ratingHistory !== undefined) return this.ratingHistory;
    return [ratingChangeFor(contestId, 1500, this.apiNewRating, this.apiRank)];
  }

  async contestRatingChanges(id: number): Promise<CfRatingChange[]> {
    this.ratingChangesCalls += 1;
    const fromHistory = this.ratingHistory?.find((change) => change.contestId === id);
    if (fromHistory) return [fromHistory];
    return [ratingChangeFor(id, 1500, this.apiNewRating, this.apiRank)];
  }

  async contestStandings(id: number): Promise<CfStandings> {
    this.standingsCalls += 1;
    return {
      contest: { id, name: `Round ${id}`, startTimeSeconds: 1000, durationSeconds: 7200 },
      problems: [{ contestId: id, index: "A", name: "A", tags: [] }],
      rows: [{
        party: { contestId: id, members: [{ handle: cfHandle }], participantType: "CONTESTANT" },
        rank: this.apiRank,
        points: 1,
        penalty: 30,
        problemResults: [{ points: 1, bestSubmissionTimeSeconds: 1200, rejectedAttemptCount: 0 }],
      }],
    };
  }
}

test("invalidateContestCaches clears rating-change cache and standings freshness", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510, performance: 1600 });
  seedCaches(db, "2026-01-01T00:00:00.000Z");

  invalidateContestCaches(db, userId, contestId);

  const ratingCache = db.prepare("SELECT COUNT(*) AS count FROM contest_rating_changes_cache").get() as { count: number };
  assert.equal(ratingCache.count, 0);
  const performanceCache = db.prepare(
    "SELECT performance FROM contest_performance_cache WHERE contest_id = @contestId AND user_id = @userId",
  ).get({ contestId, userId }) as { performance: number } | undefined;
  assert.equal(performanceCache?.performance, 1600);
  const performance = db.prepare(
    "SELECT performance, standings_checked_at FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
  ).get({ userId, contestId }) as { performance: number | null; standings_checked_at: string | null };
  assert.equal(performance.performance, 1600);
  assert.equal(performance.standings_checked_at, null);
  db.close();
});

test("detectContestCorrections finds rating mismatches and ignores standings vs rating rank drift", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });

  const unchanged = detectContestCorrections(db, userId, new Map([
    [contestId, {
      contestId,
      contestName: "Round 100",
      handle: cfHandle,
      rank: 2,
      ratingUpdateTimeSeconds: 9000,
      oldRating: 1500,
      newRating: 1510,
    }],
  ]));
  assert.deepEqual(unchanged, []);

  // Standings rank and /user.rating rank often differ for the same round.
  const rankOnlyDrift = detectContestCorrections(db, userId, new Map([
    [contestId, {
      contestId,
      contestName: "Round 100",
      handle: cfHandle,
      rank: 99,
      ratingUpdateTimeSeconds: 9000,
      oldRating: 1500,
      newRating: 1510,
    }],
  ]));
  assert.deepEqual(rankOnlyDrift, []);

  const corrected = detectContestCorrections(db, userId, new Map([
    [contestId, {
      contestId,
      contestName: "Round 100",
      handle: cfHandle,
      rank: 3,
      ratingUpdateTimeSeconds: 9000,
      oldRating: 1500,
      newRating: 1520,
    }],
  ]));
  assert.deepEqual(corrected, [contestId]);
  db.close();
});

test("isContestCacheStale uses per-user standings freshness and only requires ratings for rated contests", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);

  assert.equal(isContestCacheStale(db, userId, contestId, 14), false);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });

  const fresh = new Date().toISOString();
  db.prepare("UPDATE user_contest_results SET standings_checked_at = NULL").run();
  assert.equal(isContestCacheStale(db, userId, contestId, 14), true);

  db.prepare("UPDATE user_contest_results SET standings_checked_at = ?").run(fresh);
  assert.equal(isContestCacheStale(db, userId, contestId, 14), true);
  // Empty rating-changes cache is a negative/"unavailable" marker, not usable data.
  db.prepare(
    "INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at) VALUES (?, '[]', ?)",
  ).run(contestId, fresh);
  assert.equal(isContestCacheStale(db, userId, contestId, 14), true);
  db.prepare("DELETE FROM contest_rating_changes_cache WHERE contest_id = ?").run(contestId);
  seedCaches(db, fresh);
  assert.equal(isContestCacheStale(db, userId, contestId, 14), false);

  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE user_contest_results SET standings_checked_at = ?").run(stale);
  assert.equal(isContestCacheStale(db, userId, contestId, 14), true);
  assert.deepEqual(contestsWithStaleCache(db, userId, [contestId], 14, 10), [contestId]);

  db.prepare(
    "UPDATE user_contest_results SET standings_checked_at = ?, old_rating = NULL, new_rating = NULL, rating_delta = NULL",
  ).run(fresh);
  db.prepare("DELETE FROM contest_rating_changes_cache").run();
  assert.equal(isContestCacheStale(db, userId, contestId, 14), false);
  db.close();
});

test("collectContestsNeedingRefresh merges divergence and TTL results", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });
  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  seedCaches(db, stale);

  const refreshIds = collectContestsNeedingRefresh(
    db,
    userId,
    new Map([[contestId, {
      contestId,
      contestName: "Round 100",
      handle: cfHandle,
      rank: 2,
      ratingUpdateTimeSeconds: 9000,
      oldRating: 1500,
      newRating: 1510,
    }]]),
    [contestId],
  );
  assert.deepEqual(refreshIds, [contestId]);
  db.close();
});

test("syncUserStatus invalidates caches and re-fetches standings after Codeforces correction", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510, performance: 1600 });
  seedCaches(db, "2026-01-01T00:00:00.000Z");
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new CorrectionClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    assert.ok(client.standingsCalls >= 1);
    const row = db.prepare(
      `
      SELECT rank, new_rating, performance
      FROM user_contest_results
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    ).get({ userId, contestId }) as { rank: number; new_rating: number; performance: number | null };

    assert.equal(row.rank, 3);
    assert.equal(row.new_rating, 1520);

    const syncRun = db.prepare(
      "SELECT message FROM sync_runs WHERE source = 'codeforces:user' ORDER BY id DESC LIMIT 1",
    ).get() as { message: string };
    assert.match(syncRun.message, /refreshed 1 contest after Codeforces updates/);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("hydrateUserContestResult with force re-fetches standings and filters locally", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });

  const client = new CorrectionClient();

  await hydrateUserContestResult(
    db,
    userId,
    cfHandle,
    contestId,
    client as unknown as CodeforcesClient,
    { force: true },
  );

  assert.equal(client.standingsCalls, 1);
  const row = db.prepare(
    "SELECT rank, standings_checked_at FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
  ).get({ userId, contestId }) as { rank: number; standings_checked_at: string | null };
  assert.equal(row.rank, 3);
  assert.ok(row.standings_checked_at);
  db.close();
});

test("rating sync keeps previous performance until hydration recomputes it", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510, performance: 1600 });
  seedCaches(db, "2026-01-01T00:00:00.000Z");
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    invalidateContestCaches(db, userId, contestId);
    const afterInvalidate = db.prepare(
      "SELECT performance, standings_checked_at FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
    ).get({ userId, contestId }) as { performance: number | null; standings_checked_at: string | null };
    assert.equal(afterInvalidate.performance, 1600);
    assert.equal(afterInvalidate.standings_checked_at, null);

    const client = new CorrectionClient();
    client.apiRank = 2;
    client.apiNewRating = 1520;
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const afterSync = db.prepare(
      "SELECT performance, new_rating FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
    ).get({ userId, contestId }) as { performance: number | null; new_rating: number };

    assert.equal(afterSync.new_rating, 1520);
    assert.notEqual(afterSync.performance, null);
    assert.notEqual(afterSync.performance, 1600);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("collectContestsNeedingRefresh includes contests still in system test", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);

  try {
    const freshCheck = new Date().toISOString();
    seedStoredContestResult(db, {
      rank: 2,
      oldRating: 1500,
      newRating: 1510,
      standingsCheckedAt: freshCheck,
    });
    db.prepare(`UPDATE contests SET phase = 'SYSTEM_TEST' WHERE id = @contestId`).run({ contestId });

    const ratings = new Map<number, CfRatingChange>([
      [
        contestId,
        {
          contestId,
          contestName: "Codeforces Round 100 (Div. 2)",
          handle: cfHandle,
          rank: 2,
          ratingUpdateTimeSeconds: 9000,
          oldRating: 1500,
          newRating: 1510,
        },
      ],
    ]);

    const refreshIds = collectContestsNeedingRefresh(db, userId, ratings, [contestId]);
    assert.deepEqual(refreshIds, [contestId]);
  } finally {
    db.close();
  }
});

const seedKeptRatedContest = (db: DatabaseSync): void => {
  seedContestRow(db, keptContestId, 500);
  seedStoredContestResult(db, {
    contestId: keptContestId,
    rank: 2,
    oldRating: 1400,
    newRating: 1500,
    performance: 1550,
    standingsCheckedAt: freshCheck(),
  });
  seedCaches(db, freshCheck(), keptContestId);
};

const vanishSyncClient = (vanishedIds: number[]): CorrectionClient => {
  const client = new CorrectionClient();
  client.statusContestIds = [keptContestId, ...vanishedIds];
  client.ratingHistory = [ratingChangeFor(keptContestId, 1400, 1500)];
  return client;
};

const resetSyncState = (): void => {
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;
};

test("detectVanishedRatedContests finds stored rated contests missing from /user.rating", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });
  seedContestRow(db, keptContestId, 500);
  seedStoredContestResult(db, {
    contestId: keptContestId,
    oldRating: 1400,
    newRating: 1500,
  });

  const vanished = detectVanishedRatedContests(db, userId, new Map([
    [keptContestId, ratingChangeFor(keptContestId, 1400, 1500)],
  ]));
  assert.deepEqual(vanished, [contestId]);

  const unrated = detectVanishedRatedContests(db, userId, new Map([
    [keptContestId, ratingChangeFor(keptContestId, 1400, 1500)],
    [contestId, ratingChangeFor(contestId, 1500, 1510)],
  ]));
  assert.deepEqual(unrated, []);
  db.close();
});

test("detectVanishedRatedContests does not clear when /user.rating is empty", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });

  assert.deepEqual(detectVanishedRatedContests(db, userId, new Map()), []);
  db.close();
});

test("detectVanishedRatedContests ignores stored unrated contests missing from the API", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, {
    rank: 2,
    oldRating: null,
    newRating: null,
    performance: null,
  });
  seedContestRow(db, keptContestId, 500);
  seedStoredContestResult(db, {
    contestId: keptContestId,
    oldRating: 1400,
    newRating: 1500,
  });

  const vanished = detectVanishedRatedContests(db, userId, new Map([
    [keptContestId, ratingChangeFor(keptContestId, 1400, 1500)],
  ]));
  assert.deepEqual(vanished, []);
  db.close();
});

test("collectContestsNeedingRefresh excludes vanished contests even when TTL-stale", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  const ttlContestId = 101;
  seedContestRow(db, ttlContestId, 2000);
  seedStoredContestResult(db, {
    rank: 2,
    oldRating: 1500,
    newRating: 1510,
    standingsCheckedAt: staleCheck(),
  });
  seedStoredContestResult(db, {
    contestId: ttlContestId,
    rank: 4,
    oldRating: 1510,
    newRating: 1520,
    standingsCheckedAt: staleCheck(),
  });
  seedCaches(db, staleCheck(), contestId);
  seedCaches(db, staleCheck(), ttlContestId);

  const refreshIds = collectContestsNeedingRefresh(
    db,
    userId,
    new Map([[ttlContestId, ratingChangeFor(ttlContestId, 1510, 1520)]]),
    [contestId, ttlContestId],
  );
  assert.deepEqual(refreshIds, [ttlContestId]);
  db.close();
});

test("syncUserStatus clears vanished ratings without re-fetching standings", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedKeptRatedContest(db);
  const vanishedStandingsAt = staleCheck();
  seedStoredContestResult(db, {
    rank: 2,
    oldRating: 1500,
    newRating: 1510,
    performance: 1600,
    standingsCheckedAt: vanishedStandingsAt,
  });
  seedCaches(db, vanishedStandingsAt);
  resetSyncState();

  try {
    const client = vanishSyncClient([contestId]);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    assert.equal(client.standingsCalls, 0);
    const vanished = contestResultRow(db, contestId);
    assert.equal(vanished.old_rating, null);
    assert.equal(vanished.new_rating, null);
    assert.equal(vanished.rating_delta, null);
    assert.equal(vanished.performance, null);
    assert.equal(vanished.rank, 2);
    assert.equal(vanished.points, 1);
    assert.equal(vanished.penalty, 30);
    assert.equal(vanished.standings_checked_at, vanishedStandingsAt);
    assert.equal(pillCount(db, contestId), 1);

    const performanceCache = db.prepare(
      "SELECT COUNT(*) AS count FROM contest_performance_cache WHERE user_id = @userId AND contest_id = @contestId",
    ).get({ userId, contestId }) as { count: number };
    assert.equal(performanceCache.count, 0);
    const ratingCache = db.prepare(
      "SELECT COUNT(*) AS count FROM contest_rating_changes_cache WHERE contest_id = @contestId",
    ).get({ contestId }) as { count: number };
    assert.equal(ratingCache.count, 0);

    const kept = contestResultRow(db, keptContestId);
    assert.equal(kept.new_rating, 1500);
    assert.equal(kept.old_rating, 1400);
    assert.ok(!queuedContestIds(db).includes(contestId));
    assert.match(latestUserSyncMessage(db), /cleared ratings for 1 contest missing from Codeforces history/);
    assert.doesNotMatch(latestUserSyncMessage(db), /refreshed \d+ contest/);
  } finally {
    db.close();
    resetSyncState();
  }
});

test("syncUserStatus does not clear ratings when /user.rating is empty", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  const standingsAt = freshCheck();
  seedStoredContestResult(db, {
    rank: 2,
    oldRating: 1500,
    newRating: 1510,
    performance: 1600,
    standingsCheckedAt: standingsAt,
  });
  seedCaches(db, standingsAt);
  resetSyncState();

  try {
    const client = new CorrectionClient();
    client.ratingHistory = [];
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const row = contestResultRow(db);
    assert.equal(row.new_rating, 1510);
    assert.equal(row.old_rating, 1500);
    assert.equal(row.rating_delta, 10);
    assert.equal(row.performance, 1600);
    assert.equal(row.standings_checked_at, standingsAt);
    assert.doesNotMatch(latestUserSyncMessage(db), /cleared ratings/);
  } finally {
    db.close();
    resetSyncState();
  }
});

test("syncUserStatus rehydrates ratings when Codeforces republishes a vanished contest", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedKeptRatedContest(db);
  seedStoredContestResult(db, {
    rank: 2,
    oldRating: 1500,
    newRating: 1510,
    performance: 1600,
    standingsCheckedAt: staleCheck(),
  });
  seedCaches(db, staleCheck());
  resetSyncState();

  try {
    const client = vanishSyncClient([contestId]);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    assert.equal(contestResultRow(db).new_rating, null);
    assert.equal(client.standingsCalls, 0);

    client.ratingHistory = [
      ratingChangeFor(keptContestId, 1400, 1500),
      ratingChangeFor(contestId, 1500, 1520, 3),
    ];
    client.apiNewRating = 1520;
    client.apiRank = 3;
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    assert.ok(client.standingsCalls >= 1);
    const row = contestResultRow(db);
    assert.equal(row.new_rating, 1520);
    assert.equal(row.old_rating, 1500);
    assert.equal(row.rank, 3);
    assert.match(latestUserSyncMessage(db), /refreshed 1 contest after Codeforces updates/);
  } finally {
    db.close();
    resetSyncState();
  }
});

test("syncUserStatus still invalidates and re-fetches after in-place rating changes", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510, performance: 1600 });
  seedCaches(db, "2026-01-01T00:00:00.000Z");
  resetSyncState();

  try {
    const client = new CorrectionClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    assert.ok(client.standingsCalls >= 1);
    const row = contestResultRow(db);
    assert.equal(row.rank, 3);
    assert.equal(row.new_rating, 1520);
    assert.match(latestUserSyncMessage(db), /refreshed 1 contest after Codeforces updates/);
    assert.doesNotMatch(latestUserSyncMessage(db), /cleared ratings/);
  } finally {
    db.close();
    resetSyncState();
  }
});

test("syncUserStatus leaves an unrated stored contest missing from /user.rating unchanged", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedKeptRatedContest(db);
  const standingsAt = freshCheck();
  seedStoredContestResult(db, {
    rank: 8,
    oldRating: null,
    newRating: null,
    performance: null,
    standingsCheckedAt: standingsAt,
  });
  resetSyncState();

  try {
    const client = vanishSyncClient([contestId]);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const row = contestResultRow(db);
    assert.equal(row.new_rating, null);
    assert.equal(row.old_rating, null);
    assert.equal(row.rank, 8);
    assert.equal(row.standings_checked_at, standingsAt);
    assert.equal(pillCount(db), 1);
    assert.equal(client.standingsCalls, 0);
    assert.doesNotMatch(latestUserSyncMessage(db), /cleared ratings/);
    assert.ok(!queuedContestIds(db).includes(contestId));
  } finally {
    db.close();
    resetSyncState();
  }
});

test("syncUserStatus clears several vanished contests in one sync and enqueues none of them", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedKeptRatedContest(db);
  const vanishedIds = [contestId, 101, 102, 103];
  for (const id of vanishedIds) {
    if (id !== contestId) seedContestRow(db, id, 1000 + id);
    seedStoredContestResult(db, {
      contestId: id,
      rank: 2,
      oldRating: 1500,
      newRating: 1510,
      performance: 1600,
      standingsCheckedAt: staleCheck(),
    });
    seedCaches(db, staleCheck(), id);
  }
  resetSyncState();

  try {
    const client = vanishSyncClient(vanishedIds);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    assert.equal(client.standingsCalls, 0);
    for (const id of vanishedIds) {
      const row = contestResultRow(db, id);
      assert.equal(row.new_rating, null);
      assert.equal(row.old_rating, null);
      assert.equal(row.rating_delta, null);
      assert.equal(row.performance, null);
      assert.equal(row.rank, 2);
      assert.equal(pillCount(db, id), 1);
    }
    const queued = queuedContestIds(db);
    for (const id of vanishedIds) {
      assert.ok(!queued.includes(id), `vanished contest ${id} should not be enqueued`);
    }
    assert.equal(contestResultRow(db, keptContestId).new_rating, 1500);
    assert.match(latestUserSyncMessage(db), /cleared ratings for 4 contests missing from Codeforces history/);
  } finally {
    db.close();
    resetSyncState();
  }
});
