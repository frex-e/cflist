import type { AuthUser } from "../auth.js";
import type { ContestListResult, ContestProblemResultRow, ContestResultRow } from "../db/queries.js";
import { formatDateFromSeconds, formatNumber } from "./html.js";
import { layout } from "./layout.js";
import { LoadMore } from "./load-more.js";
import { PageHero } from "./page-hero.js";
import { rangeLabel } from "./pagination.js";
import { CHART_THRESHOLDS, chartBands, ratingTitle } from "./rating.js";
import { render } from "./render.js";
import { SyncPanel, type SyncPanelOptions } from "./sync-panel.js";
import {
  chartScale,
  chartValue,
  type ChartMetric,
  type ChartPoint,
  xForTime,
  yForValue,
  yearTicks,
} from "./contests/chart.js";
import { type ContestTableFilters } from "./contests/filters.js";
import { contestPageNav } from "./contests/url.js";

export type ContestsPageOptions = {
  chartRows: ContestResultRow[];
  syncedCount: number;
  tableResult: ContestListResult;
  filters: ContestTableFilters;
  syncPanel: SyncPanelOptions;
  user: AuthUser;
};

const signedNumber = (value: number | null): string => {
  if (value === null) return "";
  return value > 0 ? `+${value}` : String(value);
};

const scoreText = (value: number | null): string => {
  if (value === null) return "";
  return Number.isInteger(value) ? formatNumber(value) : value.toFixed(2);
};

const chartTitle = (row: ContestResultRow, value: number, label: string): string => {
  const date = formatDateFromSeconds(row.start_time_seconds);
  const prefix = date ? `${date} - ` : "";
  return `${prefix}${row.contest_name}: ${label} ${formatNumber(value)}`;
};

const RatingChart = ({ rows, metric, scale, title }: { rows: ContestResultRow[]; metric: ChartMetric; scale: ReturnType<typeof chartScale>; title: string }) => {
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
  const xAt = (timeSeconds: number): number => xForTime(timeSeconds, minTimeSeconds, timeRangeSeconds, margin.left, plotWidth);
  const yAt = (value: number): number => yForValue(value, yMin, yMax, margin.top, plotHeight);
  const linePoints = points.map((point) => `${xAt(point.timeSeconds).toFixed(1)},${yAt(point.value).toFixed(1)}`).join(" ");
  const yTicks = CHART_THRESHOLDS.filter((value) => value > yMin && value < yMax);
  const xTicks = yearTicks(minTimeSeconds, maxTimeSeconds, xAt);
  const bands = chartBands();

  return (
    <section class="rating-chart-panel">
      <div class="rating-chart-head">
        <h2>{title}</h2>
        <p>{formatNumber(points.length)} rated contests</p>
      </div>
      <svg class="rating-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        {bands.map((band) => {
          const bandMin = Math.max(band.min, yMin);
          const bandMax = Math.min(band.max, yMax);
          if (bandMax <= yMin || bandMin >= yMax || bandMax <= bandMin) return null;
          const y = yAt(bandMax);
          const bandHeight = yAt(bandMin) - y;
          return <rect class={band.chartClass} x={margin.left} y={y} width={plotWidth} height={bandHeight} />;
        })}
        <line class="chart-axis" x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + plotHeight} />
        <line class="chart-axis" x1={margin.left} y1={margin.top + plotHeight} x2={margin.left + plotWidth} y2={margin.top + plotHeight} />
        {yTicks.map((value) => {
          const y = yAt(value);
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
          <circle class="chart-point" cx={xAt(point.timeSeconds)} cy={yAt(point.value)} r="4.2">
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

const ProblemPillsCell = ({ row }: { row: ContestResultRow }) => {
  if (row.problems.length) {
    return (
      <div class="contest-problems">
        {row.problems.map((problem) => (
          <ProblemPill problem={problem} />
        ))}
      </div>
    );
  }

  if (row.hydration_status === "queued" || row.hydration_status === "running") {
    return <span class="muted">Loading…</span>;
  }

  if (row.hydration_status === "failed") {
    return (
      <span class="muted contest-hydration-error" title={row.hydration_error ?? undefined}>
        Could not load
      </span>
    );
  }

  return <span class="muted">Details pending</span>;
};

const ContestRow = ({ row }: { row: ContestResultRow }) => {
  const contestHref = `https://codeforces.com/contest/${row.contest_id}`;
  const deltaClass = row.rating_delta === null ? "" : row.rating_delta >= 0 ? "delta-positive" : "delta-negative";

  return (
    <tr>
      <td class="nowrap">{formatDateFromSeconds(row.start_time_seconds)}</td>
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
        <ProblemPillsCell row={row} />
      </td>
    </tr>
  );
};

const ContestsTableBody = ({
  rows,
  filters,
  hasSyncedContests,
}: {
  rows: ContestResultRow[];
  filters: ContestTableFilters;
  hasSyncedContests: boolean;
}) => {
  if (!rows.length) {
    const message = hasSyncedContests && filters.show !== "all"
      ? "No contests match the current filter."
      : "Run a sync to fetch recent contest history.";

    return (
      <tr>
        <td class="empty" colspan={8}>{message}</td>
      </tr>
    );
  }

  return <>{rows.map((row) => <ContestRow row={row} />)}</>;
};

const CONTEST_SHOW_OPTIONS: { mode: ContestTableFilters["show"]; label: string; title: string }[] = [
  { mode: "all", label: "All", title: "Show every synced contest" },
  { mode: "participated", label: "Participated", title: "Hide upsolve-only contests" },
  { mode: "rated", label: "Rated", title: "Show only contests that changed your rating" },
];

const ContestFilterButtons = ({ filters }: { filters: ContestTableFilters }) => (
  <div class="contest-filters" role="group" aria-label="Contest table filter">
    <div class="contest-filter-group">
      {CONTEST_SHOW_OPTIONS.map((option) => (
        <button
          type="button"
          class="button secondary contest-filter-btn"
          data-contest-show={option.mode}
          aria-pressed={filters.show === option.mode ? "true" : "false"}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

const ContestsTableSection = ({ options }: { options: ContestsPageOptions }) => {
  const { tableResult, filters, syncedCount } = options;
  const nav = contestPageNav(filters, tableResult.total);

  return (
    <section id="contests-table" class="table-wrap" data-contests-table>
      <div class="table-head table-head-contests">
        <div class="table-head-left">
          <p class="table-head-title">Contest history</p>
          <span id="contest-page-label" class="table-head-meta" data-page-label>
            {rangeLabel(filters.page, filters.pageSize, tableResult.total)}
          </span>
        </div>
        <ContestFilterButtons filters={filters} />
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
        <tbody id="contest-rows" data-contest-rows>
          <ContestsTableBody
            rows={tableResult.rows}
            filters={filters}
            hasSyncedContests={syncedCount > 0}
          />
        </tbody>
      </table>
      <LoadMore next={nav.next} fragmentPath="/contests/fragment" label="Loading more contests..." />
    </section>
  );
};

export const contestsTableFragment = (options: ContestsPageOptions): string =>
  render(<ContestsTableSection options={options} />);

export const contestsAppendFragment = (options: ContestsPageOptions): string => {
  const { tableResult, filters } = options;
  const nav = contestPageNav(filters, tableResult.total);
  const rows = tableResult.rows.map((row) => <ContestRow row={row} />);

  return render(
    <>
      <template>
        <tbody id="contest-rows" hx-swap-oob="beforeend:#contest-rows">
          {rows}
        </tbody>
      </template>
      <span id="contest-page-label" data-page-label hx-swap-oob="true">
        {rangeLabel(filters.page, filters.pageSize, tableResult.total, true)}
      </span>
      <LoadMore next={nav.next} fragmentPath="/contests/fragment" label="Loading more contests..." />
    </>,
  );
};

export const contestsPage = (options: ContestsPageOptions): string => {
  const scale = chartScale(options.chartRows);
  const ratedCount = options.chartRows.length;
  const subtitle = options.syncedCount
    ? ratedCount
      ? `${formatNumber(options.syncedCount)} synced contests (${formatNumber(ratedCount)} rated) for ${options.user.cfHandle}`
      : `${formatNumber(options.syncedCount)} synced contests for ${options.user.cfHandle}`
    : `No synced contests for ${options.user.cfHandle}`;

  return layout({
    title: "CFList Contests",
    user: options.user,
    activeNav: "contests",
    requiresJs: true,
    scripts: ["/public/contests.js"],
    body: (
      <>
        <PageHero
          title="Codeforces Contests"
          subtitle={<p>{subtitle}</p>}
          aside={<SyncPanel {...options.syncPanel} />}
        />
        <section class="rating-charts">
          <RatingChart rows={options.chartRows} metric="new_rating" scale={scale} title="Rating" />
          <RatingChart rows={options.chartRows} metric="performance" scale={scale} title="Performance" />
        </section>
        <ContestsTableSection options={options} />
      </>
    ),
  });
};
