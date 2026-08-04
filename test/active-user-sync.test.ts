import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ACTIVE_USER_WINDOW_MS,
  AUTOMATIC_USER_SYNC_INTERVAL_MS,
  syncActiveUsers,
  syncState,
} from "../src/cf/sync.js";
import { listUsersDueForAutomaticSync } from "../src/db/queries.js";
import { migrate } from "../src/db/migrate.js";

const NOW_MS = Date.parse("2026-08-04T04:00:00.000Z");

const insertUser = (
  db: DatabaseSync,
  id: string,
  lastLoginAt: string,
  cfHandle: string = id,
): void => {
  db.prepare(
    `
    INSERT INTO "user" (
      id, name, email, emailVerified, createdAt, updatedAt, cfHandle, lastLoginAt
    ) VALUES (
      @id, @id, @email, 1, @lastLoginAt, @lastLoginAt, @cfHandle, @lastLoginAt
    )
  `,
  ).run({ id, email: `${id}@example.com`, cfHandle, lastLoginAt });
};

const insertSyncRun = (
  db: DatabaseSync,
  userId: string,
  status: "success" | "failed",
  finishedAt: string,
): void => {
  db.prepare(
    `
    INSERT INTO sync_runs (
      started_at, finished_at, status, source, user_id, cf_handle, message
    ) VALUES (
      @finishedAt, @finishedAt, @status, 'codeforces:user', @userId, @userId, NULL
    )
  `,
  ).run({ userId, status, finishedAt });
};

test("daily sync query selects active users without a success in the last day", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    const activeSince = new Date(NOW_MS - ACTIVE_USER_WINDOW_MS).toISOString();
    const syncBefore = new Date(NOW_MS - AUTOMATIC_USER_SYNC_INTERVAL_MS).toISOString();

    insertUser(db, "never-synced", new Date(NOW_MS).toISOString());
    insertUser(db, "old-success", new Date(NOW_MS - 2 * 24 * 60 * 60 * 1000).toISOString());
    insertSyncRun(db, "old-success", "success", new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString());

    insertUser(db, "fresh-success", new Date(NOW_MS).toISOString());
    insertSyncRun(db, "fresh-success", "success", new Date(NOW_MS - 23 * 60 * 60 * 1000).toISOString());

    insertUser(db, "failed-recently", new Date(NOW_MS).toISOString());
    insertSyncRun(db, "failed-recently", "failed", new Date(NOW_MS - 60 * 60 * 1000).toISOString());

    insertUser(db, "boundary", activeSince);
    insertSyncRun(db, "boundary", "success", syncBefore);
    insertUser(db, "inactive", new Date(NOW_MS - ACTIVE_USER_WINDOW_MS - 1).toISOString());
    insertUser(db, "missing-handle", new Date(NOW_MS).toISOString(), " ");

    const dueIds = listUsersDueForAutomaticSync(db, activeSince, syncBefore)
      .map((user) => user.id)
      .sort();
    assert.deepEqual(dueIds, ["boundary", "failed-recently", "never-synced", "old-success"]);
  } finally {
    db.close();
  }
});

test("daily active-user sync is sequential, skips running users, and isolates failures", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    const activeAt = new Date(NOW_MS).toISOString();
    for (const id of ["a", "b", "c", "running"]) insertUser(db, id, activeAt);
    syncState.userRunning.add("running");

    const calls: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    await syncActiveUsers(db, NOW_MS, async (_db, user) => {
      calls.push(user.id);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      if (user.id === "b") throw new Error("expected test failure");
    });

    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.equal(maxConcurrent, 1);
  } finally {
    syncState.userRunning.delete("running");
    db.close();
  }
});
