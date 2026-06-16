import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
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
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at
    ) VALUES (1, 'A', 'Test Problem', 800, 10, '[]', 'https://codeforces.com/problemset/problem/1/A', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
};

const withSeededApp = async (fn: (app: ReturnType<typeof createApp>) => Promise<void>): Promise<void> => {
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
    });
    await fn(app);
  } finally {
    db.close();
  }
};

const signUp = async (app: ReturnType<typeof createApp>, email = "user@example.com"): Promise<string> => {
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
  return response.headers.get("set-cookie") ?? "";
};

test("manual solved HTMX response swaps the list instead of a bare table row", async () => {
  await withSeededApp(async (app) => {
    const cookie = await signUp(app);
    const response = await app.request("/problems/1/A/override", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
        cookie,
      },
      body: new URLSearchParams({
        solvedOverride: "1",
        returnTo: "/problems?solved=unsolved",
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
  await withSeededApp(async (app) => {
    const cookie = await signUp(app);
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
  await withSeededApp(async (app) => {
    const authCookie = await signUp(app);
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

test("manual overrides are scoped to the authenticated user", async () => {
  await withSeededApp(async (app) => {
    const firstCookie = await signUp(app, "first@example.com");
    const secondCookie = await signUp(app, "second@example.com");

    const overrideResponse = await app.request("/problems/1/A/override", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: firstCookie,
      },
      body: new URLSearchParams({ solvedOverride: "1", returnTo: "/problems" }).toString(),
    });
    assert.equal(overrideResponse.status, 302);

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
