import type { Context, Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import type { Db } from "../db/connection.js";
import {
  getFilterOptions,
  getProblem,
  listProblems,
  normalizeFilters,
  setDefaultFilterQuery,
  setProblemOverride,
  type LocalProblemStatus,
} from "../db/queries.js";
import { currentPageFromRequest } from "../http/current-page.js";
import { firstString, formToSearchParams, parseContestId } from "../http/forms.js";
import { buildSyncPanelOptions } from "../http/sync-panel.js";
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
  defaultFilterParams: (userId: string, requestUrl: string) => URLSearchParams | undefined;
  maybeStartPageSync: (user: AuthUser) => boolean;
};

const syncNoticeFrom = (requestUrl: string): string | undefined => {
  const param = new URL(requestUrl).searchParams.get("sync");
  return param === "already-running" ? "already-running" : undefined;
};

export const registerProblemsRoutes = (
  app: Hono<{ Variables: AppVariables }>,
  deps: ProblemsRouteDeps,
): void => {
  const { db, requireUser, defaultFilterParams, maybeStartPageSync } = deps;

  const problemListOptionsFor = (
    user: AuthUser,
    requestUrl: string,
    params?: URLSearchParams,
    autoSyncStarted = false,
  ) => {
    params ??= new URL(requestUrl).searchParams;
    const filters = normalizeFilters(params, user.id, user.cfHandle);
    const result = listProblems(db, filters);
    const options = getFilterOptions(db);
    const listUrl = problemListUrl(filters, filters.page);

    return {
      filters,
      result,
      options,
      syncPanel: buildSyncPanelOptions(
        db,
        user,
        listUrl,
        "problems",
        syncNoticeFrom(requestUrl),
        autoSyncStarted,
      ),
      user,
    };
  };

  app.get("/problems", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const autoSyncStarted = maybeStartPageSync(user);
    return c.html(problemsPage(problemListOptionsFor(user, c.req.url, defaultFilterParams(user.id, c.req.url), autoSyncStarted)));
  });

  app.get("/problems/fragment", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const options = problemListOptionsFor(user, c.req.url);
    if (c.req.query("append") === "1") {
      return c.html(problemsAppendFragment(options));
    }

    c.header("HX-Push-Url", problemListUrl(options.filters, options.filters.page));
    return c.html(`${problemSummaryOutOfBand(options)}${problemsListFragment(options)}`);
  });

  app.post("/problems/:contestId/:index/override", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const contestId = parseContestId(c.req.param("contestId"));
    const index = c.req.param("index");
    if (contestId === undefined) return c.text("Invalid contest id", 400);

    const rawLocalStatus = firstString(form.localStatus);
    const rawOverride = firstString(form.solvedOverride);
    let localStatus: LocalProblemStatus = null;
    if (rawLocalStatus === "skipped" || rawLocalStatus === "solved") {
      localStatus = rawLocalStatus;
    } else if (rawLocalStatus === "") {
      localStatus = null;
    } else if (rawOverride === "1") {
      localStatus = "solved";
    }
    const note = firstString(form.note).trim() || null;
    const problem = getProblem(db, user.id, contestId, index);

    if (!problem) return c.text("Problem not found", 404);

    setProblemOverride(db, user.id, contestId, index, localStatus, note);

    const listUrl = new URL(currentPageFromRequest(c), c.req.url).toString();
    const options = problemListOptionsFor(user, listUrl);
    return c.html(`${problemsListFragment(options)}${problemSummaryOutOfBand(options)}`);
  });

  app.post("/preferences/default-filters", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody({ all: true });
    const filters = normalizeFilters(formToSearchParams(form), user.id, user.cfHandle);
    const query = problemListQuery(filters);

    setDefaultFilterQuery(db, user.id, query);
    return c.text("Default saved");
  });
};
