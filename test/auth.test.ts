import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";

const withApp = async (fn: (app: ReturnType<typeof createApp>) => Promise<void>): Promise<void> => {
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
    await fn(app);
  } finally {
    db.close();
  }
};

const signUp = async (app: ReturnType<typeof createApp>): Promise<string> => {
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
  return cookie;
};

test("sign out clears the session cookie and invalidates the session", async () => {
  await withApp(async (app) => {
    const cookie = await signUp(app);

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
