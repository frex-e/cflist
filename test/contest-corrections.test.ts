import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CodeforcesClient } from "../src/cf/client.js";
import {
  backfillUserContestPerformances,
  getCachedStandings,
  invalidateContestCaches,
} from "../src/cf/sync/cache.js";
import {
  collectContestsNeedingRefresh,
  contestsWithStaleCache,
  detectContestCorrections,
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
const recentCatalogSyncAt = new Date(Date.now() - 60_000).toISOString();

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

const seedContest = (db: DatabaseSync): void => {
  db.prepare(
    `
    INSERT INTO contests (id, name, start_time_seconds, duration_seconds, raw_json, updated_at)
    VALUES (100, 'Codeforces Round 100 (Div. 2)', 1000, 7200, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
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
    rank: number;
    oldRating: number;
    newRating: number;
    performance?: number | null;
  },
): void => {
  seedProblem(db, { contestId, index: "A", name: "A", canonicalId: "100A" });
  db.prepare(
    `
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, points, penalty, old_rating, new_rating, rating_delta, performance, last_checked_at
    ) VALUES (
      @userId, @contestId, @rank, 1, 30, @oldRating, @newRating, @ratingDelta, @performance, '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({
    userId,
    contestId,
    rank: values.rank,
    oldRating: values.oldRating,
    newRating: values.newRating,
    ratingDelta: values.newRating - values.oldRating,
    performance: values.performance ?? 1600,
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
  ).run({ userId, contestId });
};

const seedCaches = (db: DatabaseSync, fetchedAt: string): void => {
  const standings: CfStandings = {
    contest: { id: contestId, name: "Round 100", startTimeSeconds: 1000, durationSeconds: 7200 },
    problems: [{ contestId, index: "A", name: "A", tags: [] }],
    rows: [{
      party: { contestId, members: [{ handle: cfHandle }], participantType: "CONTESTANT" },
      rank: 2,
      points: 1,
      penalty: 30,
      problemResults: [{ points: 1, bestSubmissionTimeSeconds: 1200, rejectedAttemptCount: 0 }],
    }],
  };
  const ratingChanges: CfRatingChange[] = [{
    contestId,
    contestName: "Round 100",
    handle: cfHandle,
    rank: 2,
    ratingUpdateTimeSeconds: 9000,
    oldRating: 1500,
    newRating: 1510,
  }];

  db.prepare(
    `
    INSERT INTO contest_standings_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
  `,
  ).run({ contestId, rawJson: JSON.stringify(standings), fetchedAt });
  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
  `,
  ).run({ contestId, rawJson: JSON.stringify(ratingChanges), fetchedAt });
  db.prepare(
    `
    INSERT INTO contest_performance_cache (contest_id, user_id, performance, calculated_at)
    VALUES (@contestId, @userId, 1600, @fetchedAt)
  `,
  ).run({ contestId, userId, fetchedAt });
};

class CorrectionClient {
  standingsCalls = 0;
  ratingChangesCalls = 0;
  apiRank = 3;
  apiNewRating = 1520;

  async contests(): Promise<CfContest[]> {
    return [{
      id: contestId,
      name: "Codeforces Round 100 (Div. 2)",
      phase: "FINISHED",
      startTimeSeconds: 1000,
      durationSeconds: 7200,
    }];
  }

  async problemset(): Promise<CfProblemset> {
    return {
      problems: [{ contestId, index: "A", name: "A", tags: [] }],
      problemStatistics: [{ contestId, index: "A", solvedCount: 100 }],
    };
  }

  async userStatus(): Promise<CfSubmission[]> {
    return [{
      id: 1,
      contestId,
      creationTimeSeconds: 1200,
      verdict: "OK",
      problem: { contestId, index: "A", name: "A", tags: [] },
    }];
  }

  async userRating(): Promise<CfRatingChange[]> {
    return [{
      contestId,
      contestName: "Codeforces Round 100 (Div. 2)",
      handle: cfHandle,
      rank: this.apiRank,
      ratingUpdateTimeSeconds: 9000,
      oldRating: 1500,
      newRating: this.apiNewRating,
    }];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    this.ratingChangesCalls += 1;
    return [{
      contestId,
      contestName: "Codeforces Round 100 (Div. 2)",
      handle: cfHandle,
      rank: this.apiRank,
      ratingUpdateTimeSeconds: 9000,
      oldRating: 1500,
      newRating: this.apiNewRating,
    }];
  }

  async contestStandings(): Promise<CfStandings> {
    this.standingsCalls += 1;
    return {
      contest: { id: contestId, name: "Round 100", startTimeSeconds: 1000, durationSeconds: 7200 },
      problems: [{ contestId, index: "A", name: "A", tags: [] }],
      rows: [{
        party: { contestId, members: [{ handle: cfHandle }], participantType: "CONTESTANT" },
        rank: this.apiRank,
        points: 1,
        penalty: 30,
        problemResults: [{ points: 1, bestSubmissionTimeSeconds: 1200, rejectedAttemptCount: 0 }],
      }],
    };
  }
}

test("invalidateContestCaches removes shared caches and clears performance", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510, performance: 1600 });
  seedCaches(db, "2026-01-01T00:00:00.000Z");

  invalidateContestCaches(db, contestId);

  assert.equal(getCachedStandings(db, contestId), undefined);
  const ratingCache = db.prepare("SELECT COUNT(*) AS count FROM contest_rating_changes_cache").get() as { count: number };
  assert.equal(ratingCache.count, 0);
  const performance = db.prepare(
    "SELECT performance FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
  ).get({ userId, contestId }) as { performance: number | null };
  assert.equal(performance.performance, null);
  db.close();
});

test("detectContestCorrections finds rank and rating mismatches", () => {
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

test("isContestCacheStale respects TTL and partial caches", () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);

  assert.equal(isContestCacheStale(db, contestId, 14), false);

  const fresh = new Date().toISOString();
  db.prepare(
    "INSERT INTO contest_standings_cache (contest_id, raw_json, fetched_at) VALUES (?, '{}', ?)",
  ).run(contestId, fresh);
  assert.equal(isContestCacheStale(db, contestId, 14), true);

  db.prepare(
    "INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at) VALUES (?, '[]', ?)",
  ).run(contestId, fresh);
  assert.equal(isContestCacheStale(db, contestId, 14), false);

  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE contest_standings_cache SET fetched_at = ? WHERE contest_id = ?").run(stale, contestId);
  assert.equal(isContestCacheStale(db, contestId, 14), true);
  assert.deepEqual(contestsWithStaleCache(db, [contestId], 14, 10), [contestId]);
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

test("hydrateUserContestResult with force bypasses skip and re-hydrates from standings", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510 });

  const updatedStandings: CfStandings = {
    contest: { id: contestId, name: "Round 100", startTimeSeconds: 1000, durationSeconds: 7200 },
    problems: [{ contestId, index: "A", name: "A", tags: [] }],
    rows: [{
      party: { contestId, members: [{ handle: cfHandle }], participantType: "CONTESTANT" },
      rank: 4,
      points: 1,
      penalty: 30,
      problemResults: [{ points: 1, bestSubmissionTimeSeconds: 1200, rejectedAttemptCount: 0 }],
    }],
  };
  db.prepare(
    `
    INSERT INTO contest_standings_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ contestId, rawJson: JSON.stringify(updatedStandings) });

  const client = new CorrectionClient();

  await hydrateUserContestResult(
    db,
    userId,
    cfHandle,
    contestId,
    client as unknown as CodeforcesClient,
    { force: true },
  );

  assert.equal(client.standingsCalls, 0);
  const row = db.prepare(
    "SELECT rank FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
  ).get({ userId, contestId }) as { rank: number };
  assert.equal(row.rank, 4);
  db.close();
});

test("rating sync clears performance before hydration recomputes it", async () => {
  const db = new DatabaseSync(":memory:");
  setupBase(db);
  seedStoredContestResult(db, { rank: 2, oldRating: 1500, newRating: 1510, performance: 1600 });
  seedCaches(db, "2026-01-01T00:00:00.000Z");
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new CorrectionClient();
    client.apiRank = 2;
    client.apiNewRating = 1520;
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const afterBasic = db.prepare(
      "SELECT performance, new_rating FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
    ).get({ userId, contestId }) as { performance: number | null; new_rating: number };

    assert.equal(afterBasic.new_rating, 1520);
    backfillUserContestPerformances(db, userId);
    const afterBackfill = db.prepare(
      "SELECT performance FROM user_contest_results WHERE user_id = @userId AND contest_id = @contestId",
    ).get({ userId, contestId }) as { performance: number | null };
    assert.notEqual(afterBackfill.performance, 1600);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});
