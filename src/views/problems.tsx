import type { Child } from "hono/jsx";
import type { ProblemRow } from "../db/queries.js";
import { formatNumber } from "./html.js";
import { layout } from "./layout.js";
import { PageHero } from "./page-hero.js";
import { ratingTitle } from "./rating.js";
import { render } from "./render.js";
import { SyncPanel } from "./sync-panel.js";
import {
  fragmentUrl,
  pageNav,
  problemListUrl,
  type ProblemsPageOptions,
} from "./problems/url.js";

const selected = (current: string | undefined, value: string): boolean => current === value;

const Option = (props: { value: string | number; label: string; selected?: boolean }) => {
  return (
    <option value={props.value} selected={props.selected}>
      {props.label}
    </option>
  );
};

export { problemListQuery, problemListUrl } from "./problems/url.js";

export const problemSummaryText = ({ result, filters }: ProblemsPageOptions): string => {
  return `${formatNumber(result.total)} matched, ${formatNumber(result.solved)} solved, ${formatNumber(result.unsolved)} unsolved for ${filters.cfHandle}`;
};

export const problemSummaryOutOfBand = (options: ProblemsPageOptions): string => {
  return render(
    <p id="problem-summary" data-problem-summary hx-swap-oob="true">
      {problemSummaryText(options)}
    </p>,
  );
};

const tagsForRow = (row: ProblemRow): string[] => {
  try {
    const parsed = JSON.parse(row.tags_json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const sourceLabel = (row: ProblemRow): string => {
  if (row.solved_override === 1) return "local solved";
  if (row.cf_solved === 1) return "codeforces solved";
  return "unsolved";
};

const StatusControl = (props: { row: ProblemRow }) => {
  const { row } = props;
  const action = `/problems/${row.contest_id}/${encodeURIComponent(row.problem_index)}/override`;

  if (row.cf_solved === 1) {
    return (
      <span class="status solved api-solved" title={sourceLabel(row)}>
        ✓
      </span>
    );
  }

  const isManualSolved = row.solved_override === 1;
  return (
    <form class="status-form" method="post" action={action} hx-post={action} hx-target="#problem-list" hx-swap="outerHTML">
      <input type="hidden" name="solvedOverride" value={isManualSolved ? "" : "1"} />
      <button
        class={`status status-button ${isManualSolved ? "solved manual-solved" : "unsolved"}`}
        type="submit"
        title={isManualSolved ? "Undo manual solved mark" : "Mark solved"}
      >
        {isManualSolved ? "✓" : ""}
      </button>
    </form>
  );
};

const ProblemRow = (props: { row: ProblemRow; showTags: boolean }) => {
  const { row, showTags } = props;
  const tags = tagsForRow(row);
  const problemId = `${row.contest_id}${row.problem_index}`;
  const title = ratingTitle(row.rating);
  const problemHref = `https://codeforces.com/contest/${row.contest_id}/problem/${encodeURIComponent(row.problem_index)}`;

  return (
    <tr
      class={row.effective_solved ? "problem-row solved-row" : "problem-row"}
      data-problem-row
      data-contest-id={row.contest_id}
      data-problem-index={row.problem_index}
    >
      <td data-status-cell>
        <StatusControl row={row} />
      </td>
      <td class="mono">
        <a href={problemHref} rel="noreferrer" target="_blank">
          {problemId}
        </a>
      </td>
      <td>
        <div class="problem-title-cell">
          <span class={`rank-dot ${title.className}`} title={title.name}></span>
          <a class="problem-name" href={problemHref} rel="noreferrer" target="_blank">
            {row.name}
          </a>
        </div>
      </td>
      <td class="num">{row.rating ?? ""}</td>
      <td>
        {showTags ? (
          <div class="tags">
            {tags.map((tag) => (
              <span>{tag}</span>
            ))}
          </div>
        ) : (
          <span class="tags-hidden">Hidden</span>
        )}
      </td>
      <td>{row.contest_name ?? row.derived_label ?? ""}</td>
      <td class="num">{formatNumber(row.solved_count)}</td>
    </tr>
  );
};

const FilterForm = ({ filters, options }: ProblemsPageOptions) => {
  const minAvailableRating = options.ratings[0] ?? 800;
  const maxAvailableRating = options.ratings.at(-1) ?? 3500;
  const minRatingValue = filters.minRating ?? minAvailableRating;
  const maxRatingValue = filters.maxRating ?? maxAvailableRating;
  const ratingStep = 100;

  return (
    <form
      class="filters"
      method="get"
      action="/problems"
      hx-get="/problems/fragment"
      hx-target="#problem-list"
      hx-swap="outerHTML"
      hx-push-url="true"
      hx-indicator="#problem-list"
      hx-trigger="submit, change delay:100ms, input changed delay:300ms"
    >
      <div class="filter-actions filter-actions-top">
        <a
          class="button secondary"
          href="/problems?default=0"
        >
          Reset
        </a>
        <button
          class="button secondary"
          type="button"
          data-filter-save-default
        >
          Set default
        </button>
        <span class="filter-action-status" data-filter-default-status aria-live="polite"></span>
      </div>
      <label>
        Search
        <input type="search" name="q" value={filters.q ?? ""} placeholder="name or 1900A" />
      </label>
      <fieldset
        class="rating-filter"
        data-rating-filter
        data-min={minAvailableRating}
        data-max={maxAvailableRating}
        data-step={ratingStep}
      >
        <legend>Rating</legend>
        <div class="rating-values">
          <output data-rating-min-output>{filters.minRating === undefined ? "Any" : minRatingValue}</output>
          <span>to</span>
          <output data-rating-max-output>{filters.maxRating === undefined ? "Any" : maxRatingValue}</output>
        </div>
        <div class="range-stack">
          <input
            type="range"
            data-rating-min
            min={minAvailableRating}
            max={maxAvailableRating}
            step={ratingStep}
            value={minRatingValue}
          />
          <input
            type="range"
            data-rating-max
            min={minAvailableRating}
            max={maxAvailableRating}
            step={ratingStep}
            value={maxRatingValue}
          />
        </div>
        <input
          type="hidden"
          name="minRating"
          data-rating-min-hidden
          value={filters.minRating ?? ""}
          disabled={filters.minRating === undefined}
        />
        <input
          type="hidden"
          name="maxRating"
          data-rating-max-hidden
          value={filters.maxRating ?? ""}
          disabled={filters.maxRating === undefined}
        />
      </fieldset>
      <label>
        Contest
        <select name="contestFamily">
          <Option value="" label="Any" selected={!filters.contestFamily} />
          {options.contestFamilies.map((family) => (
            <Option value={family} label={family} selected={selected(filters.contestFamily, family)} />
          ))}
        </select>
      </label>
      <fieldset class="check-filter">
        <legend>Division</legend>
        <div class="check-list">
          {options.divisions.map((division) => (
            <label class="check-row">
              <input type="checkbox" name="division" value={division} checked={filters.divisions.includes(division)} />
              <span>{division}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Solved
        <select name="solved">
          <Option value="all" label="All" selected={filters.solved === "all"} />
          <Option value="solved" label="Solved" selected={filters.solved === "solved"} />
          <Option value="unsolved" label="Unsolved" selected={filters.solved === "unsolved"} />
        </select>
      </label>
      <label>
        Sort
        <select name="sort">
          <Option value="contest" label="Newest contest" selected={filters.sort === "contest"} />
          <Option value="rating" label="Rating" selected={filters.sort === "rating"} />
          <Option value="solvedCount" label="Solved count" selected={filters.sort === "solvedCount"} />
          <Option value="name" label="Name" selected={filters.sort === "name"} />
        </select>
      </label>
      <fieldset class="direction-filter">
        <legend>Direction</legend>
        <label class="direction-toggle">
          <input type="checkbox" name="sortDirection" value="asc" checked={filters.sortDirection === "asc"} />
          <span>{filters.sortDirection === "asc" ? "Ascending" : "Descending"}</span>
        </label>
        <input type="hidden" name="sortDirection" value="desc" />
      </fieldset>
      <label>
        Tag mode
        <select name="tagMode">
          <Option value="any" label="Any tag" selected={filters.tagMode === "any"} />
          <Option value="all" label="All tags" selected={filters.tagMode === "all"} />
        </select>
      </label>
      <label class="toggle-row">
        <input type="checkbox" name="showTags" value="1" checked={filters.showTags} />
        <span>Show tags in table</span>
      </label>
      <fieldset class="check-filter">
        <legend>Tags</legend>
        <div class="check-list tags-check-list">
          {options.tags.map((tag) => (
            <label class="check-row">
              <input type="checkbox" name="tags" value={tag} checked={filters.tags.includes(tag)} />
              <span>{tag}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Page size
        <select name="pageSize">
          {[25, 50, 100, 200].map((size) => (
            <Option value={size} label={String(size)} selected={filters.pageSize === size} />
          ))}
        </select>
      </label>
    </form>
  );
};

const SyncPanelAside = (options: ProblemsPageOptions) => <SyncPanel {...options.syncPanel} />;

const SyncPromptBanner = (options: ProblemsPageOptions) => {
  if (options.syncPanel.hasSuccessfulSync) return null;

  return (
    <section class="sync-prompt-banner" aria-label="Initial sync">
      <p>Sync your Codeforces account to load solved status and contest history.</p>
      <form
        method="post"
        action="/admin/sync"
        hx-post="/admin/sync"
        hx-target="[data-sync-panel]"
        hx-swap="outerHTML"
      >
        <input type="hidden" name="returnTo" value={problemListUrl(options.filters, options.filters.page)} />
        <input type="hidden" name="refreshPage" value="problems" />
        <button type="submit" class="button">Sync now</button>
      </form>
    </section>
  );
};

const LoadMore = ({ next }: { next: string }) => {
  return (
    <div
      id="load-more"
      class="load-more"
      data-load-more
      hidden={!next}
      hx-get={next ? fragmentUrl(next, { append: "1" }) : undefined}
      hx-trigger={next ? "revealed" : undefined}
      hx-target={next ? "this" : undefined}
      hx-swap={next ? "outerHTML" : undefined}
    >
      <span>Loading more problems...</span>
    </div>
  );
};

const ProblemRows = (props: ProblemsPageOptions) => {
  const { result, filters } = props;

  if (!result.rows.length) {
    return (
      <tr>
        <td colspan={7} class="empty">
          No problems match these filters.
        </td>
      </tr>
    );
  }

  return (
    <>
      {result.rows.map((row) => (
        <ProblemRow row={row} showTags={filters.showTags} />
      ))}
    </>
  );
};

const rangeLabel = (filters: ProblemsPageOptions["filters"], total: number, append = false): string => {
  if (total === 0) return "Showing 0 of 0";
  if (append) {
    const cumulativeEnd = Math.min(filters.page * filters.pageSize, total);
    return `Showing 1-${formatNumber(cumulativeEnd)} of ${formatNumber(total)}`;
  }
  const start = (filters.page - 1) * filters.pageSize + 1;
  const end = Math.min(filters.page * filters.pageSize, total);
  return `Showing ${formatNumber(start)}-${formatNumber(end)} of ${formatNumber(total)}`;
};

const ProblemsListFragment = (options: ProblemsPageOptions) => {
  const { result, filters } = options;
  const nav = pageNav(filters, result.total);

  return (
    <section id="problem-list" class="table-wrap">
      <div class="table-head">
        <span id="problem-page-label" data-page-label>
          {rangeLabel(filters, result.total)}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>ID</th>
            <th>Name</th>
            <th>Rating</th>
            <th>Tags</th>
            <th>Contest</th>
            <th>Solved</th>
          </tr>
        </thead>
        <tbody id="problem-rows" data-problem-rows>
          <ProblemRows {...options} />
        </tbody>
      </table>
      <LoadMore next={nav.next} />
    </section>
  );
};

export const problemsListFragment = (options: ProblemsPageOptions): string => render(<ProblemsListFragment {...options} />);

export const problemsAppendFragment = (options: ProblemsPageOptions): string => {
  const { result, filters } = options;
  const nav = pageNav(filters, result.total);
  const rows = result.rows.map((row) => <ProblemRow row={row} showTags={filters.showTags} />);

  return render(
    <>
      <template>
        <tbody id="problem-rows" hx-swap-oob="beforeend:#problem-rows">
          {rows}
        </tbody>
      </template>
      <span id="problem-page-label" data-page-label hx-swap-oob="true">
        {rangeLabel(filters, result.total, true)}
      </span>
      <p id="problem-summary" data-problem-summary hx-swap-oob="true">
        {problemSummaryText(options)}
      </p>
      <LoadMore next={nav.next} />
    </>,
  );
};

export const problemsPage = (options: ProblemsPageOptions): string => {
  return layout({
    title: "CFList Problems",
    user: options.user,
    activeNav: "problems",
    requiresJs: true,
    scripts: ["/public/filters.js"],
    body: (
      <>
        <PageHero
          title="Codeforces Problems"
          subtitle={<p id="problem-summary" data-problem-summary>{problemSummaryText(options)}</p>}
          aside={<SyncPanelAside {...options} />}
        />
        <SyncPromptBanner {...options} />
        <div class="workspace">
          <FilterForm {...options} />
          <ProblemsListFragment {...options} />
        </div>
      </>
    ),
  });
};
