import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getContestSyncJobCounts,
  getContestSyncJobsByContest,
  hasPendingContestSyncJobs,
  isStuckUserSyncRun,
} from "../src/db/queries/sync-jobs.js";
import { buildSyncPanelOptions } from "../src/http/sync-panel.js";
import { syncPanelHtml } from "../src/views/sync-panel.js";
import { createTestDb, signUp, withTestApp } from "./helpers.js";

test("getContestSyncJobCounts groups contest job statuses", () => {
  const db = createTestDb();
  try {
    db.prepare(
      `
      INSERT INTO "user" (
        id, name, email, emailVerified, createdAt, updatedAt, cfHandle
      ) VALUES (
        'user-1', 'Test User', 'user@example.com', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tourist'
      )
    `,
    ).run();

    for (const contestId of [1, 2, 3, 4, 5]) {
      db.prepare(
        `
        INSERT INTO contests (id, name, raw_json, updated_at)
        VALUES (@contestId, @name, '{}', '2026-01-01T00:00:00.000Z')
      `,
      ).run({ contestId, name: `Contest ${contestId}` });
    }

    db.prepare(
      `
      INSERT INTO contest_sync_jobs (
        user_id, cf_handle, contest_id, status, priority, attempts, available_at, created_at, updated_at
      ) VALUES
        ('user-1', 'tourist', 1, 'queued', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('user-1', 'tourist', 2, 'running', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('user-1', 'tourist', 3, 'done', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('user-1', 'tourist', 4, 'failed', 3, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('user-1', 'tourist', 5, 'failed', 4, 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `,
    ).run();

    const counts = getContestSyncJobCounts(db, "user-1");
    assert.deepEqual(counts, {
      total: 5,
      queued: 1,
      running: 1,
      done: 1,
      failedRetryable: 1,
      failedPermanent: 1,
    });
    assert.equal(hasPendingContestSyncJobs(counts), true);

    const byContest = getContestSyncJobsByContest(db, "user-1");
    assert.equal(byContest.get(5)?.attempts, 3);
    assert.equal(byContest.get(5)?.last_error, null);
  } finally {
    db.close();
  }
});

test("isStuckUserSyncRun detects stale running rows", () => {
  const oldStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  assert.equal(
    isStuckUserSyncRun({ started_at: oldStartedAt, finished_at: null, status: "running" }, false),
    true,
  );
  assert.equal(
    isStuckUserSyncRun({ started_at: oldStartedAt, finished_at: null, status: "running" }, true),
    false,
  );
  assert.equal(
    isStuckUserSyncRun({ started_at: new Date().toISOString(), finished_at: null, status: "running" }, false),
    false,
  );
});

test("sync panel endpoint renders polling attributes while sync is running", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

    db.prepare(
      `
      INSERT INTO sync_runs (started_at, status, source, user_id, cf_handle, message)
      VALUES ('2026-01-01T00:00:00.000Z', 'running', 'codeforces:user', @userId, 'tourist', NULL)
    `,
    ).run({ userId: user.id });

    const { syncState } = await import("../src/cf/sync/state.js");
    syncState.userRunning.add(user.id);

    try {
      const response = await app.request("/admin/sync/panel?returnTo=%2Fproblems&refreshPage=problems", {
        headers: { cookie, "hx-request": "true" },
      });
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /data-sync-panel/);
      assert.match(html, /hx-get="\/admin\/sync\/panel/);
      assert.match(html, /Syncing from Codeforces/);
      assert.match(html, /disabled/);
    } finally {
      syncState.userRunning.delete(user.id);
    }
  });
});

test("sync POST redirects for non-HTMX requests", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);

    const response = await app.request("/admin/sync", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        returnTo: "/problems",
        refreshPage: "problems",
      }).toString(),
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/problems");
    const html = await response.text();
    assert.doesNotMatch(html, /data-sync-panel/);
  });
});

test("sync panel GET redirects for non-HTMX requests", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);

    const response = await app.request("/admin/sync/panel?returnTo=%2Fproblems&refreshPage=problems", {
      headers: { cookie },
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/problems");
  });
});

test("sync POST returns panel HTML for HTMX requests", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);

    const response = await app.request("/admin/sync", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      body: new URLSearchParams({
        returnTo: "/problems",
        refreshPage: "problems",
      }).toString(),
    });

    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-sync-panel/);
    assert.doesNotMatch(html, /HX-Redirect/i);
  });
});

test("problems page shows one sync panel before first successful user sync", async () => {
  await withTestApp(async (app, db) => {
    const response = await app.request("/sign-up", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        name: "Test User",
        email: "new@example.com",
        password: "password123",
        cfHandle: "tourist",
      }).toString(),
    });

    assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie") ?? "";

    const page = await app.request("/problems", { headers: { cookie } });
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(html, /Not synced yet/);
    assert.equal((html.match(/class="sync-panel"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /sync-prompt-banner/);
  });
});

test("sync panel markup exposes autoSyncStarted flag", () => {
  const db = createTestDb();
  try {
    db.prepare(
      `
      INSERT INTO "user" (
        id, name, email, emailVerified, createdAt, updatedAt, cfHandle
      ) VALUES (
        'user-1', 'Test User', 'user@example.com', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tourist'
      )
    `,
    ).run();

    const html = syncPanelHtml(
      buildSyncPanelOptions(
        db,
        { id: "user-1", name: "Test User", email: "user@example.com", cfHandle: "tourist" },
        "/problems",
        "problems",
        undefined,
        true,
      ),
    );

    assert.match(html, /data-auto-sync-started="true"/);
  } finally {
    db.close();
  }
});
