import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp, type AppConfig } from "../src/app.js";
import { setVerifyHandleForTests } from "../src/cf/verify-handle.js";
import { migrate } from "../src/db/migrate.js";

const withApp = async (
  fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>,
  options: {
    skipInitialSync?: boolean;
    startUserSync?: AppConfig["startUserSync"];
    userSyncIntervalMinutes?: number;
  } = {},
): Promise<void> => {
  setVerifyHandleForTests(async () => true);

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    const app = createApp(db, {
      publicRoot: "src/public",
      authBaseURL: "http://localhost",
      authSecret: "test-secret-with-enough-length-32",
      authTrustedOrigins: ["http://localhost"],
      skipInitialSync: options.skipInitialSync ?? false,
      startUserSync: options.startUserSync,
      userSyncIntervalMinutes: options.userSyncIntervalMinutes ?? 60,
    });
    await fn(app, db);
  } finally {
    setVerifyHandleForTests(undefined);
    db.close();
  }
};

const signUp = async (app: ReturnType<typeof createApp>): Promise<string> => {
  const response = await app.request("/sign-up", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Test User",
      email: "user@example.com",
      password: "password123",
      cfHandle: "tourist",
    }).toString(),
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie;
};

const insertUserSyncRun = (
  db: DatabaseSync,
  userId: string,
  finishedAt: string,
  status: "success" | "error" = "success",
): void => {
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
    VALUES (@finishedAt, @finishedAt, @status, 'codeforces:user', @userId, 'tourist', 'test')
  `,
  ).run({ userId, finishedAt, status });
};

test("Problems page starts a sync when the last successful sync is older than the interval", async () => {
  const syncStarts: string[] = [];
  await withApp(
    async (app, db) => {
      const cookie = await signUp(app);
      assert.equal(syncStarts.length, 0);

      const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
      insertUserSyncRun(db, user.id, "2026-01-01T00:00:00.000Z");

      const response = await app.request("/problems", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(syncStarts, [user.id]);
      assert.match(await response.text(), /data-auto-sync-started="true"/);
    },
    {
      startUserSync: (_db, user) => {
        syncStarts.push(user.id);
        return true;
      },
    },
  );
});

test("Problems page does not start a sync within the freshness window", async () => {
  const syncStarts: string[] = [];
  await withApp(
    async (app, db) => {
      const cookie = await signUp(app);
      const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
      insertUserSyncRun(db, user.id, new Date().toISOString());

      const response = await app.request("/problems", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(syncStarts, []);
      assert.match(await response.text(), /data-auto-sync-started="false"/);
    },
    {
      startUserSync: (_db, user) => {
        syncStarts.push(user.id);
        return true;
      },
    },
  );
});

test("Problems page retries after a failed sync even inside the interval", async () => {
  const syncStarts: string[] = [];
  await withApp(
    async (app, db) => {
      const cookie = await signUp(app);
      const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
      insertUserSyncRun(db, user.id, new Date().toISOString(), "error");

      const response = await app.request("/problems", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(syncStarts, [user.id]);
    },
    {
      startUserSync: (_db, user) => {
        syncStarts.push(user.id);
        return true;
      },
    },
  );
});

test("Contests page starts a sync when due, fragments do not", async () => {
  const syncStarts: string[] = [];
  await withApp(
    async (app, db) => {
      const cookie = await signUp(app);
      const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

      const fragment = await app.request("/contests/fragment", { headers: { cookie } });
      assert.equal(fragment.status, 200);
      assert.deepEqual(syncStarts, []);

      const page = await app.request("/contests", { headers: { cookie } });
      assert.equal(page.status, 200);
      assert.deepEqual(syncStarts, [user.id]);
    },
    {
      startUserSync: (_db, user) => {
        syncStarts.push(user.id);
        return true;
      },
    },
  );
});

test("Problems fragment does not start a page sync", async () => {
  const syncStarts: string[] = [];
  await withApp(
    async (app, db) => {
      const cookie = await signUp(app);
      assert.equal(syncStarts.length, 0);

      const response = await app.request("/problems/fragment", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(syncStarts, []);
    },
    {
      startUserSync: (_db, user) => {
        syncStarts.push(user.id);
        return true;
      },
    },
  );
});
