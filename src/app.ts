import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "./db/connection.js";
import {
  getFilterOptions,
  getLatestSyncRun,
  getProblem,
  listProblems,
  normalizeFilters,
  setSolvedOverride,
} from "./db/queries.js";
import {
  problemRow,
  problemListUrl,
  problemSummaryOutOfBand,
  problemsAppendFragment,
  problemsListFragment,
  problemsPage,
} from "./views/problems.js";
import { layout } from "./views/layout.js";
import { syncCodeforces, syncState } from "./cf/sync.js";

export type AppConfig = {
  handle: string;
  adminToken: string;
  publicRoot: string;
};

type FormValue = string | File | string[];

const firstString = (value: FormValue | undefined): string => {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
};

const hasAdminAccess = (
  c: Context,
  adminToken: string,
  form?: Record<string, FormValue>,
): boolean => {
  if (!adminToken) return true;
  const headerToken = c.req.header("x-admin-token");
  const queryToken = c.req.query("adminToken");
  const formToken = form ? firstString(form.adminToken) : "";
  return headerToken === adminToken || queryToken === adminToken || formToken === adminToken;
};

const parseContestId = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const runSyncInBackground = (db: Db, handle: string): void => {
  void syncCodeforces(db, handle).catch((error) => {
    console.error("Codeforces sync failed:", error);
  });
};

const safeReturnTo = (value: string): string | undefined => {
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  return value;
};

const notFoundPage = (): string => {
  return layout({
    title: "Not Found",
    body: `<section class="hero"><h1>Not found</h1><p>The requested page does not exist.</p><a class="button" href="/problems">Back to problems</a></section>`,
  });
};

const problemListOptions = (db: Db, appConfig: AppConfig, requestUrl: string) => {
  const params = new URL(requestUrl).searchParams;
  const filters = normalizeFilters(params, appConfig.handle);
  const result = listProblems(db, filters);
  const options = getFilterOptions(db);
  const latestSync = getLatestSyncRun(db);

  return {
    filters,
    result,
    options,
    latestSync,
    syncRunning: syncState.running,
    adminTokenEnabled: Boolean(appConfig.adminToken),
  };
};

const isHtmx = (c: Context): boolean => c.req.header("hx-request") === "true";

export const createApp = (db: Db, appConfig: AppConfig): Hono => {
  const app = new Hono();

  app.use(
    "/public/htmx.min.js",
    serveStatic({
      root: "./node_modules/htmx.org/dist",
      rewriteRequestPath: () => "/htmx.min.js",
    }),
  );
  app.use("/public/*", serveStatic({ root: appConfig.publicRoot }));

  app.get("/", (c) => c.redirect("/problems"));

  app.get("/healthz", (c) => {
    return c.json({ ok: true, syncRunning: syncState.running });
  });

  app.get("/problems", (c) => c.html(problemsPage(problemListOptions(db, appConfig, c.req.url))));

  app.get("/problems/fragment", (c) => {
    const options = problemListOptions(db, appConfig, c.req.url);
    if (c.req.query("append") === "1") {
      return c.html(problemsAppendFragment(options));
    }

    if (isHtmx(c)) {
      c.header("HX-Push-Url", problemListUrl(options.filters, options.filters.page));
    }

    return c.html(`${problemSummaryOutOfBand(options)}${problemsListFragment(options)}`);
  });

  app.post("/problems/:contestId/:index/override", async (c) => {
    const form = await c.req.parseBody();
    if (!hasAdminAccess(c, appConfig.adminToken, form)) {
      return c.text("Forbidden", 403);
    }

    const contestId = parseContestId(c.req.param("contestId"));
    const index = c.req.param("index");
    if (contestId === undefined) return c.text("Invalid contest id", 400);

    const rawOverride = firstString(form.solvedOverride);
    const solvedOverride = rawOverride === "1" ? 1 : null;
    const note = firstString(form.note).trim() || null;
    const returnTo = safeReturnTo(firstString(form.returnTo));
    const problem = getProblem(db, appConfig.handle, contestId, index);

    if (!problem) return c.text("Problem not found", 404);

    setSolvedOverride(db, appConfig.handle, contestId, index, solvedOverride, note);
    const updatedProblem = getProblem(db, appConfig.handle, contestId, index);

    if (isHtmx(c) && updatedProblem) {
      const listUrl = new URL(returnTo ?? "/problems", c.req.url).toString();
      const options = problemListOptions(db, appConfig, listUrl);
      return c.html(
        `${problemSummaryOutOfBand(options)}${problemRow(updatedProblem, {
          showTags: options.filters.showTags,
          returnTo: returnTo ?? "/problems",
          adminTokenEnabled: Boolean(appConfig.adminToken),
        })}`,
      );
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
    const form = await c.req.parseBody();
    if (!hasAdminAccess(c, appConfig.adminToken, form)) {
      return c.text("Forbidden", 403);
    }

    runSyncInBackground(db, appConfig.handle);
    return c.redirect("/problems");
  });

  app.notFound((c) => c.html(notFoundPage(), 404));

  return app;
};
