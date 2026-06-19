import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";

const withApp = async (fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>): Promise<void> => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    const app = createApp(db, {
      publicRoot: "src/public",
      authBaseURL: "http://localhost",
      authSecret: "test-secret-with-enough-length-32",
      authTrustedOrigins: ["http://localhost"],
    });
    await fn(app, db);
  } finally {
    db.close();
  }
};

const signUp = async (app: ReturnType<typeof createApp>, db: DatabaseSync): Promise<string> => {
  const response = await app.request("/sign-up", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
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
  assert.match(cookie, /better-auth\.session_token=/);

  const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'success', 'codeforces:user', @userId, 'tourist', 'test')
  `,
  ).run({ userId: user.id });

  return cookie;
};

test("sign out clears the session cookie and invalidates the session", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);

    const signedInResponse = await app.request("/problems", { headers: { cookie } });
    assert.equal(signedInResponse.status, 200);

    const signOutResponse = await app.request("/sign-out", {
      method: "POST",
      headers: { cookie },
    });

    assert.equal(signOutResponse.status, 303);
    assert.equal(signOutResponse.headers.get("location"), "/sign-in");
    assert.match(signOutResponse.headers.get("set-cookie") ?? "", /better-auth\.session_token=; Max-Age=0/);

    const staleSessionResponse = await app.request("/problems", { headers: { cookie } });
    assert.equal(staleSessionResponse.status, 302);
    assert.match(staleSessionResponse.headers.get("location") ?? "", /^\/sign-in\?returnTo=/);
  });
});
