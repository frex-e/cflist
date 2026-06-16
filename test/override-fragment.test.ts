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

test("manual solved HTMX response swaps the list instead of a bare table row", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedProblem(db);

  try {
    const app = createApp(db, {
      handle: "tourist",
      adminToken: "",
      publicRoot: "src/public",
    });

    const response = await app.request("/problems/1/A/override", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
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
  } finally {
    db.close();
  }
});
