import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { setVerifyHandleForTests } from "../src/cf/verify-handle.js";
import { isAdminEmail, resolveAdminEmails } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import {
  clearContestEstimates,
  clearProblemEstimate,
  dropContestRatingChangesCache,
  forceRehydrateContestForAllUsers,
  parseCatalogLookup,
} from "../src/db/writes/catalog-repair.js";
import { seedContest, seedProblem } from "./helpers.js";

const withAdminApp = async (
  adminEmail: string | undefined,
  fn: (
    app: ReturnType<typeof createApp>,
    db: DatabaseSync,
    cookie: string,
    userId: string,
  ) => Promise<void>,
  signUpEmail = "user@example.com",
): Promise<void> => {
  setVerifyHandleForTests(async () => true);
  const previous = process.env.ADMIN_EMAILS;
  if (adminEmail === undefined) {
    delete process.env.ADMIN_EMAILS;
  } else {
    process.env.ADMIN_EMAILS = adminEmail;
  }

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
        email: signUpEmail,
        password: "password123",
        cfHandle: "tourist",
      }).toString(),
    });
    assert.equal(signUpResponse.status, 303);
    const cookie = signUpResponse.headers.get("set-cookie");
    assert.ok(cookie);

    const user = db
      .prepare(`SELECT id FROM "user" WHERE email = @email`)
      .get({ email: signUpEmail }) as { id: string };
    await fn(app, db, cookie, user.id);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
    setVerifyHandleForTests(undefined);
    db.close();
  }
};

test("resolveAdminEmails parses allowlist", () => {
  assert.deepEqual(resolveAdminEmails({}), []);
  assert.deepEqual(resolveAdminEmails({ ADMIN_EMAILS: "" }), []);
  assert.deepEqual(resolveAdminEmails({ ADMIN_EMAILS: "A@B.com, c@d.com " }), [
    "a@b.com",
    "c@d.com",
  ]);
  assert.equal(isAdminEmail("a@b.com", { ADMIN_EMAILS: "A@B.com" }), true);
  assert.equal(isAdminEmail("other@example.com", { ADMIN_EMAILS: "A@B.com" }), false);
  assert.equal(isAdminEmail("a@b.com", {}), false);
});

test("parseCatalogLookup accepts contest ids and problem keys", () => {
  assert.deepEqual(parseCatalogLookup("1900"), { kind: "contest", contestId: 1900 });
  assert.deepEqual(parseCatalogLookup("1900A"), {
    kind: "problem",
    contestId: 1900,
    problemIndex: "A",
  });
  assert.deepEqual(parseCatalogLookup("1900B1"), {
    kind: "problem",
    contestId: 1900,
    problemIndex: "B1",
  });
  assert.equal(parseCatalogLookup(""), undefined);
  assert.equal(parseCatalogLookup("A1900"), undefined);
});

test("GET /admin/catalog redirects unsigned users to sign-in", async () => {
  await withAdminApp("admin@example.com", async (app) => {
    const response = await app.request("/admin/catalog");
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/sign-in/);
  });
});

test("GET /admin/catalog returns 404 for non-admin signed-in users", async () => {
  await withAdminApp("admin@example.com", async (app, _db, cookie) => {
    const response = await app.request("/admin/catalog", {
      headers: { cookie },
    });
    assert.equal(response.status, 404);
  }, "user@example.com");
});

test("GET /admin/catalog returns 404 when ADMIN_EMAILS is unset", async () => {
  await withAdminApp(undefined, async (app, _db, cookie) => {
    const response = await app.request("/admin/catalog", {
      headers: { cookie },
    });
    assert.equal(response.status, 404);
  });
});

test("GET /admin/catalog shows contest summary for admins", async () => {
  await withAdminApp("admin@example.com", async (app, db, cookie) => {
    seedContest(db, { id: 1900, name: "Round 1900" });
    seedProblem(db, { contestId: 1900, index: "A", rating: 800 });
    db.prepare(
      `
      UPDATE problems
      SET rating = NULL, estimated_rating = 1500, estimated_rating_at = '2026-01-01T00:00:00.000Z'
      WHERE contest_id = 1900 AND problem_index = 'A'
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
      VALUES (1900, '[]', '2026-01-01T00:00:00.000Z')
    `,
    ).run();

    const response = await app.request("/admin/catalog?q=1900", {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Catalog repair/);
    assert.match(html, /Round 1900/);
    assert.match(html, /Present/);
    assert.match(html, /Clear contest estimates/);
    assert.match(html, /Force rehydrate/);
  }, "admin@example.com");
});

test("POST clear-estimates rejects wrong confirmation", async () => {
  await withAdminApp("admin@example.com", async (app, db, cookie) => {
    seedContest(db, { id: 10, name: "Round 10" });
    seedProblem(db, { contestId: 10, index: "A" });
    db.prepare(
      `
      UPDATE problems
      SET rating = NULL, estimated_rating = 1600, estimated_rating_at = '2026-01-01T00:00:00.000Z'
      WHERE contest_id = 10 AND problem_index = 'A'
    `,
    ).run();

    const response = await app.request("/admin/catalog/clear-estimates", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        contestId: "10",
        confirm: "wrong",
      }).toString(),
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /Confirmation/);

    const row = db
      .prepare(
        `SELECT estimated_rating FROM problems WHERE contest_id = 10 AND problem_index = 'A'`,
      )
      .get() as { estimated_rating: number | null };
    assert.equal(row.estimated_rating, 1600);
  }, "admin@example.com");
});

test("clearContestEstimates preserves canonical_id and user rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  seedContest(db, { id: 20, name: "Round 20" });
  const canonicalId = randomUUID();
  seedProblem(db, { contestId: 20, index: "A", canonicalId });
  db.prepare(
    `
    UPDATE problems
    SET rating = NULL, estimated_rating = 1700, estimated_rating_at = '2026-01-01T00:00:00.000Z'
    WHERE contest_id = 20 AND problem_index = 'A'
  `,
  ).run();

  const userId = "user-1";
  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@id, 'U', 'u@example.com', 0, '2026-01-01', '2026-01-01', 'handle')
  `,
  ).run({ id: userId });
  db.prepare(
    `
    INSERT INTO user_problem_status (user_id, contest_id, problem_index, solved, accepted_count, last_checked_at)
    VALUES (@userId, 20, 'A', 1, 1, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });
  db.prepare(
    `
    INSERT INTO user_problem_overrides (user_id, canonical_id, solved_override, updated_at)
    VALUES (@userId, @canonicalId, 1, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId, canonicalId });

  assert.equal(clearContestEstimates(db, 20), 1);

  const problem = db
    .prepare(
      `
      SELECT canonical_id, estimated_rating, estimated_rating_at
      FROM problems
      WHERE contest_id = 20 AND problem_index = 'A'
    `,
    )
    .get() as {
      canonical_id: string;
      estimated_rating: number | null;
      estimated_rating_at: string | null;
    };
  assert.equal(problem.canonical_id, canonicalId);
  assert.equal(problem.estimated_rating, null);
  assert.equal(problem.estimated_rating_at, null);

  const statusCount = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM user_problem_status WHERE user_id = @userId`)
      .get({ userId }) as { count: number }
  ).count;
  const overrideCount = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM user_problem_overrides WHERE user_id = @userId`)
      .get({ userId }) as { count: number }
  ).count;
  assert.equal(statusCount, 1);
  assert.equal(overrideCount, 1);
  db.close();
});

test("clearProblemEstimate only clears one problem", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedContest(db, { id: 21, name: "Round 21" });
  seedProblem(db, { contestId: 21, index: "A" });
  seedProblem(db, { contestId: 21, index: "B" });
  db.prepare(
    `
    UPDATE problems
    SET rating = NULL, estimated_rating = 1800, estimated_rating_at = '2026-01-01T00:00:00.000Z'
  `,
  ).run();

  assert.equal(clearProblemEstimate(db, 21, "A"), 1);
  const rows = db
    .prepare(
      `
      SELECT problem_index, estimated_rating
      FROM problems
      WHERE contest_id = 21
      ORDER BY problem_index
    `,
    )
    .all() as Array<{ problem_index: string; estimated_rating: number | null }>;
  assert.equal(rows[0]!.estimated_rating, null);
  assert.equal(rows[1]!.estimated_rating, 1800);
  db.close();
});

test("forceRehydrateContestForAllUsers nulls all users and requeues", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedContest(db, { id: 30, name: "Round 30" });
  seedProblem(db, { contestId: 30, index: "A" });

  const insertUser = (id: string, email: string, handle: string) => {
    db.prepare(
      `
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
      VALUES (@id, @name, @email, 0, '2026-01-01', '2026-01-01', @handle)
    `,
    ).run({ id, name: handle, email, handle });
    db.prepare(
      `
      INSERT INTO user_contest_results (
        user_id, contest_id, rank, performance, last_checked_at, standings_checked_at
      ) VALUES (
        @id, 30, 1, 2000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `,
    ).run({ id });
    db.prepare(
      `
      INSERT INTO contest_performance_cache (contest_id, user_id, performance, calculated_at)
      VALUES (30, @id, 2000, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ id });
  };

  insertUser("u1", "a@example.com", "alice");
  insertUser("u2", "b@example.com", "bob");
  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (30, '[]', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO user_problem_status (user_id, contest_id, problem_index, solved, accepted_count, last_checked_at)
    VALUES ('u1', 30, 'A', 1, 1, '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  assert.equal(forceRehydrateContestForAllUsers(db, 30), 2);

  const cache = db
    .prepare(`SELECT COUNT(*) AS count FROM contest_rating_changes_cache WHERE contest_id = 30`)
    .get() as { count: number };
  assert.equal(cache.count, 0);

  const perfCache = db
    .prepare(`SELECT COUNT(*) AS count FROM contest_performance_cache WHERE contest_id = 30`)
    .get() as { count: number };
  assert.equal(perfCache.count, 0);

  const results = db
    .prepare(
      `
      SELECT user_id, performance, standings_checked_at
      FROM user_contest_results
      WHERE contest_id = 30
      ORDER BY user_id
    `,
    )
    .all() as Array<{
      user_id: string;
      performance: number | null;
      standings_checked_at: string | null;
    }>;
  assert.equal(results.length, 2);
  for (const row of results) {
    assert.equal(row.performance, null);
    assert.equal(row.standings_checked_at, null);
  }

  const jobs = db
    .prepare(
      `
      SELECT user_id, status, contest_id
      FROM contest_sync_jobs
      WHERE contest_id = 30
      ORDER BY user_id
    `,
    )
    .all() as Array<{ user_id: string; status: string; contest_id: number }>;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.status, "queued");
  assert.equal(jobs[1]!.status, "queued");

  const solved = db
    .prepare(`SELECT COUNT(*) AS count FROM user_problem_status WHERE contest_id = 30`)
    .get() as { count: number };
  assert.equal(solved.count, 1);

  assert.equal(dropContestRatingChangesCache(db, 30), 0);
  db.close();
});

test("POST force-rehydrate works for admin and preserves solved rows", async () => {
  await withAdminApp("admin@example.com", async (app, db, cookie, userId) => {
    seedContest(db, { id: 40, name: "Round 40" });
    seedProblem(db, { contestId: 40, index: "A" });
    db.prepare(
      `
      INSERT INTO user_contest_results (
        user_id, contest_id, rank, performance, last_checked_at, standings_checked_at
      ) VALUES (
        @userId, 40, 5, 2100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `,
    ).run({ userId });
    db.prepare(
      `
      INSERT INTO user_problem_status (user_id, contest_id, problem_index, solved, accepted_count, last_checked_at)
      VALUES (@userId, 40, 'A', 1, 1, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId });

    const response = await app.request("/admin/catalog/force-rehydrate", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        contestId: "40",
        confirm: "40",
      }).toString(),
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /Queued rehydration/);

    const result = db
      .prepare(
        `
        SELECT performance, standings_checked_at
        FROM user_contest_results
        WHERE user_id = @userId AND contest_id = 40
      `,
      )
      .get({ userId }) as {
        performance: number | null;
        standings_checked_at: string | null;
      };
    assert.equal(result.performance, null);
    assert.equal(result.standings_checked_at, null);

    const solved = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM user_problem_status WHERE user_id = @userId AND contest_id = 40`,
        )
        .get({ userId }) as { count: number }
    ).count;
    assert.equal(solved, 1);
  }, "admin@example.com");
});

test("settings links to catalog repair for admins only", async () => {
  await withAdminApp("admin@example.com", async (app, _db, cookie) => {
    const response = await app.request("/settings", { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Catalog repair/);
  }, "admin@example.com");

  await withAdminApp("admin@example.com", async (app, _db, cookie) => {
    const response = await app.request("/settings", { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /Catalog repair/);
  }, "user@example.com");
});
