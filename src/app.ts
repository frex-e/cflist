import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { createAuth, type AuthSession, type AuthUser } from "./auth.js";
import type { Db } from "./db/connection.js";
import {
  getDefaultFilterQuery,
  getFilterOptions,
  getLatestUserSyncRun,
  getProblem,
  listUserContestResults,
  listProblems,
  normalizeFilters,
  setDefaultFilterQuery,
  setSolvedOverride,
} from "./db/queries.js";
import {
  problemListQuery,
  problemListUrl,
  problemSummaryOutOfBand,
  problemsAppendFragment,
  problemsListFragment,
  problemsPage,
} from "./views/problems.js";
import { contestsPage } from "./views/contests.js";
import { layout } from "./views/layout.js";
import { signInPage, signUpPage } from "./views/auth.js";
import { syncState, syncUserStatus } from "./cf/sync.js";

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
type FormValue = string | File | string[];

const firstString = (value: FormValue | undefined): string => {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
};

const parseContestId = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const safeReturnTo = (value: string | undefined): string | undefined => {
  if (!value?.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  return value;
};

const formToSearchParams = (form: Record<string, FormValue>): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string") params.append(key, item);
    }
  }
  return params;
};

const formToBody = (form: Record<string, FormValue>, keys: string[]): URLSearchParams => {
  const params = new URLSearchParams();
  for (const key of keys) {
    const rawValue = firstString(form[key]);
    const value = key === "password" ? rawValue : rawValue.trim();
    if (value) params.set(key, value);
  }
  return params;
};

const defaultFilterParams = (db: Db, userId: string, requestUrl: string): URLSearchParams | undefined => {
  const url = new URL(requestUrl);
  if (url.search) return undefined;

  const query = getDefaultFilterQuery(db, userId);
  return query ? new URLSearchParams(query) : undefined;
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

  if (isHtmx(c)) {
    c.header("HX-Redirect", `/sign-in?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}`);
    return c.text("Unauthorized", 401);
  }

  return c.redirect(`/sign-in?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}`);
};

const problemListOptions = (db: Db, user: AuthUser, requestUrl: string, params?: URLSearchParams) => {
  params ??= new URL(requestUrl).searchParams;
  const filters = normalizeFilters(params, user.id, user.cfHandle);
  const result = listProblems(db, filters);
  const options = getFilterOptions(db);
  const latestSync = getLatestUserSyncRun(db, user.id);

  return {
    filters,
    result,
    options,
    latestSync,
    syncRunning: syncState.userRunning.has(user.id),
    user,
  };
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

const runSyncInBackground = (db: Db, user: AuthUser): void => {
  void syncUserStatus(db, user.id, user.cfHandle).catch((error) => {
    console.error("Codeforces sync failed:", error);
  });
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
    c: AppContext,
    endpoint: "sign-in/email" | "sign-up/email" | "sign-out",
    body: URLSearchParams,
  ): Promise<Response> => {
    const url = new URL(`/api/auth/${endpoint}`, c.req.url);
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      origin: url.origin,
    });
    const cookie = c.req.header("cookie");
    if (cookie) headers.set("cookie", cookie);

    return auth.handler(
      new Request(url, {
        method: "POST",
        headers,
        body,
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

  app.get("/", (c) => c.redirect(c.get("user") ? "/problems" : "/sign-in"));

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      catalogSyncRunning: syncState.catalogRunning,
      userSyncRunning: syncState.userRunning.size,
    });
  });

  app.get("/sign-in", (c) => {
    if (c.get("user")) return c.redirect(safeReturnTo(c.req.query("returnTo")) ?? "/problems");
    return c.html(signInPage({ error: c.req.query("error"), returnTo: c.req.query("returnTo") }));
  });

  app.post("/sign-in", async (c) => {
    const form = await c.req.parseBody();
    const returnTo = safeReturnTo(firstString(form.returnTo)) ?? "/problems";
    const response = await proxyAuthForm(
      c,
      "sign-in/email",
      formToBody(form, ["email", "password"]),
    );
    if (!response.ok) return authErrorRedirect(response, "/sign-in");
    return redirectWithAuthCookies(response, returnTo);
  });

  app.get("/sign-up", (c) => {
    if (c.get("user")) return c.redirect(safeReturnTo(c.req.query("returnTo")) ?? "/problems");
    return c.html(signUpPage({ error: c.req.query("error"), returnTo: c.req.query("returnTo") }));
  });

  app.post("/sign-up", async (c) => {
    const form = await c.req.parseBody();
    const returnTo = safeReturnTo(firstString(form.returnTo)) ?? "/problems";
    const response = await proxyAuthForm(
      c,
      "sign-up/email",
      formToBody(form, ["name", "email", "password", "cfHandle"]),
    );
    if (!response.ok) return authErrorRedirect(response, "/sign-up");
    return redirectWithAuthCookies(response, returnTo);
  });

  app.post("/sign-out", async (c) => {
    const response = await proxyAuthForm(c, "sign-out", new URLSearchParams());
    return redirectWithAuthCookies(response, "/sign-in");
  });

  app.get("/problems", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    return c.html(problemsPage(problemListOptions(db, user, c.req.url, defaultFilterParams(db, user.id, c.req.url))));
  });

  app.get("/contests", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    return c.html(contestsPage({
      rows: listUserContestResults(db, user.id),
      latestSync: getLatestUserSyncRun(db, user.id),
      syncRunning: syncState.userRunning.has(user.id),
      user,
    }));
  });

  app.get("/problems/fragment", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const options = problemListOptions(db, user, c.req.url);
    if (c.req.query("append") === "1") {
      return c.html(problemsAppendFragment(options));
    }

    if (isHtmx(c)) {
      c.header("HX-Push-Url", problemListUrl(options.filters, options.filters.page));
    }

    return c.html(`${problemSummaryOutOfBand(options)}${problemsListFragment(options)}`);
  });

  app.post("/problems/:contestId/:index/override", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const contestId = parseContestId(c.req.param("contestId"));
    const index = c.req.param("index");
    if (contestId === undefined) return c.text("Invalid contest id", 400);

    const rawOverride = firstString(form.solvedOverride);
    const solvedOverride = rawOverride === "1" ? 1 : null;
    const note = firstString(form.note).trim() || null;
    const returnTo = safeReturnTo(firstString(form.returnTo));
    const problem = getProblem(db, user.id, contestId, index);

    if (!problem) return c.text("Problem not found", 404);

    setSolvedOverride(db, user.id, contestId, index, solvedOverride, note);
    const updatedProblem = getProblem(db, user.id, contestId, index);

    if (isHtmx(c) && updatedProblem) {
      const listUrl = new URL(returnTo ?? "/problems", c.req.url).toString();
      const options = problemListOptions(db, user, listUrl);
      return c.html(`${problemsListFragment(options)}${problemSummaryOutOfBand(options)}`);
    }

    if (c.req.header("accept")?.includes("application/json")) {
      return c.json({
        contestId,
        problemIndex: index,
        cfSolved: updatedProblem?.cf_solved === 1,
        solvedOverride: updatedProblem?.solved_override ?? null,
        effectiveSolved: updatedProblem?.effective_solved === 1,
      });
    }

    return c.redirect(returnTo ?? `/problems/${contestId}/${encodeURIComponent(index)}`);
  });

  app.post("/admin/sync", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const returnTo = safeReturnTo(firstString(form.returnTo));
    runSyncInBackground(db, user);
    return c.redirect(returnTo ?? "/problems");
  });

  app.post("/preferences/default-filters", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const filters = normalizeFilters(formToSearchParams(form), user.id, user.cfHandle);
    const query = problemListQuery(filters);

    setDefaultFilterQuery(db, user.id, query);
    return c.text("Default saved");
  });

  app.notFound((c) => c.html(notFoundPage(c.get("user")), 404));

  return app;
};
