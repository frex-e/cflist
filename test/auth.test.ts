import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp, type AppConfig } from "../src/app.js";
import { setVerifyHandleForTests } from "../src/cf/verify-handle.js";
import { migrate } from "../src/db/migrate.js";

type AppOptions = {
  github?: boolean;
  githubOnly?: boolean;
  authBaseURL?: string;
  skipInitialSync?: boolean;
  startUserSync?: AppConfig["startUserSync"];
};

const withApp = async (
  fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>,
  options: AppOptions = {},
): Promise<void> => {
  setVerifyHandleForTests(async () => true);

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  try {
    const app = createApp(db, {
      publicRoot: "src/public",
      authBaseURL: options.authBaseURL ?? "http://localhost",
      authSecret: "test-secret-with-enough-length-32",
      authTrustedOrigins: ["http://localhost"],
      skipInitialSync: options.skipInitialSync ?? true,
      startUserSync: options.startUserSync,
      ...(options.github
        ? {
            githubClientId: "test-github-client-id",
            githubClientSecret: "test-github-client-secret",
          }
        : {}),
      ...(options.githubOnly ? { authGitHubOnly: true } : {}),
    });
    await fn(app, db);
  } finally {
    setVerifyHandleForTests(undefined);
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

const signUpWithoutCfHandle = async (app: ReturnType<typeof createApp>, db: DatabaseSync): Promise<string> => {
  const cookie = await signUp(app, db);
  const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
  db.prepare(`UPDATE "user" SET cfHandle = '' WHERE id = @userId`).run({ userId: user.id });
  return cookie;
};

test("successful authentication records login activity and starts one sync", async () => {
  const syncStarts: string[] = [];
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    assert.equal(syncStarts.length, 1, "sign-up creates an authenticated session");

    const signOutResponse = await app.request("/sign-out", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(signOutResponse.status, 303);

    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    db.prepare(`UPDATE "user" SET lastLoginAt = NULL WHERE id = @userId`).run({ userId: user.id });
    syncStarts.length = 0;

    const signInResponse = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "user@example.com",
        password: "password123",
      }).toString(),
    });

    assert.equal(signInResponse.status, 303);
    assert.deepEqual(syncStarts, [user.id]);
    const activity = db
      .prepare(`SELECT lastLoginAt FROM "user" WHERE id = @userId`)
      .get({ userId: user.id }) as { lastLoginAt: string | null };
    assert.ok(activity.lastLoginAt);
  }, {
    skipInitialSync: false,
    startUserSync: (_db, user) => {
      syncStarts.push(user.id);
      return true;
    },
  });
});

test("failed authentication does not record login activity or start a sync", async () => {
  const syncStarts: string[] = [];
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    await app.request("/sign-out", { method: "POST", headers: { cookie } });

    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    db.prepare(`UPDATE "user" SET lastLoginAt = NULL WHERE id = @userId`).run({ userId: user.id });
    syncStarts.length = 0;

    const response = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "user@example.com",
        password: "wrong-password",
      }).toString(),
    });

    assert.equal(response.status, 303);
    assert.deepEqual(syncStarts, []);
    const activity = db
      .prepare(`SELECT lastLoginAt FROM "user" WHERE id = @userId`)
      .get({ userId: user.id }) as { lastLoginAt: string | null };
    assert.equal(activity.lastLoginAt, null);
  }, {
    skipInitialSync: false,
    startUserSync: (_db, user) => {
      syncStarts.push(user.id);
      return true;
    },
  });
});

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

test("sign out clears secure session cookies behind an HTTP deployment proxy", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    assert.match(cookie, /__Secure-better-auth\.session_token=/);

    const signOutResponse = await app.request("/sign-out", {
      method: "POST",
      headers: { cookie },
    });

    assert.equal(signOutResponse.status, 303);
    assert.match(
      signOutResponse.headers.get("set-cookie") ?? "",
      /__Secure-better-auth\.session_token=; Max-Age=0/,
    );
  }, { authBaseURL: "https://cflist.example" });
});

test("GET /sign-in/github redirects to GitHub when configured", async () => {
  await withApp(async (app) => {
    const response = await app.request("/sign-in/github?returnTo=/problems");

    assert.equal(response.status, 303);
    const location = response.headers.get("location") ?? "";
    assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize/);
    assert.match(location, /client_id=test-github-client-id/);

    const setCookie = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter(Boolean);
    assert.ok(setCookie.length > 0, "OAuth state cookie must be forwarded to the browser");
    assert.match(setCookie.join("; "), /better-auth\.state=/);
  }, { github: true });
});

test("GET /sign-in/github returns 404 when GitHub is not configured", async () => {
  await withApp(async (app) => {
    const response = await app.request("/sign-in/github");
    assert.equal(response.status, 404);
  });
});

test("signed-in user without cfHandle is redirected to complete profile", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUpWithoutCfHandle(app, db);

    const response = await app.request("/problems", { headers: { cookie } });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location") ?? "", /^\/complete-profile\?returnTo=/);
  });
});

test("complete profile sets cfHandle and unlocks protected pages", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUpWithoutCfHandle(app, db);

    const blockedResponse = await app.request("/problems", { headers: { cookie } });
    assert.equal(blockedResponse.status, 302);

    const completeResponse = await app.request("/complete-profile", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        cfHandle: "tourist",
        returnTo: "/problems",
      }).toString(),
    });
    assert.equal(completeResponse.status, 302);
    assert.equal(completeResponse.headers.get("location"), "/problems");

    const user = db.prepare(`SELECT cfHandle FROM "user" WHERE email = 'user@example.com'`).get() as {
      cfHandle: string;
    };
    assert.equal(user.cfHandle, "tourist");

    const problemsResponse = await app.request("/problems", { headers: { cookie } });
    assert.equal(problemsResponse.status, 200);
  });
});

test("complete profile form posts to the complete-profile route", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUpWithoutCfHandle(app, db);
    const response = await app.request("/complete-profile", { headers: { cookie } });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /action="\/complete-profile"/);
  });
});

test("complete profile rejects unknown Codeforces handle", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUpWithoutCfHandle(app, db);
    setVerifyHandleForTests(async () => false);

    const completeResponse = await app.request("/complete-profile", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        cfHandle: "not-a-real-handle",
        returnTo: "/problems",
      }).toString(),
    });
    assert.equal(completeResponse.status, 302);
    assert.match(completeResponse.headers.get("location") ?? "", /error=/);

    const user = db.prepare(`SELECT cfHandle FROM "user" WHERE email = 'user@example.com'`).get() as {
      cfHandle: string;
    };
    assert.equal(user.cfHandle, "");
  });
});

test("settings handle page allows changing handle", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);

    const pageResponse = await app.request("/settings/handle", { headers: { cookie } });
    assert.equal(pageResponse.status, 200);
    const html = await pageResponse.text();
    assert.match(html, /Change Codeforces handle/);
    assert.match(html, /tourist/);

    const saveResponse = await app.request("/settings/handle", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        cfHandle: "Petr",
        returnTo: "/problems",
      }).toString(),
    });
    assert.equal(saveResponse.status, 302);
    assert.equal(saveResponse.headers.get("location"), "/problems");

    const user = db.prepare(`SELECT cfHandle FROM "user" WHERE email = 'user@example.com'`).get() as {
      cfHandle: string;
    };
    assert.equal(user.cfHandle, "Petr");
  });
});

test("sign-in page shows GitHub button when configured", async () => {
  await withApp(async (app) => {
    const response = await app.request("/sign-in");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Continue with GitHub/);
    assert.match(html, /\/sign-in\/github/);
  }, { github: true });
});

test("sign-in page hides GitHub button when not configured", async () => {
  await withApp(async (app) => {
    const response = await app.request("/sign-in");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, /Continue with GitHub/);
  });
});

test("github-only mode shows GitHub sign-in without email form", async () => {
  await withApp(async (app) => {
    const response = await app.request("/sign-in");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Continue with GitHub/);
    assert.match(html, /Sign in or create account/);
    assert.doesNotMatch(html, /type="password"/);
    assert.doesNotMatch(html, /Need an account\?/);
    assert.doesNotMatch(html, /href="\/sign-up"/);
  }, { github: true, githubOnly: true });
});

test("github-only mode rejects email sign-in and redirects sign-up", async () => {
  await withApp(async (app) => {
    const signInResponse = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "user@example.com",
        password: "password123",
      }).toString(),
    });
    assert.equal(signInResponse.status, 404);

    const signUpGet = await app.request("/sign-up?returnTo=/problems");
    assert.equal(signUpGet.status, 302);
    assert.equal(signUpGet.headers.get("location"), "/sign-in?returnTo=%2Fproblems");

    const signUpPost = await app.request("/sign-up", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Test User",
        email: "user@example.com",
        password: "password123",
        cfHandle: "tourist",
      }).toString(),
    });
    assert.equal(signUpPost.status, 404);
  }, { github: true, githubOnly: true });
});

test("github-only mode requires GitHub credentials", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  assert.throws(
    () =>
      createApp(db, {
        publicRoot: "src/public",
        authBaseURL: "http://localhost",
        authSecret: "test-secret-with-enough-length-32",
        authTrustedOrigins: ["http://localhost"],
        skipInitialSync: true,
        authGitHubOnly: true,
      }),
    /GitHub-only auth requires/,
  );

  db.close();
});
