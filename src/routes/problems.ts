import type { Context, Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import type { Db } from "../db/connection.js";
import {
  getDefaultFilterQuery,
  getFilterOptions,
  getLatestUserSyncRun,
  getProblem,
  listProblems,
  normalizeFilters,
  setDefaultFilterQuery,
  setSolvedOverride,
} from "../db/queries.js";
import { kickContestSyncQueue, syncState, syncUserStatus } from "../cf/sync.js";
import { firstString, formToSearchParams, parseContestId } from "../http/forms.js";
import { safeReturnTo } from "../http/return-to.js";
import {
  problemListQuery,
  problemListUrl,
  problemSummaryOutOfBand,
  problemsAppendFragment,
  problemsListFragment,
  problemsPage,
} from "../views/problems.js";

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

type ProblemsRouteDeps = {
  db: Db;
  requireUser: (c: AppContext) => AuthUser | Response;
  isHtmx: (c: Context) => boolean;
  defaultFilterParams: (userId: string, requestUrl: string) => URLSearchParams | undefined;
  runSyncInBackground: (user: AuthUser) => void;
};

export const registerProblemsRoutes = (
  app: Hono<{ Variables: AppVariables }>,
  deps: ProblemsRouteDeps,
): void => {
  const { db, requireUser, isHtmx, defaultFilterParams, runSyncInBackground } = deps;

  const problemListOptionsFor = (user: AuthUser, requestUrl: string, params?: URLSearchParams) => {
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

  app.get("/problems", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    return c.html(problemsPage(problemListOptionsFor(user, c.req.url, defaultFilterParams(user.id, c.req.url))));
  });

  app.get("/problems/fragment", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const options = problemListOptionsFor(user, c.req.url);
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
      const options = problemListOptionsFor(user, listUrl);
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

    return c.redirect(returnTo ?? "/problems");
  });

  app.post("/admin/sync", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const returnTo = safeReturnTo(firstString(form.returnTo));
    runSyncInBackground(user);
    return c.redirect(returnTo ?? "/problems");
  });

  app.post("/preferences/default-filters", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody({ all: true });
    const filters = normalizeFilters(formToSearchParams(form), user.id, user.cfHandle);
    const query = problemListQuery(filters);

    setDefaultFilterQuery(db, user.id, query);
    if (!isHtmx(c) && c.req.header("accept")?.includes("text/html")) return c.redirect("/problems");
    return c.text("Default saved");
  });
};
