import type { Child } from "hono/jsx";
import type { AuthUser } from "../auth.js";
import type { ContestProblemResultRow, ContestResultRow } from "../db/queries.js";
import { formatNumber } from "./html.js";
import { layout } from "./layout.js";
import { ratingTitle } from "./rating.js";

type ContestsPageOptions = {
  rows: ContestResultRow[];
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  user: AuthUser;
};

const render = (content: Child): string => String(content);

const formatDate = (value: number | null): string => {
  if (value === null) return "";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const signedNumber = (value: number | null): string => {
  if (value === null) return "";
  return value > 0 ? `+${value}` : String(value);
};

const scoreText = (value: number | null): string => {
  if (value === null) return "";
  return Number.isInteger(value) ? formatNumber(value) : value.toFixed(2);
};

const RatingValue = ({ value }: { value: number | null }) => {
  if (value === null) return null;
  const title = ratingTitle(value);
  return (
    <span class={`rating-value ${title.textClassName}`} title={title.name}>
      {formatNumber(value)}
    </span>
  );
};

const ProblemPill = ({ problem }: { problem: ContestProblemResultRow }) => {
  const state = problem.solved_in_contest
    ? "contest-solved"
    : problem.upsolved
      ? "upsolved"
      : "unsolved";
  const title = problem.solved_in_contest
    ? `${problem.problem_index}: solved in contest`
    : problem.upsolved
      ? `${problem.problem_index}: upsolved after contest`
      : `${problem.problem_index}: unsolved`;

  return (
    <a class={`contest-problem-pill ${state}`} href={problem.url} rel="noreferrer" target="_blank" title={title}>
      {problem.problem_index}
    </a>
  );
};

const ContestRow = ({ row }: { row: ContestResultRow }) => {
  const contestHref = `https://codeforces.com/contest/${row.contest_id}`;
  const deltaClass = row.rating_delta === null ? "" : row.rating_delta >= 0 ? "delta-positive" : "delta-negative";

  return (
    <tr>
      <td class="nowrap">{formatDate(row.start_time_seconds)}</td>
      <td>
        <div class="contest-title-cell">
          <a class="problem-name" href={contestHref} rel="noreferrer" target="_blank">
            {row.contest_name}
          </a>
          {row.derived_label ? <span class="contest-label">{row.derived_label}</span> : null}
        </div>
      </td>
      <td class="num">{formatNumber(row.rank)}</td>
      <td class="num">{scoreText(row.points)}</td>
      <td class="num"><RatingValue value={row.new_rating} /></td>
      <td class={`num ${deltaClass}`}>{signedNumber(row.rating_delta)}</td>
      <td class="num"><RatingValue value={row.performance} /></td>
      <td>
        <div class="contest-problems">
          {row.problems.map((problem) => (
            <ProblemPill problem={problem} />
          ))}
        </div>
      </td>
    </tr>
  );
};

const SyncPanel = ({ latestSync, syncRunning }: ContestsPageOptions) => {
  const status = syncRunning
    ? "Sync running"
    : latestSync
      ? `${latestSync.status} sync${latestSync.finished_at ? ` finished ${new Date(latestSync.finished_at).toLocaleString()}` : ""}`
      : "No user sync yet";

  return (
    <aside class="sync-panel">
      <div>
        <span>{status}</span>
        {latestSync?.message ? <p>{latestSync.message}</p> : null}
      </div>
      <form method="post" action="/admin/sync">
        <input type="hidden" name="returnTo" value="/contests" />
        <button type="submit" disabled={syncRunning}>
          {syncRunning ? "Syncing" : "Sync"}
        </button>
      </form>
    </aside>
  );
};

export const contestsPage = (options: ContestsPageOptions): string => {
  return layout({
    title: "CFList Contests",
    user: options.user,
    body: (
      <>
        <section class="hero">
          <div>
            <h1>Codeforces Contests</h1>
            <p>{options.rows.length ? `${formatNumber(options.rows.length)} recent contests for ${options.user.cfHandle}` : `No synced contests for ${options.user.cfHandle}`}</p>
          </div>
          <SyncPanel {...options} />
        </section>
        <section class="table-wrap">
          <div class="table-head">
            <p>Contest history</p>
            <div class="contest-legend">
              <span><i class="contest-problem-pill contest-solved">A</i> solved</span>
              <span><i class="contest-problem-pill upsolved">B</i> upsolved</span>
              <span><i class="contest-problem-pill unsolved">C</i> unsolved</span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Contest</th>
                <th class="num">Rank</th>
                <th class="num">Score</th>
                <th class="num">Rating</th>
                <th class="num">Delta</th>
                <th class="num">Perf</th>
                <th>Problems</th>
              </tr>
            </thead>
            <tbody>
              {options.rows.length ? (
                options.rows.map((row) => <ContestRow row={row} />)
              ) : (
                <tr>
                  <td class="empty" colspan={8}>Run a sync to fetch recent contest history.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </>
    ),
  });
};
