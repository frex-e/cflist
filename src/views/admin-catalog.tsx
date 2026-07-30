import type { Child } from "hono/jsx";
import type { AuthUser } from "../auth.js";
import type {
  ContestRepairSummary,
  ProblemRepairSummary,
} from "../db/writes/catalog-repair.js";
import { layout } from "./layout.js";
import { PageHero } from "./page-hero.js";
import { render } from "./render.js";

type AdminCatalogPageOptions = {
  user: AuthUser;
  error?: string;
  success?: string;
  lookup?: string;
  contest?: ContestRepairSummary;
  problem?: ProblemRepairSummary;
};

const confirmField = (expected: string): Child => (
  <label>
    Type <strong>{expected}</strong> to confirm
    <input type="text" name="confirm" autocomplete="off" required />
  </label>
);

const contestActions = (contest: ContestRepairSummary): Child => {
  const confirm = String(contest.contestId);
  return (
    <section class="settings-section">
      <h2>Contest actions</h2>
      <p>
        Soft repair only — contest and problem rows stay; solved status and overrides stay.
      </p>

      <form class="settings-form" method="post" action="/admin/catalog/clear-estimates">
        <input type="hidden" name="contestId" value={String(contest.contestId)} />
        <p>
          Clear estimated ratings for all {contest.estimatedCount} estimated problem
          {contest.estimatedCount === 1 ? "" : "s"} in this contest, then re-run the estimate
          pass.
        </p>
        {confirmField(confirm)}
        <button type="submit" class="button secondary">
          Clear contest estimates
        </button>
      </form>

      <form class="settings-form" method="post" action="/admin/catalog/drop-rating-cache">
        <input type="hidden" name="contestId" value={String(contest.contestId)} />
        <p>
          Drop the shared rating-changes cache
          {contest.hasRatingChangesCache ? " (present)" : " (already empty)"}. Next hydration or
          estimate will re-fetch from Codeforces.
        </p>
        {confirmField(confirm)}
        <button type="submit" class="button secondary">
          Drop rating-changes cache
        </button>
      </form>

      <form class="settings-form" method="post" action="/admin/catalog/force-rehydrate">
        <input type="hidden" name="contestId" value={String(contest.contestId)} />
        <p>
          Invalidate shared caches and standings freshness for all{" "}
          {contest.userResultCount} user{contest.userResultCount === 1 ? "" : "s"} on this contest
          ({contest.hydratedUserCount} currently hydrated), then requeue hydration. Does not clear
          solved status.
        </p>
        {confirmField(confirm)}
        <button type="submit" class="button secondary">
          Force rehydrate (all users)
        </button>
      </form>
    </section>
  );
};

const problemActions = (problem: ProblemRepairSummary): Child => {
  const confirm = `${problem.contestId}${problem.problemIndex}`;
  return (
    <section class="settings-section">
      <h2>Problem actions</h2>
      <p>Soft repair only — the problem row and canonical id stay.</p>

      <form class="settings-form" method="post" action="/admin/catalog/clear-estimates">
        <input type="hidden" name="contestId" value={String(problem.contestId)} />
        <input type="hidden" name="problemIndex" value={problem.problemIndex} />
        <p>
          Clear estimated rating
          {problem.estimatedRating != null ? ` (~${problem.estimatedRating})` : " (none set)"} and
          re-run the estimate pass for this contest’s unrated problems.
        </p>
        {confirmField(confirm)}
        <button type="submit" class="button secondary">
          Clear problem estimate
        </button>
      </form>
    </section>
  );
};

export const adminCatalogPage = (options: AdminCatalogPageOptions): string => {
  return layout({
    title: "Catalog repair",
    user: options.user,
    body: render(
      <div class="settings-page">
        <PageHero
          title="Catalog repair"
          subtitle="Soft-invalidate shared Codeforces caches and estimates. Contest and problem rows are never deleted."
        />
        {options.error ? <p class="form-error settings-banner">{options.error}</p> : ""}
        {options.success ? <p class="form-success settings-banner">{options.success}</p> : ""}

        <div class="settings-sections">
          <section class="settings-section">
            <h2>Lookup</h2>
            <p>Enter a contest id (e.g. 1900) or problem key (e.g. 1900A).</p>
            <form class="settings-form" method="get" action="/admin/catalog">
              <label>
                Contest or problem
                <input
                  type="text"
                  name="q"
                  value={options.lookup ?? ""}
                  autocomplete="off"
                  required
                  placeholder="1900 or 1900A"
                />
              </label>
              <button type="submit" class="button">
                Look up
              </button>
            </form>
          </section>

          {options.contest ? (
            <section class="settings-section">
              <h2>
                Contest {options.contest.contestId}
              </h2>
              <dl class="settings-dl">
                <div>
                  <dt>Name</dt>
                  <dd>{options.contest.name}</dd>
                </div>
                <div>
                  <dt>Phase</dt>
                  <dd>{options.contest.phase ?? "—"}</dd>
                </div>
                <div>
                  <dt>Problems</dt>
                  <dd>{options.contest.problemCount}</dd>
                </div>
                <div>
                  <dt>With estimate</dt>
                  <dd>{options.contest.estimatedCount}</dd>
                </div>
                <div>
                  <dt>Rating-changes cache</dt>
                  <dd>{options.contest.hasRatingChangesCache ? "Present" : "Absent"}</dd>
                </div>
                <div>
                  <dt>User standings rows</dt>
                  <dd>
                    {options.contest.userResultCount} ({options.contest.hydratedUserCount} hydrated)
                  </dd>
                </div>
              </dl>
            </section>
          ) : (
            ""
          )}

          {options.problem ? (
            <section class="settings-section">
              <h2>
                Problem {options.problem.contestId}
                {options.problem.problemIndex}
              </h2>
              <dl class="settings-dl">
                <div>
                  <dt>Name</dt>
                  <dd>{options.problem.name}</dd>
                </div>
                <div>
                  <dt>Contest</dt>
                  <dd>
                    {options.problem.contestName} ({options.problem.contestId})
                  </dd>
                </div>
                <div>
                  <dt>Official rating</dt>
                  <dd>{options.problem.rating ?? "—"}</dd>
                </div>
                <div>
                  <dt>Estimated rating</dt>
                  <dd>
                    {options.problem.estimatedRating != null
                      ? `~${options.problem.estimatedRating}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Canonical id</dt>
                  <dd>
                    <code>{options.problem.canonicalId}</code>
                  </dd>
                </div>
              </dl>
            </section>
          ) : (
            ""
          )}

          {options.contest ? contestActions(options.contest) : ""}
          {options.problem ? problemActions(options.problem) : ""}
        </div>
      </div>,
    ),
  });
};
