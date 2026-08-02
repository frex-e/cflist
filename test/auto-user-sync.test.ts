import assert from "node:assert/strict";
import test from "node:test";
import type { CodeforcesClient } from "../src/cf/client.js";
import {
  AUTO_USER_SYNC_BATCH_LIMIT,
  maybeStartUserSync,
  runAutoUserSyncTick,
  syncDueActiveUsers,
  syncUsersForRecentlyEndedContests,
} from "../src/cf/sync/auto-user-sync.js";
import { setCodeforcesClientForTests } from "../src/cf/shared-client.js";
import { syncState } from "../src/cf/sync/state.js";
import {
  listActiveUsersDueForDailySync,
  listUsersNeedingPostContestSync,
} from "../src/db/queries.js";
import { createTestDb, signUp, withTestApp } from "./helpers.js";

const mockCfClient = {
  contests: async () => [],
  problemset: async () => ({ problems: [], problemStatistics: [] }),
  userStatus: async () => [],
  userRating: async () => [],
  contestStandings: async () => {
    throw new Error("contestStandings should not be called");
  },
  contestRatingChanges: async () => [],
} as unknown as CodeforcesClient;

const withMockCfClient = async (fn: () => void | Promise<void>): Promise<void> => {
  setCodeforcesClientForTests(mockCfClient);
  try {
    await fn();
    // Let fire-and-forget syncUserStatus settle (catalog/userStatus mocks resolve immediately).
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    setCodeforcesClientForTests(undefined);
  }
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const insertUser = (
  db: ReturnType<typeof createTestDb>,
  id: string,
  email: string,
  cfHandle = "tourist",
): void => {
  db.prepare(
    `
    INSERT INTO "user" (
      id, name, email, emailVerified, createdAt, updatedAt, cfHandle
    ) VALUES (
      @id, 'Test User', @email, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', @cfHandle
    )
  `,
  ).run({ id, email, cfHandle });
};

const insertSession = (
  db: ReturnType<typeof createTestDb>,
  userId: string,
  updatedAt: string,
  expiresAt = "2099-01-01T00:00:00.000Z",
): void => {
  db.prepare(
    `
    INSERT INTO "session" (
      id, expiresAt, token, createdAt, updatedAt, userId
    ) VALUES (
      @id, @expiresAt, @token, @updatedAt, @updatedAt, @userId
    )
  `,
  ).run({
    id: `session-${userId}-${updatedAt}`,
    token: `token-${userId}-${updatedAt}`,
    updatedAt,
    expiresAt,
    userId,
  });
};

const insertSuccessfulUserSync = (
  db: ReturnType<typeof createTestDb>,
  userId: string,
  finishedAt: string,
): void => {
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
    VALUES (@finishedAt, @finishedAt, 'success', 'codeforces:user', @userId, 'tourist', 'done')
  `,
  ).run({ userId, finishedAt });
};

const insertContest = (
  db: ReturnType<typeof createTestDb>,
  id: number,
  name: string,
  phase: string,
  startSeconds: number,
  durationSeconds = 7200,
): void => {
  db.prepare(
    `
    INSERT INTO contests (
      id, name, phase, duration_seconds, start_time_seconds, raw_json, updated_at
    ) VALUES (
      @id, @name, @phase, @durationSeconds, @start, '{}', '2026-08-02T00:00:00.000Z'
    )
  `,
  ).run({ id, name, phase, durationSeconds, start: startSeconds });
};

const insertContestResult = (
  db: ReturnType<typeof createTestDb>,
  userId: string,
  contestId: number,
): void => {
  db.prepare(
    `
    INSERT INTO user_contest_results (user_id, contest_id, rank, points, last_checked_at)
    VALUES (@userId, @contestId, 1, 500, '2026-08-01T00:00:00.000Z')
  `,
  ).run({ userId, contestId });
};

test("listActiveUsersDueForDailySync includes recent sessions without a fresh sync", () => {
  const db = createTestDb();
  try {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    insertUser(db, "active-due", "active-due@example.com");
    insertUser(db, "active-fresh", "active-fresh@example.com");
    insertUser(db, "stale-session", "stale@example.com");
    insertUser(db, "no-handle", "no-handle@example.com", "");
    insertUser(db, "expired-session", "expired@example.com");

    insertSession(db, "active-due", "2026-08-01T12:00:00.000Z");
    insertSession(db, "active-fresh", "2026-08-02T10:00:00.000Z");
    insertSession(db, "stale-session", "2026-07-20T12:00:00.000Z");
    insertSession(db, "no-handle", "2026-08-02T10:00:00.000Z");
    insertSession(db, "expired-session", "2026-08-02T10:00:00.000Z", "2026-08-01T00:00:00.000Z");

    insertSuccessfulUserSync(db, "active-fresh", "2026-08-02T06:00:00.000Z");
    insertSuccessfulUserSync(db, "active-due", "2026-07-30T12:00:00.000Z");

    const due = listActiveUsersDueForDailySync(db, {
      activeWithinMs: 7 * DAY_MS,
      minSyncAgeMs: DAY_MS,
      nowMs: now,
    });

    assert.deepEqual(
      due.map((user) => user.id).sort(),
      ["active-due"],
    );
  } finally {
    db.close();
  }
});

test("listUsersNeedingPostContestSync selects participants who have not synced since contest end", () => {
  const db = createTestDb();
  try {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const nowSeconds = Math.floor(now / 1000);

    insertUser(db, "needs-sync", "needs@example.com");
    insertUser(db, "already-synced", "synced@example.com");
    insertUser(db, "future-contest", "future@example.com");

    // Ended 2 hours ago (within 48h lookback).
    insertContest(db, 1, "Ended Contest", "FINISHED", nowSeconds - 4 * 3600);
    // Still running.
    insertContest(db, 2, "Live Contest", "CODING", nowSeconds - 1800);
    // Ended 3 days ago (outside lookback).
    insertContest(db, 3, "Old Contest", "FINISHED", nowSeconds - 3 * DAY_MS / 1000 - 7200);

    for (const [userId, contestId] of [
      ["needs-sync", 1],
      ["already-synced", 1],
      ["future-contest", 2],
      ["needs-sync", 3],
    ] as const) {
      insertContestResult(db, userId, contestId);
    }

    // Synced before contest 1 ended.
    insertSuccessfulUserSync(db, "needs-sync", "2026-08-02T08:00:00.000Z");
    // Synced after contest 1 ended.
    insertSuccessfulUserSync(db, "already-synced", "2026-08-02T11:00:00.000Z");

    const users = listUsersNeedingPostContestSync(db, {
      lookbackMs: 48 * HOUR_MS,
      nowMs: now,
    });

    assert.deepEqual(
      users.map((user) => user.id).sort(),
      ["needs-sync"],
    );
  } finally {
    db.close();
  }
});

test("listUsersNeedingPostContestSync selects user when sync sits between two contest ends", () => {
  const db = createTestDb();
  try {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const nowSeconds = Math.floor(now / 1000);

    insertUser(db, "between", "between@example.com");
    // Contest A ended 6h ago; contest B ended 1h ago.
    insertContest(db, 10, "Earlier", "FINISHED", nowSeconds - 8 * 3600);
    insertContest(db, 11, "Later", "FINISHED", nowSeconds - 3 * 3600);
    insertContestResult(db, "between", 10);
    insertContestResult(db, "between", 11);

    // Synced after A ended but before B ended.
    insertSuccessfulUserSync(db, "between", "2026-08-02T07:00:00.000Z");

    const users = listUsersNeedingPostContestSync(db, {
      lookbackMs: 48 * HOUR_MS,
      nowMs: now,
    });

    assert.deepEqual(
      users.map((user) => user.id),
      ["between"],
    );
  } finally {
    db.close();
  }
});

test("maybeStartUserSync respects empty handle, in-flight sync, and cooldown", () => {
  const db = createTestDb();
  try {
    insertUser(db, "user-1", "user@example.com");
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    insertSuccessfulUserSync(db, "user-1", "2026-08-02T11:30:00.000Z");

    assert.equal(maybeStartUserSync(db, { id: "user-1", cfHandle: "   " }, HOUR_MS), false);

    syncState.userRunning.add("user-1");
    assert.equal(maybeStartUserSync(db, { id: "user-1", cfHandle: "tourist" }, HOUR_MS), false);
    syncState.userRunning.delete("user-1");

    // Huge interval keeps the recent successful sync inside the cooldown window regardless of wall clock.
    assert.equal(
      maybeStartUserSync(db, { id: "user-1", cfHandle: "tourist" }, 365 * DAY_MS),
      false,
    );

    assert.equal(syncDueActiveUsers(db, now), 0);
  } finally {
    syncState.userRunning.delete("user-1");
    db.close();
  }
});

test("post-contest sync starts despite recent hourly cooldown", async () => {
  const db = createTestDb();
  try {
    await withMockCfClient(async () => {
      const now = Date.parse("2026-08-02T12:00:00.000Z");
      const nowSeconds = Math.floor(now / 1000);

      insertUser(db, "post", "post@example.com");
      // Contest ended 15 minutes ago; user synced 30 minutes ago (before end, inside hourly window).
      insertContest(db, 1, "Ended", "FINISHED", nowSeconds - 8100);
      insertContestResult(db, "post", 1);
      insertSuccessfulUserSync(db, "post", "2026-08-02T11:30:00.000Z");

      assert.equal(maybeStartUserSync(db, { id: "post", cfHandle: "tourist" }, HOUR_MS), false);

      const started = syncUsersForRecentlyEndedContests(db, now, 1);
      assert.equal(started, 1);
    });
  } finally {
    syncState.userRunning.delete("post");
    db.close();
  }
});

test("runAutoUserSyncTick prioritizes post-contest and respects shared batch limit", async () => {
  const db = createTestDb();
  try {
    await withMockCfClient(async () => {
      const now = Date.parse("2026-08-02T12:00:00.000Z");
      const nowSeconds = Math.floor(now / 1000);

      for (let i = 0; i < AUTO_USER_SYNC_BATCH_LIMIT + 2; i += 1) {
        const id = `post-${i}`;
        insertUser(db, id, `${id}@example.com`);
        insertContest(db, 100 + i, `Contest ${i}`, "FINISHED", nowSeconds - 4 * 3600);
        insertContestResult(db, id, 100 + i);
        insertSuccessfulUserSync(db, id, "2026-08-02T08:00:00.000Z");
      }

      for (let i = 0; i < 2; i += 1) {
        const id = `daily-${i}`;
        insertUser(db, id, `${id}@example.com`);
        insertSession(db, id, "2026-08-01T12:00:00.000Z");
        insertSuccessfulUserSync(db, id, "2026-07-30T12:00:00.000Z");
      }

      const { postContest, daily } = runAutoUserSyncTick(db, now, AUTO_USER_SYNC_BATCH_LIMIT);
      assert.equal(postContest, AUTO_USER_SYNC_BATCH_LIMIT);
      assert.equal(daily, 0);
    });
  } finally {
    for (let i = 0; i < AUTO_USER_SYNC_BATCH_LIMIT + 2; i += 1) {
      syncState.userRunning.delete(`post-${i}`);
    }
    syncState.userRunning.delete("daily-0");
    syncState.userRunning.delete("daily-1");
    db.close();
  }
});

test("skipInitialSync disables login auto-sync on session create", async () => {
  await withTestApp(async (app, db) => {
    await signUp(app, db, "login-auto@example.com", "inj");
    const user = db
      .prepare(`SELECT id FROM "user" WHERE email = 'login-auto@example.com'`)
      .get() as { id: string };

    assert.equal(syncState.userRunning.has(user.id), false);

    const running = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM sync_runs
        WHERE user_id = @userId
          AND source = 'codeforces:user'
          AND status = 'running'
      `,
      )
      .get({ userId: user.id }) as { count: number };

    // helpers.signUp inserts a success row; no additional running auto-sync should start.
    assert.equal(running.count, 0);
  });
});
