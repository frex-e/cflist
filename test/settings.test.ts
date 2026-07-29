import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { setVerifyHandleForTests } from "../src/cf/verify-handle.js";
import { migrate } from "../src/db/migrate.js";
import { seedContest, seedProblem } from "./helpers.js";

const withApp = async (
  fn: (app: ReturnType<typeof createApp>, db: DatabaseSync, cookie: string, userId: string) => Promise<void>,
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
      skipInitialSync: true,
    });

    const signUpResponse = await app.request("/sign-up", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Test User",
        email: "user@example.com",
        password: "password123",
        cfHandle: "tourist",
      }).toString(),
    });
    assert.equal(signUpResponse.status, 303);
    const cookie = signUpResponse.headers.get("set-cookie");
    assert.ok(cookie);

    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    await fn(app, db, cookie, user.id);
  } finally {
    setVerifyHandleForTests(undefined);
    db.close();
  }
};

const seedUserCfData = (db: DatabaseSync, userId: string): void => {
  seedContest(db, { id: 1, name: "Test Round" });
  seedProblem(db, { contestId: 1, index: "A", name: "Problem A", canonicalId: "1A" });

  db.prepare(
    `
    INSERT INTO user_problem_status (user_id, contest_id, problem_index, solved, accepted_count, last_checked_at)
    VALUES (@userId, 1, 'A', 1, 1, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO user_problem_overrides (user_id, canonical_id, solved_override, updated_at)
    VALUES (@userId, '1A', 1, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, old_rating, new_rating, rating_delta,
      last_checked_at, standings_checked_at
    )
    VALUES (
      @userId, 1, 42, 2300, 2400, 100,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'success', 'codeforces:user', @userId, 'tourist', 'test')
  `,
  ).run({ userId });
};

test("GET /settings requires sign-in", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const app = createApp(db, {
    publicRoot: "src/public",
    authBaseURL: "http://localhost",
    authSecret: "test-secret-with-enough-length-32",
    authTrustedOrigins: ["http://localhost"],
    skipInitialSync: true,
  });

  const response = await app.request("/settings");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/sign-in?returnTo=%2Fsettings");
  db.close();
});

test("GET /settings shows account and data controls", async () => {
  await withApp(async (app, _db, cookie) => {
    const response = await app.request("/settings", { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Settings/);
    assert.match(html, /user@example\.com/);
    assert.match(html, /Refresh contest details/);
    assert.match(html, /Reset Codeforces data/);
    assert.match(html, /Delete account/);
  });
});

test("POST /settings/reset-cf-data clears synced rows and keeps the account", async () => {
  await withApp(async (app, db, cookie, userId) => {
    seedUserCfData(db, userId);
    db.prepare(
      `
      INSERT INTO user_default_filters (user_id, query, updated_at)
      VALUES (@userId, 'solved=unsolved', '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId });

    const response = await app.request("/settings/reset-cf-data", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmHandle: "tourist" }).toString(),
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /success=/);

    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM user_problem_status WHERE user_id = @userId`).get({ userId }) as {
        count: number;
      }).count,
      0,
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM user_contest_results WHERE user_id = @userId`).get({ userId }) as {
        count: number;
      }).count,
      0,
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM sync_runs WHERE user_id = @userId AND message = 'test'`).get({ userId }) as {
        count: number;
      }).count,
      0,
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM user_default_filters WHERE user_id = @userId`).get({ userId }) as {
        count: number;
      }).count,
      1,
    );
    assert.ok(db.prepare(`SELECT id FROM "user" WHERE id = @userId`).get({ userId }));
  });
});

test("POST /settings/refresh-contest-details clears freshness and queues hydration", async () => {
  await withApp(async (app, db, cookie, userId) => {
    seedUserCfData(db, userId);
    db.prepare(
      `
      INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
      VALUES (1, '[]', '2026-01-01T00:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO contest_performance_cache (contest_id, user_id, performance, calculated_at)
      VALUES (1, @userId, 2400, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId });

    const response = await app.request("/settings/refresh-contest-details", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmHandle: "tourist" }).toString(),
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /success=/);

    const ratingCache = db.prepare("SELECT COUNT(*) AS count FROM contest_rating_changes_cache").get() as { count: number };
    assert.equal(ratingCache.count, 0);
    const performance = db.prepare(
      "SELECT performance, standings_checked_at FROM user_contest_results WHERE user_id = @userId AND contest_id = 1",
    ).get({ userId }) as { performance: number | null; standings_checked_at: string | null };
    assert.equal(performance.performance, null);
    assert.equal(performance.standings_checked_at, null);
    const job = db.prepare(
      "SELECT status FROM contest_sync_jobs WHERE user_id = @userId AND contest_id = 1",
    ).get({ userId }) as { status: string };
    assert.ok(["queued", "running", "done"].includes(job.status));
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM user_problem_status WHERE user_id = @userId`).get({ userId }) as {
        count: number;
      }).count,
      1,
    );
  });
});

test("POST /settings/reset-cf-data rejects wrong confirmation", async () => {
  await withApp(async (app, db, cookie, userId) => {
    seedUserCfData(db, userId);

    const response = await app.request("/settings/reset-cf-data", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmHandle: "wrong" }).toString(),
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /error=/);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM user_problem_status WHERE user_id = @userId`).get({ userId }) as {
        count: number;
      }).count,
      1,
    );
  });
});

test("POST /settings/delete-account removes the user and signs out", async () => {
  await withApp(async (app, db, cookie, userId) => {
    seedUserCfData(db, userId);

    const response = await app.request("/settings/delete-account", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmHandle: "tourist" }).toString(),
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/sign-in");
    assert.match(response.headers.get("set-cookie") ?? "", /better-auth\.session_token=; Max-Age=0/);

    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM "user"`).get() as { count: number }).count, 0);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM user_problem_status WHERE user_id = @userId`).get({ userId }) as {
        count: number;
      }).count,
      0,
    );

    const staleSessionResponse = await app.request("/settings", { headers: { cookie } });
    assert.equal(staleSessionResponse.status, 302);
    assert.match(staleSessionResponse.headers.get("location") ?? "", /^\/sign-in\?returnTo=/);
  });
});

test("POST /settings/delete-account rejects wrong confirmation", async () => {
  await withApp(async (app, db, cookie, userId) => {
    const response = await app.request("/settings/delete-account", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmHandle: "wrong" }).toString(),
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /error=/);
    assert.ok(db.prepare(`SELECT id FROM "user" WHERE id = @userId`).get({ userId }));
  });
});
