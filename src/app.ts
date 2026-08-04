import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { createAuth, emailAuthEnabled, githubAuthEnabled, needsCfHandle, type AuthSession, type AuthUser } from "./auth.js";
import type { Db } from "./db/connection.js";
import { config } from "./config.js";
import { getDefaultFilterQuery, getManualUserSyncCooldown } from "./db/queries.js";
import { startUserSyncInBackground, type SyncableUser } from "./cf/sync.js";
import { layout, configureLayoutAuth } from "./views/layout.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerContestsRoutes } from "./routes/contests.js";
import { registerProblemsRoutes } from "./routes/problems.js";
import { registerAdminCatalogRoutes } from "./routes/admin-catalog.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSyncRoutes } from "./routes/sync.js";

export type AppConfig = {
  publicRoot: string;
  authBaseURL: string;
  authSecret: string;
  authTrustedOrigins: string[];
  githubClientId?: string;
  githubClientSecret?: string;
  authGitHubOnly?: boolean;
  /** Skip automatic user sync on Problems/Contests page loads (tests). */
  skipInitialSync?: boolean;
  startUserSync?: (db: Db, user: SyncableUser) => boolean;
  /** Override `USER_SYNC_INTERVAL_MINUTES` for page-open freshness (tests). */
  userSyncIntervalMinutes?: number;
};

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

const SLOW_REQUEST_MS = 1_000;

export const shouldLogRequest = (method: string, path: string, status: number, durationMs: number): boolean => {
  if (path === "/healthz") return false;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return true;
  return status >= 400 || durationMs >= SLOW_REQUEST_MS;
};

const notFoundPage = (user: AuthUser | null): string => {
  return layout({
    title: "Not Found",
    user: user ?? undefined,
    body: `<section class="hero"><h1>Not found</h1><p>The requested page does not exist.</p><a class="button" href="/problems">Back to problems</a></section>`,
  });
};

const requireUser = (c: AppContext): AuthUser | Response => {
  const user = c.get("user");
  if (user) return user;

  const requestUrl = new URL(c.req.url);
  const returnTo = `${requestUrl.pathname}${requestUrl.search}`;

  if (isHtmx(c)) {
    c.header("HX-Redirect", `/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    return c.text("Unauthorized", 401);
  }

  return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
};

const requireCompleteUser = (c: AppContext): AuthUser | Response => {
  const user = requireUser(c);
  if (user instanceof Response) return user;
  if (!needsCfHandle(user)) return user;

  const requestUrl = new URL(c.req.url);
  const returnTo = `${requestUrl.pathname}${requestUrl.search}`;

  if (isHtmx(c)) {
    c.header("HX-Redirect", `/complete-profile?returnTo=${encodeURIComponent(returnTo)}`);
    return c.text("Profile incomplete", 401);
  }

  return c.redirect(`/complete-profile?returnTo=${encodeURIComponent(returnTo)}`);
};

const isHtmx = (c: Context): boolean => c.req.header("hx-request") === "true";

const setCookiesFrom = (headers: Headers, source: Headers): void => {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(source) : [source.get("set-cookie")].filter(Boolean);
  for (const cookie of cookies) headers.append("set-cookie", cookie as string);
};

const redirectWithAuthCookies = (authResponse: Response, location: string): Response => {
  const headers = new Headers({ location });
  setCookiesFrom(headers, authResponse.headers);
  return new Response(null, { status: 303, headers });
};

const errorPage = (user: AuthUser | null): string => {
  return layout({
    title: "Error",
    user: user ?? undefined,
    body: `<section class="hero"><h1>Something went wrong</h1><p>Please try again. If the problem persists, check the server logs.</p><a class="button" href="/problems">Back to problems</a></section>`,
  });
};

export const createApp = (db: Db, appConfig: AppConfig): Hono<{ Variables: AppVariables }> => {
  const runSyncInBackground = (user: SyncableUser): boolean =>
    (appConfig.startUserSync ?? startUserSyncInBackground)(db, user);
  const authConfig = {
    baseURL: appConfig.authBaseURL,
    secret: appConfig.authSecret,
    trustedOrigins: [...new Set([appConfig.authBaseURL, ...appConfig.authTrustedOrigins])],
    githubClientId: appConfig.githubClientId,
    githubClientSecret: appConfig.githubClientSecret,
    githubOnly: appConfig.authGitHubOnly,
    onSessionCreated: (userId: string): void => {
      db.prepare(`UPDATE "user" SET lastLoginAt = @lastLoginAt WHERE id = @userId`).run({
        lastLoginAt: new Date().toISOString(),
        userId,
      });
    },
  };
  const auth = createAuth(db, authConfig);
  const githubEnabled = githubAuthEnabled(authConfig);
  const emailEnabled = emailAuthEnabled(authConfig);
  configureLayoutAuth({ emailAuthEnabled: emailEnabled });
  const app = new Hono<{ Variables: AppVariables }>();

  app.use(
    "/public/htmx.min.js",
    serveStatic({
      root: "./node_modules/htmx.org/dist",
      rewriteRequestPath: () => "/htmx.min.js",
    }),
  );
  app.use("/public/*", serveStatic({ root: appConfig.publicRoot }));

  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    await next();
    const durationMs = Date.now() - startedAt;
    const path = new URL(c.req.url).pathname;
    if (shouldLogRequest(c.req.method, path, c.res.status, durationMs)) {
      console.log(`${c.req.method} ${path} ${c.res.status} ${durationMs}ms`);
    }
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", (session?.user as AuthUser | undefined) ?? null);
    c.set("session", (session?.session as AuthSession | undefined) ?? null);
    await next();
  });

  const proxyAuthForm = async (
    endpoint: "sign-in/email" | "sign-up/email",
    body: URLSearchParams,
    cookie?: string,
  ): Promise<Response> => {
    const url = new URL(`/api/auth/${endpoint}`, appConfig.authBaseURL);
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      origin: url.origin,
    });
    if (cookie) headers.set("cookie", cookie);

    return auth.handler(
      new Request(url, {
        method: "POST",
        headers,
        body,
      }),
    );
  };

  const proxyAuthSignOut = async (cookie?: string): Promise<Response> => {
    const url = new URL("/api/auth/sign-out", appConfig.authBaseURL);
    const headers = new Headers({ origin: url.origin });
    if (cookie) headers.set("cookie", cookie);

    return auth.handler(
      new Request(url, {
        method: "POST",
        headers,
      }),
    );
  };

  const startGitHubSignIn = async (returnTo: string): Promise<Response> => {
    const url = new URL("/api/auth/sign-in/social", appConfig.authBaseURL);
    const headers = new Headers({
      "content-type": "application/json",
      origin: url.origin,
    });

    return auth.handler(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "github",
          callbackURL: returnTo,
          newUserCallbackURL: `/complete-profile?returnTo=${encodeURIComponent(returnTo)}`,
          errorCallbackURL: "/sign-in",
          disableRedirect: true,
        }),
      }),
    );
  };

  const authErrorRedirect = async (response: Response, fallback: string): Promise<Response> => {
    const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
    const message = body?.message ?? "Authentication failed";
    return new Response(null, {
      status: 303,
      headers: { location: `${fallback}?error=${encodeURIComponent(message)}` },
    });
  };

  const defaultFilterParams = (userId: string, requestUrl: string): URLSearchParams | undefined => {
    const url = new URL(requestUrl);
    if (url.searchParams.get("default") === "0") return url.searchParams;
    if (url.search) return undefined;

    const query = getDefaultFilterQuery(db, userId);
    return query ? new URLSearchParams(query) : undefined;
  };

  const maybeStartPageSync = (user: SyncableUser): boolean => {
    if (appConfig.skipInitialSync) return false;
    if (!user.cfHandle?.trim()) return false;

    const intervalMinutes = appConfig.userSyncIntervalMinutes ?? config.userSyncIntervalMinutes;
    const intervalMs = Math.max(0, intervalMinutes) * 60 * 1000;
    const cooldown = getManualUserSyncCooldown(db, user.id, intervalMs);
    if (!cooldown.allowed) return false;

    return runSyncInBackground(user);
  };

  app.get("/", (c) => c.redirect(c.get("user") ? "/problems" : "/sign-in"));

  app.get("/healthz", (c) => {
    try {
      db.prepare("SELECT 1 AS ok").get();
      return c.json({ ok: true });
    } catch (error) {
      console.error("Health check failed:", error);
      return c.json({ ok: false }, 503);
    }
  });

  registerAuthRoutes(app, {
    githubEnabled,
    emailEnabled,
    db,
    proxyAuthForm,
    proxyAuthSignOut,
    startGitHubSignIn,
    authErrorRedirect,
    redirectWithAuthCookies,
    maybeStartPageSync,
    runSyncInBackground,
  });

  registerProblemsRoutes(app, {
    db,
    requireUser: requireCompleteUser,
    defaultFilterParams,
    maybeStartPageSync,
  });

  registerContestsRoutes(app, {
    db,
    requireUser: requireCompleteUser,
    maybeStartPageSync,
  });

  registerSettingsRoutes(app, {
    db,
    proxyAuthSignOut,
    redirectWithAuthCookies,
    runSyncInBackground,
  });

  registerSyncRoutes(app, {
    db,
    requireUser: requireCompleteUser,
    runSyncInBackground,
  });

  registerAdminCatalogRoutes(app, { db });

  app.notFound((c) => c.html(notFoundPage(c.get("user")), 404));

  app.onError((error, c) => {
    console.error("Unhandled error:", error);
    return c.html(errorPage(c.get("user")), 500);
  });

  return app;
};
