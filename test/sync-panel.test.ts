import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getContestSyncJobCounts,
  getContestSyncJobsByContest,
  getManualUserSyncCooldown,
  hasPendingContestSyncJobs,
  isStuckUserSyncRun,
} from "../src/db/queries.js";
import { buildSyncPanelOptions } from "../src/http/sync-panel.js";
import { formatRetryAfter, syncPanelHtml, syncPanelResponseHeaders } from "../src/views/sync-panel.js";
import { createTestDb, signUp, withTestApp } from "./helpers.js";

const HOUR_MS = 60 * 60 * 1000;

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

    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    const { syncState } = await import("../src/cf/sync/state.js");
    syncState.userRunning.delete(user.id);
  });
});

test("getManualUserSyncCooldown blocks recent successful syncs", () => {
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

    const now = Date.parse("2026-07-30T12:00:00.000Z");
    db.prepare(
      `
      INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
      VALUES (
        '2026-07-30T11:30:00.000Z',
        '2026-07-30T11:30:00.000Z',
        'success',
        'codeforces:user',
        'user-1',
        'tourist',
        'done'
      )
    `,
    ).run();

    const blocked = getManualUserSyncCooldown(db, "user-1", HOUR_MS, now);
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) {
      assert.equal(blocked.retryAfterMs, 30 * 60 * 1000);
      assert.equal(blocked.lastFinishedAt, "2026-07-30T11:30:00.000Z");
    }

    const allowed = getManualUserSyncCooldown(db, "user-1", HOUR_MS, now + 31 * 60 * 1000);
    assert.equal(allowed.allowed, true);
  } finally {
    db.close();
  }
});

test("getManualUserSyncCooldown allows when latest success is old or missing", () => {
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

    const now = Date.parse("2026-07-30T12:00:00.000Z");
    assert.equal(getManualUserSyncCooldown(db, "user-1", HOUR_MS, now).allowed, true);

    db.prepare(
      `
      INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
      VALUES (
        '2026-07-30T11:55:00.000Z',
        '2026-07-30T11:55:00.000Z',
        'failed',
        'codeforces:user',
        'user-1',
        'tourist',
        'boom'
      )
    `,
    ).run();
    assert.equal(getManualUserSyncCooldown(db, "user-1", HOUR_MS, now).allowed, true);

    db.prepare(
      `
      INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
      VALUES (
        '2026-07-30T10:00:00.000Z',
        '2026-07-30T10:00:00.000Z',
        'success',
        'codeforces:user',
        'user-1',
        'tourist',
        'done'
      )
    `,
    ).run();
    assert.equal(getManualUserSyncCooldown(db, "user-1", HOUR_MS, now).allowed, true);
  } finally {
    db.close();
  }
});

test("formatRetryAfter rounds up to whole minutes", () => {
  assert.equal(formatRetryAfter(1), "1m");
  assert.equal(formatRetryAfter(30 * 60 * 1000), "30m");
  assert.equal(formatRetryAfter(60 * 60 * 1000), "1h");
  assert.equal(formatRetryAfter(90 * 60 * 1000), "1h 30m");
});

test("sync POST rate-limits recent successful syncs", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    const recent = new Date().toISOString();

    db.prepare(
      `
      UPDATE sync_runs
      SET started_at = @recent, finished_at = @recent, status = 'success'
      WHERE source = 'codeforces:user' AND user_id = @userId
    `,
    ).run({ recent, userId: user.id });

    const runCountBefore = (
      db.prepare(`SELECT COUNT(*) AS count FROM sync_runs WHERE user_id = @userId`).get({ userId: user.id }) as {
        count: number;
      }
    ).count;

    const { syncState } = await import("../src/cf/sync/state.js");
    syncState.userRunning.delete(user.id);

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
    assert.match(html, /Synced recently — next sync available in/);
    assert.match(html, /data-sync-cooldown="true"/);
    assert.match(html, /disabled/);
    assert.equal(syncState.userRunning.has(user.id), false);

    const runCountAfter = (
      db.prepare(`SELECT COUNT(*) AS count FROM sync_runs WHERE user_id = @userId`).get({ userId: user.id }) as {
        count: number;
      }
    ).count;
    assert.equal(runCountAfter, runCountBefore);
  });
});

test("sync panel shows cooldown copy after recent success", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    const recent = new Date().toISOString();

    db.prepare(
      `
      UPDATE sync_runs
      SET started_at = @recent, finished_at = @recent, status = 'success', message = 'done'
      WHERE source = 'codeforces:user' AND user_id = @userId
    `,
    ).run({ recent, userId: user.id });

    const response = await app.request("/admin/sync/panel?returnTo=%2Fproblems&refreshPage=problems", {
      headers: { cookie, "hx-request": "true" },
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Last synced at .* · next sync in /);
    assert.match(html, /data-sync-cooldown="true"/);
    assert.match(html, /disabled/);
  });
});

test("sync POST allows retry after failed sync", async () => {
  await withTestApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    const recent = new Date().toISOString();

    db.prepare(`DELETE FROM sync_runs WHERE user_id = @userId`).run({ userId: user.id });
    db.prepare(
      `
      INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
      VALUES (@recent, @recent, 'failed', 'codeforces:user', @userId, 'tourist', 'boom')
    `,
    ).run({ recent, userId: user.id });

    const { syncState } = await import("../src/cf/sync/state.js");
    syncState.userRunning.delete(user.id);

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
    assert.match(html, /Syncing from Codeforces/);
    assert.equal(syncState.userRunning.has(user.id), true);
    syncState.userRunning.delete(user.id);
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

test("sync panel markup exposes contest job progress attributes", () => {
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

    for (const contestId of [1, 2, 3]) {
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
        ('user-1', 'tourist', 3, 'done', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `,
    ).run();

    const html = syncPanelHtml(
      buildSyncPanelOptions(
        db,
        { id: "user-1", name: "Test User", email: "user@example.com", cfHandle: "tourist" },
        "/contests",
        "contests",
      ),
    );

    assert.match(html, /data-contest-jobs-done="1"/);
    assert.match(html, /data-contest-jobs-pending="2"/);
  } finally {
    db.close();
  }
});

test("sync panel response headers trigger contests table refresh after successful sync", () => {
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
    db.prepare(
      `
      INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
      VALUES (
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:01.000Z',
        'success',
        'codeforces:user',
        'user-1',
        'tourist',
        'done'
      )
    `,
    ).run();

    const headers = syncPanelResponseHeaders(
      buildSyncPanelOptions(db, { id: "user-1", name: "Test User", email: "user@example.com", cfHandle: "tourist" }, "/contests", "contests"),
    );

    assert.deepEqual(headers, { "HX-Trigger": JSON.stringify({ refreshContestsTable: true }) });
  } finally {
    db.close();
  }
});
