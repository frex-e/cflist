import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { createAuth, type AuthSession, type AuthUser } from "./auth.js";
import type { Db } from "./db/connection.js";
import { getDefaultFilterQuery } from "./db/queries.js";
import { kickContestSyncQueue, syncState, syncUserStatus } from "./cf/sync.js";
import { layout } from "./views/layout.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerContestsRoutes } from "./routes/contests.js";
import { registerProblemsRoutes } from "./routes/problems.js";

export type AppConfig = {
  publicRoot: string;
  authBaseURL: string;
  authSecret: string;
  authTrustedOrigins: string[];
};

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

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

export const createApp = (db: Db, appConfig: AppConfig): Hono<{ Variables: AppVariables }> => {
  const auth = createAuth(db, {
    baseURL: appConfig.authBaseURL,
    secret: appConfig.authSecret,
    trustedOrigins: [...new Set([appConfig.authBaseURL, ...appConfig.authTrustedOrigins])],
  });
  const app = new Hono<{ Variables: AppVariables }>();

  app.use(
    "/public/htmx.min.js",
    serveStatic({
      root: "./node_modules/htmx.org/dist",
      rewriteRequestPath: () => "/htmx.min.js",
    }),
  );
  app.use("/public/*", serveStatic({ root: appConfig.publicRoot }));

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
    origin?: string,
  ): Promise<Response> => {
    const baseOrigin = origin ?? appConfig.authBaseURL;
    const url = new URL(`/api/auth/${endpoint}`, baseOrigin);
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

  const proxyAuthSignOut = async (cookie?: string, origin?: string): Promise<Response> => {
    const baseOrigin = origin ?? appConfig.authBaseURL;
    const url = new URL("/api/auth/sign-out", baseOrigin);
    const headers = new Headers({ origin: url.origin });
    if (cookie) headers.set("cookie", cookie);

    return auth.handler(
      new Request(url, {
        method: "POST",
        headers,
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

  const runSyncInBackground = (user: AuthUser): void => {
    void syncUserStatus(db, user.id, user.cfHandle)
      .then(() => kickContestSyncQueue(db))
      .catch((error) => {
        console.error("Codeforces sync failed:", error);
      });
  };

  app.get("/", (c) => c.redirect(c.get("user") ? "/problems" : "/sign-in"));

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      catalogSyncRunning: syncState.catalogRunning,
      userSyncRunning: syncState.userRunning.size,
      contestQueueRunning: syncState.contestQueueRunning,
    });
  });

  registerAuthRoutes(app, {
    proxyAuthForm,
    proxyAuthSignOut,
    authErrorRedirect,
    redirectWithAuthCookies,
  });

  registerProblemsRoutes(app, {
    db,
    requireUser,
    isHtmx,
    defaultFilterParams,
    runSyncInBackground,
  });

  registerContestsRoutes(app, {
    db,
    requireUser,
  });

  app.notFound((c) => c.html(notFoundPage(c.get("user")), 404));

  return app;
};
