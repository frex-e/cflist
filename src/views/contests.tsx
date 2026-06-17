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

type ChartMetric = "new_rating" | "performance";

type ChartPoint = {
  row: ContestResultRow;
  timeSeconds: number;
  value: number;
};

type RatingBand = {
  name: string;
  min: number;
  max: number;
  className: string;
};

type ChartScale = {
  yMin: number;
  yMax: number;
};

const ratingBands: RatingBand[] = [
  { name: "Newbie", min: 0, max: 1200, className: "chart-band-newbie" },
  { name: "Pupil", min: 1200, max: 1400, className: "chart-band-pupil" },
  { name: "Specialist", min: 1400, max: 1600, className: "chart-band-specialist" },
  { name: "Expert", min: 1600, max: 1900, className: "chart-band-expert" },
  { name: "Candidate Master", min: 1900, max: 2100, className: "chart-band-candidate-master" },
  { name: "Master", min: 2100, max: 2300, className: "chart-band-master" },
  { name: "International Master", min: 2300, max: 2400, className: "chart-band-international-master" },
  { name: "Grandmaster", min: 2400, max: 2600, className: "chart-band-grandmaster" },
  { name: "International Grandmaster", min: 2600, max: 3000, className: "chart-band-international-grandmaster" },
  { name: "Legendary Grandmaster", min: 3000, max: 4000, className: "chart-band-legendary-grandmaster" },
];

const chartThresholds = [1200, 1400, 1600, 1900, 2100, 2300, 2400, 2600, 3000];

const chartValue = (row: ContestResultRow, metric: ChartMetric): number | null => row[metric];

const chartValues = (rows: ContestResultRow[], metric: ChartMetric): number[] => {
  return rows
    .map((row) => chartValue(row, metric))
    .filter((value): value is number => value !== null);
};

const chartScale = (rows: ContestResultRow[]): ChartScale => {
  const values = [...chartValues(rows, "new_rating"), ...chartValues(rows, "performance")];
  const maxValue = Math.max(...values, 1600);
  const minValue = Math.min(...values, 1200);

  return {
    yMin: Math.max(0, Math.floor((minValue - 160) / 100) * 100),
    yMax: Math.min(4000, Math.max(1600, Math.ceil((maxValue + 180) / 100) * 100)),
  };
};

const chartTitle = (row: ContestResultRow, value: number, label: string): string => {
  const date = formatDate(row.start_time_seconds);
  const prefix = date ? `${date} - ` : "";
  return `${prefix}${row.contest_name}: ${label} ${formatNumber(value)}`;
};

const yearTicks = (
  minTimeSeconds: number,
  maxTimeSeconds: number,
  xForTime: (timeSeconds: number) => number,
): { year: number; x: number }[] => {
  const ticks: { year: number; x: number }[] = [];
  const minYear = new Date(minTimeSeconds * 1000).getUTCFullYear();
  const maxYear = new Date(maxTimeSeconds * 1000).getUTCFullYear();

  for (let year = minYear; year <= maxYear; year += 1) {
    const timeSeconds = Date.UTC(year, 0, 1) / 1000;
    if (timeSeconds < minTimeSeconds || timeSeconds > maxTimeSeconds) continue;
    ticks.push({ year, x: xForTime(timeSeconds) });
  }

  return ticks;
};

const RatingChart = ({ rows, metric, scale, title }: { rows: ContestResultRow[]; metric: ChartMetric; scale: ChartScale; title: string }) => {
  const points = rows
    .slice()
    .reverse()
    .map((row) => {
      const value = chartValue(row, metric);
      if (value === null || row.start_time_seconds === null) return null;
      return { row, timeSeconds: row.start_time_seconds, value };
    })
    .filter((point): point is ChartPoint => point !== null);

  if (points.length < 2) {
    return (
      <section class="rating-chart-panel">
        <div class="rating-chart-head">
          <h2>{title}</h2>
          <p>Need at least two synced rated contests.</p>
        </div>
        <div class="rating-chart-empty">No chart data yet</div>
      </section>
    );
  }

  const width = 960;
  const height = 280;
  const margin = { top: 18, right: 18, bottom: 34, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const { yMin, yMax } = scale;
  const minTimeSeconds = Math.min(...points.map((point) => point.timeSeconds));
  const maxTimeSeconds = Math.max(...points.map((point) => point.timeSeconds));
  const timeRangeSeconds = Math.max(1, maxTimeSeconds - minTimeSeconds);
  const xForTime = (timeSeconds: number): number => margin.left + ((timeSeconds - minTimeSeconds) / timeRangeSeconds) * plotWidth;
  const yForValue = (value: number): number => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
  const linePoints = points.map((point) => `${xForTime(point.timeSeconds).toFixed(1)},${yForValue(point.value).toFixed(1)}`).join(" ");
  const yTicks = chartThresholds.filter((value) => value > yMin && value < yMax);
  const xTicks = yearTicks(minTimeSeconds, maxTimeSeconds, xForTime);

  return (
    <section class="rating-chart-panel">
      <div class="rating-chart-head">
        <h2>{title}</h2>
        <p>{formatNumber(points.length)} rated contests</p>
      </div>
      <svg class="rating-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        {ratingBands.map((band) => {
          const bandMin = Math.max(band.min, yMin);
          const bandMax = Math.min(band.max, yMax);
          if (bandMax <= yMin || bandMin >= yMax || bandMax <= bandMin) return null;
          const y = yForValue(bandMax);
          const bandHeight = yForValue(bandMin) - y;
          return <rect class={band.className} x={margin.left} y={y} width={plotWidth} height={bandHeight} />;
        })}
        <line class="chart-axis" x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + plotHeight} />
        <line class="chart-axis" x1={margin.left} y1={margin.top + plotHeight} x2={margin.left + plotWidth} y2={margin.top + plotHeight} />
        {yTicks.map((value) => {
          const y = yForValue(value);
          return (
            <g>
              <line class="chart-grid" x1={margin.left} y1={y} x2={margin.left + plotWidth} y2={y} />
              <text class="chart-y-label" x={margin.left - 8} y={y + 4} text-anchor="end">{formatNumber(value)}</text>
            </g>
          );
        })}
        {xTicks.map((tick) => (
          <g>
            <line class="chart-grid chart-grid-vertical" x1={tick.x} y1={margin.top} x2={tick.x} y2={margin.top + plotHeight} />
            <text class="chart-x-label" x={tick.x} y={height - 10} text-anchor="middle">{tick.year}</text>
          </g>
        ))}
        <polyline class="chart-line" points={linePoints} />
        {points.map((point) => (
          <circle class="chart-point" cx={xForTime(point.timeSeconds)} cy={yForValue(point.value)} r="4.2">
            <title>{chartTitle(point.row, point.value, title)}</title>
          </circle>
        ))}
      </svg>
    </section>
  );
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
          {row.problems.length
            ? row.problems.map((problem) => (
                <ProblemPill problem={problem} />
              ))
            : <span class="muted">Details pending</span>}
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
  const scale = chartScale(options.rows);

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
        <section class="rating-charts">
          <RatingChart rows={options.rows} metric="new_rating" scale={scale} title="Rating" />
          <RatingChart rows={options.rows} metric="performance" scale={scale} title="Performance" />
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
