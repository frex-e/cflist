import assert from "node:assert/strict";
import test from "node:test";
import { maybeStartUserSync, syncDueActiveUsers } from "../src/cf/sync/auto-user-sync.js";
import { syncState } from "../src/cf/sync/state.js";
import {
  listActiveUsersDueForDailySync,
  listUsersNeedingPostContestSync,
} from "../src/db/queries.js";
import { createTestDb, signUp, withTestApp } from "./helpers.js";

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
): void => {
  db.prepare(
    `
    INSERT INTO "session" (
      id, expiresAt, token, createdAt, updatedAt, userId
    ) VALUES (
      @id, '2099-01-01T00:00:00.000Z', @token, @updatedAt, @updatedAt, @userId
    )
  `,
  ).run({
    id: `session-${userId}-${updatedAt}`,
    token: `token-${userId}-${updatedAt}`,
    updatedAt,
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

test("listActiveUsersDueForDailySync includes recent sessions without a fresh sync", () => {
  const db = createTestDb();
  try {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    insertUser(db, "active-due", "active-due@example.com");
    insertUser(db, "active-fresh", "active-fresh@example.com");
    insertUser(db, "stale-session", "stale@example.com");
    insertUser(db, "no-handle", "no-handle@example.com", "");

    insertSession(db, "active-due", "2026-08-01T12:00:00.000Z");
    insertSession(db, "active-fresh", "2026-08-02T10:00:00.000Z");
    insertSession(db, "stale-session", "2026-07-20T12:00:00.000Z");
    insertSession(db, "no-handle", "2026-08-02T10:00:00.000Z");

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
    db.prepare(
      `
      INSERT INTO contests (
        id, name, phase, duration_seconds, start_time_seconds, raw_json, updated_at
      ) VALUES (
        1, 'Ended Contest', 'FINISHED', 7200, @start, '{}', '2026-08-02T00:00:00.000Z'
      )
    `,
    ).run({ start: nowSeconds - 4 * 3600 });

    // Still running.
    db.prepare(
      `
      INSERT INTO contests (
        id, name, phase, duration_seconds, start_time_seconds, raw_json, updated_at
      ) VALUES (
        2, 'Live Contest', 'CODING', 7200, @start, '{}', '2026-08-02T00:00:00.000Z'
      )
    `,
    ).run({ start: nowSeconds - 1800 });

    // Ended 3 days ago (outside lookback).
    db.prepare(
      `
      INSERT INTO contests (
        id, name, phase, duration_seconds, start_time_seconds, raw_json, updated_at
      ) VALUES (
        3, 'Old Contest', 'FINISHED', 7200, @start, '{}', '2026-07-30T00:00:00.000Z'
      )
    `,
    ).run({ start: nowSeconds - 3 * DAY_MS / 1000 - 7200 });

    for (const [userId, contestId] of [
      ["needs-sync", 1],
      ["already-synced", 1],
      ["future-contest", 2],
      ["needs-sync", 3],
    ] as const) {
      db.prepare(
        `
        INSERT INTO user_contest_results (user_id, contest_id, rank, points, last_checked_at)
        VALUES (@userId, @contestId, 1, 500, '2026-08-01T00:00:00.000Z')
      `,
      ).run({ userId, contestId });
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
