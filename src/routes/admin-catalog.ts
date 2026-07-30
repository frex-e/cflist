import type { Context, Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import { needsCfHandle } from "../auth.js";
import {
  estimateMissingProblemRatings,
  kickContestSyncQueue,
} from "../cf/sync.js";
import { getCodeforcesClient } from "../cf/shared-client.js";
import { isAdminEmail } from "../config.js";
import type { Db } from "../db/connection.js";
import { firstString } from "../http/forms.js";
import {
  clearContestEstimates,
  clearProblemEstimate,
  confirmLookupMatches,
  dropContestRatingChangesCache,
  forceRehydrateContestForAllUsers,
  getContestRepairSummary,
  getProblemRepairSummary,
  parseCatalogLookup,
} from "../db/writes/catalog-repair.js";
import { adminCatalogPage } from "../views/admin-catalog.js";
import { layout } from "../views/layout.js";

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

type AdminCatalogRouteDeps = {
  db: Db;
};

const notFoundHtml = (user: AuthUser | null): string =>
  layout({
    title: "Not Found",
    user: user ?? undefined,
    body: `<section class="hero"><h1>Not found</h1><p>The requested page does not exist.</p><a class="button" href="/problems">Back to problems</a></section>`,
  });

const redirectToCatalog = (params: Record<string, string>): Response => {
  const query = new URLSearchParams(params);
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/catalog?${query.toString()}` },
  });
};

const requireAdmin = (c: AppContext): AuthUser | Response => {
  const user = c.get("user");
  if (!user) {
    const returnTo = `/admin/catalog${new URL(c.req.url).search}`;
    return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (needsCfHandle(user) || !isAdminEmail(user.email)) {
    return c.html(notFoundHtml(user), 404);
  }
  return user;
};

export const registerAdminCatalogRoutes = (
  app: Hono<{ Variables: AppVariables }>,
  deps: AdminCatalogRouteDeps,
): void => {
  const { db } = deps;

  app.get("/admin/catalog", (c) => {
    const user = requireAdmin(c);
    if (user instanceof Response) return user;

    const lookup = c.req.query("q")?.trim() ?? "";
    const error = c.req.query("error") ?? undefined;
    const success = c.req.query("success") ?? undefined;

    if (!lookup) {
      return c.html(adminCatalogPage({ user, error, success }));
    }

    const parsed = parseCatalogLookup(lookup);
    if (!parsed) {
      return c.html(
        adminCatalogPage({
          user,
          lookup,
          error: error ?? "Enter a contest id (e.g. 1900) or problem key (e.g. 1900A).",
          success,
        }),
      );
    }

    if (parsed.kind === "contest") {
      const contest = getContestRepairSummary(db, parsed.contestId);
      if (!contest) {
        return c.html(
          adminCatalogPage({
            user,
            lookup,
            error: error ?? `Contest ${parsed.contestId} not found in the local catalog.`,
            success,
          }),
        );
      }
      return c.html(adminCatalogPage({ user, lookup, contest, error, success }));
    }

    const problem = getProblemRepairSummary(db, parsed.contestId, parsed.problemIndex);
    if (!problem) {
      return c.html(
        adminCatalogPage({
          user,
          lookup,
          error:
            error ??
            `Problem ${parsed.contestId}${parsed.problemIndex} not found in the local catalog.`,
          success,
        }),
      );
    }
    return c.html(adminCatalogPage({ user, lookup, problem, error, success }));
  });

  app.post("/admin/catalog/clear-estimates", async (c) => {
    const user = requireAdmin(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const contestIdRaw = firstString(form.contestId);
    const problemIndex = firstString(form.problemIndex).trim();
    const contestId = Number.parseInt(contestIdRaw, 10);
    if (!Number.isFinite(contestId)) {
      return redirectToCatalog({ error: "Invalid contest id." });
    }

    const expectedConfirm = problemIndex ? `${contestId}${problemIndex}` : String(contestId);
    if (!confirmLookupMatches(firstString(form.confirm), expectedConfirm)) {
      return redirectToCatalog({
        q: expectedConfirm,
        error: "Confirmation did not match.",
      });
    }

    if (problemIndex) {
      const summary = getProblemRepairSummary(db, contestId, problemIndex);
      if (!summary) {
        return redirectToCatalog({
          q: expectedConfirm,
          error: `Problem ${expectedConfirm} not found.`,
        });
      }
      clearProblemEstimate(db, contestId, problemIndex);
    } else {
      const summary = getContestRepairSummary(db, contestId);
      if (!summary) {
        return redirectToCatalog({
          q: expectedConfirm,
          error: `Contest ${contestId} not found.`,
        });
      }
      clearContestEstimates(db, contestId);
    }

    void estimateMissingProblemRatings(db, getCodeforcesClient()).catch((error: unknown) => {
      console.error("Catalog repair estimate pass failed:", error);
    });

    return redirectToCatalog({
      q: expectedConfirm,
      success: problemIndex
        ? `Cleared estimate for ${expectedConfirm}. Re-estimate started in the background.`
        : `Cleared estimates for contest ${contestId}. Re-estimate started in the background.`,
    });
  });

  app.post("/admin/catalog/drop-rating-cache", async (c) => {
    const user = requireAdmin(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const contestId = Number.parseInt(firstString(form.contestId), 10);
    if (!Number.isFinite(contestId)) {
      return redirectToCatalog({ error: "Invalid contest id." });
    }
    if (!confirmLookupMatches(firstString(form.confirm), String(contestId))) {
      return redirectToCatalog({
        q: String(contestId),
        error: "Confirmation did not match.",
      });
    }

    const summary = getContestRepairSummary(db, contestId);
    if (!summary) {
      return redirectToCatalog({
        q: String(contestId),
        error: `Contest ${contestId} not found.`,
      });
    }

    const dropped = dropContestRatingChangesCache(db, contestId);
    return redirectToCatalog({
      q: String(contestId),
      success:
        dropped > 0
          ? `Dropped rating-changes cache for contest ${contestId}.`
          : `No rating-changes cache was present for contest ${contestId}.`,
    });
  });

  app.post("/admin/catalog/force-rehydrate", async (c) => {
    const user = requireAdmin(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const contestId = Number.parseInt(firstString(form.contestId), 10);
    if (!Number.isFinite(contestId)) {
      return redirectToCatalog({ error: "Invalid contest id." });
    }
    if (!confirmLookupMatches(firstString(form.confirm), String(contestId))) {
      return redirectToCatalog({
        q: String(contestId),
        error: "Confirmation did not match.",
      });
    }

    const summary = getContestRepairSummary(db, contestId);
    if (!summary) {
      return redirectToCatalog({
        q: String(contestId),
        error: `Contest ${contestId} not found.`,
      });
    }

    const userCount = forceRehydrateContestForAllUsers(db, contestId);
    kickContestSyncQueue(db);

    return redirectToCatalog({
      q: String(contestId),
      success:
        userCount > 0
          ? `Queued rehydration for ${userCount} user${userCount === 1 ? "" : "s"} on contest ${contestId}.`
          : `Cleared caches for contest ${contestId}. No user standings rows to requeue.`,
    });
  });
};
