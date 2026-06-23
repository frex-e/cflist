import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { setVerifyHandleForTests } from "../src/cf/verify-handle.js";
import { migrate } from "../src/db/migrate.js";

const seedProblem = (db: DatabaseSync): void => {
  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      derived_family,
      derived_division,
      derived_label,
      raw_json,
      updated_at
    ) VALUES (1, 'Codeforces Round 1 (Div. 2)', 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      derived_family,
      derived_division,
      derived_label,
      raw_json,
      updated_at
    ) VALUES (2, 'Codeforces Round 2 (Div. 3)', 'Codeforces Round', 'Div. 3', 'Codeforces Round (Div. 3)', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (1, 'A', 'Test Problem', 800, 10, '[]', 'https://codeforces.com/problemset/problem/1/A', '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
  `,
  ).run({ canonicalId: randomUUID() });
};

const withSeededApp = async (
  fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>,
): Promise<void> => {
  setVerifyHandleForTests(async () => true);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedProblem(db);

  try {
    const app = createApp(db, {
      publicRoot: "src/public",
      authBaseURL: "http://localhost",
      authSecret: "test-secret-with-enough-length-32",
      authTrustedOrigins: ["http://localhost"],
      skipInitialSync: true,
    });
    await fn(app, db);
  } finally {
    setVerifyHandleForTests(undefined);
    db.close();
  }
};

const signUp = async (
  app: ReturnType<typeof createApp>,
  db: DatabaseSync,
  email = "user@example.com",
): Promise<string> => {
  const response = await app.request("/sign-up", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Test User",
      email,
      password: "password123",
      cfHandle: "tourist",
    }).toString(),
  });

  assert.equal(response.status, 303);

  const user = db.prepare(`SELECT id FROM "user" WHERE email = @email`).get({ email }) as { id: string };
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'success', 'codeforces:user', @userId, 'tourist', 'test')
  `,
  ).run({ userId: user.id });

  return response.headers.get("set-cookie") ?? "";
};

test("manual solved HTMX response swaps the list instead of a bare table row", async () => {
  await withSeededApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const response = await app.request("/problems/1/A/override", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
        "hx-current-url": "http://localhost/problems?solved=unsolved",
        cookie,
      },
      body: new URLSearchParams({
        solvedOverride: "1",
      }).toString(),
    });

    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html.trim(), /^<section id="problem-list"/);
    assert.match(html, /id="problem-summary"[^>]*hx-swap-oob="true"/);
    assert.doesNotMatch(html, /^<p[\s>]/);
  });
});

test("problem links point to the contest problem page", async () => {
  await withSeededApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const response = await app.request("/problems", {
      headers: { cookie },
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /href="https:\/\/codeforces\.com\/contest\/1\/problem\/A"/);
    assert.doesNotMatch(html, /href="https:\/\/codeforces\.com\/problemset\/problem\/1\/A"/);
  });
});

test("bare problems page uses saved default filters when no query params are present", async () => {
  await withSeededApp(async (app, db) => {
    const authCookie = await signUp(app, db);
    const saveResponse = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams({ solved: "unsolved" }).toString(),
    });

    const defaultResponse = await app.request("/problems", {
      headers: { cookie: authCookie },
    });
    const explicitResponse = await app.request("/problems?solved=all", {
      headers: { cookie: authCookie },
    });

    const defaultHtml = await defaultResponse.text();
    const explicitHtml = await explicitResponse.text();

    assert.equal(defaultResponse.status, 200);
    assert.match(defaultHtml, /<option value="unsolved" selected="">Unsolved<\/option>/);
    assert.match(explicitHtml, /<option value="all" selected="">All<\/option>/);
  });
});

test("default filter save works from the problems page", async () => {
  await withSeededApp(async (app, db) => {
    const authCookie = await signUp(app, db);
    const formPage = await app.request("/problems?solved=unsolved", {
      headers: { cookie: authCookie },
    });
    const formHtml = await formPage.text();

    assert.equal(formPage.status, 200);
    assert.match(formHtml, /data-filter-save-default/);
    assert.doesNotMatch(formHtml, /formmethod="post"/);

    const saveResponse = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams({ solved: "unsolved" }).toString(),
    });

    assert.equal(saveResponse.status, 200);
    assert.equal(await saveResponse.text(), "Default saved");

    const defaultResponse = await app.request("/problems", {
      headers: { cookie: authCookie },
    });
    const defaultHtml = await defaultResponse.text();

    assert.equal(defaultResponse.status, 200);
    assert.match(defaultHtml, /<option value="unsolved" selected="">Unsolved<\/option>/);
  });
});

test("default filter save overwrites an existing default", async () => {
  await withSeededApp(async (app, db) => {
    const authCookie = await signUp(app, db);

    const firstSave = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams({ solved: "unsolved" }).toString(),
    });
    assert.equal(firstSave.status, 200);

    const overwrite = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams({ solved: "solved" }).toString(),
    });
    assert.equal(overwrite.status, 200);

    const defaultResponse = await app.request("/problems", {
      headers: { cookie: authCookie },
    });
    const defaultHtml = await defaultResponse.text();

    assert.equal(defaultResponse.status, 200);
    assert.match(defaultHtml, /<option value="solved" selected="">Solved<\/option>/);
    assert.doesNotMatch(defaultHtml, /<option value="unsolved" selected="">Unsolved<\/option>/);
  });
});

test("default filter save preserves multiple selected divisions", async () => {
  await withSeededApp(async (app, db) => {
    const authCookie = await signUp(app, db);
    const saveResponse = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams([
        ["division", "Div. 2"],
        ["division", "Div. 3"],
      ]).toString(),
    });
    assert.equal(saveResponse.status, 200);

    const defaultResponse = await app.request("/problems", {
      headers: { cookie: authCookie },
    });
    const defaultHtml = await defaultResponse.text();

    assert.equal(defaultResponse.status, 200);
    assert.match(defaultHtml, /name="division" value="Div\. 2" checked=""/);
    assert.match(defaultHtml, /name="division" value="Div\. 3" checked=""/);
  });
});

test("reset bypasses saved defaults so they can be cleared", async () => {
  await withSeededApp(async (app, db) => {
    const authCookie = await signUp(app, db);
    const saveResponse = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams({ solved: "unsolved" }).toString(),
    });
    assert.equal(saveResponse.status, 200);

    const resetResponse = await app.request("/problems?default=0", {
      headers: { cookie: authCookie },
    });
    const resetHtml = await resetResponse.text();

    assert.equal(resetResponse.status, 200);
    assert.match(resetHtml, /href="\/problems\?default=0"/);
    assert.match(resetHtml, /<option value="all" selected="">All<\/option>/);

    const clearResponse = await app.request("/preferences/default-filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: authCookie,
      },
      body: new URLSearchParams().toString(),
    });
    assert.equal(clearResponse.status, 200);

    const defaultResponse = await app.request("/problems", {
      headers: { cookie: authCookie },
    });
    const defaultHtml = await defaultResponse.text();

    assert.equal(defaultResponse.status, 200);
    assert.match(defaultHtml, /<option value="all" selected="">All<\/option>/);
  });
});

test("manual overrides are scoped to the authenticated user", async () => {
  await withSeededApp(async (app, db) => {
    const firstCookie = await signUp(app, db, "first@example.com");
    const secondCookie = await signUp(app, db, "second@example.com");

    const overrideResponse = await app.request("/problems/1/A/override", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-current-url": "http://localhost/problems",
        cookie: firstCookie,
      },
      body: new URLSearchParams({ solvedOverride: "1" }).toString(),
    });
    assert.equal(overrideResponse.status, 200);

    const firstPage = await app.request("/problems?solved=solved", {
      headers: { cookie: firstCookie },
    });
    const secondPage = await app.request("/problems?solved=solved", {
      headers: { cookie: secondCookie },
    });

    assert.match(await firstPage.text(), /Test Problem/);
    assert.doesNotMatch(await secondPage.text(), /Test Problem/);
  });
});
