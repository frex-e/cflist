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
import { problemPage, notFoundPage } from "./views/problem.js";
import { problemsPage } from "./views/problems.js";
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

export const createApp = (db: Db, appConfig: AppConfig): Hono => {
  const app = new Hono();

  app.use("/public/*", serveStatic({ root: appConfig.publicRoot }));

  app.get("/", (c) => c.redirect("/problems"));

  app.get("/healthz", (c) => {
    return c.json({ ok: true, syncRunning: syncState.running });
  });

  app.get("/problems", (c) => {
    const params = new URL(c.req.url).searchParams;
    const filters = normalizeFilters(params, appConfig.handle);
    const result = listProblems(db, filters);
    const options = getFilterOptions(db);
    const latestSync = getLatestSyncRun(db);

    return c.html(
      problemsPage({
        filters,
        result,
        options,
        latestSync,
        syncRunning: syncState.running,
        adminTokenEnabled: Boolean(appConfig.adminToken),
      }),
    );
  });

  app.get("/problems/:contestId/:index", (c) => {
    const contestId = parseContestId(c.req.param("contestId"));
    const index = c.req.param("index");
    if (contestId === undefined) return c.html(notFoundPage(), 404);

    const problem = getProblem(db, appConfig.handle, contestId, index);
    if (!problem) return c.html(notFoundPage(), 404);

    return c.html(
      problemPage({
        problem,
        handle: appConfig.handle,
        adminTokenEnabled: Boolean(appConfig.adminToken),
      }),
    );
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
