import type { Child } from "hono/jsx";
import { defaultSortDirection, type FilterOptions, type ListResult, type ProblemFilters, type ProblemRow } from "../db/queries.js";
import { formatDateTime, formatNumber } from "./html.js";
import { layout } from "./layout.js";

type ProblemsPageOptions = {
  filters: ProblemFilters;
  options: FilterOptions;
  result: ListResult;
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  adminTokenEnabled: boolean;
};

type PagerData = {
  totalPages: number;
  prev: string;
  next: string;
  returnTo: string;
};

const render = (content: Child): string => String(content);

const selected = (current: string | undefined, value: string): boolean => current === value;

const Option = (props: { value: string | number; label: string; selected?: boolean }) => {
  return (
    <option value={props.value} selected={props.selected}>
      {props.label}
    </option>
  );
};

export const problemListUrl = (filters: ProblemFilters, page: number): string => {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.minRating !== undefined) params.set("minRating", String(filters.minRating));
  if (filters.maxRating !== undefined) params.set("maxRating", String(filters.maxRating));
  for (const tag of filters.tags) params.append("tags", tag);
  if (filters.tagMode !== "all") params.set("tagMode", filters.tagMode);
  if (filters.contestFamily) params.set("contestFamily", filters.contestFamily);
  for (const division of filters.divisions) params.append("division", division);
  if (filters.solved !== "all") params.set("solved", filters.solved);
  if (filters.showTags) params.set("showTags", "1");
  if (filters.sort !== "contest") params.set("sort", filters.sort);
  if (filters.sortDirection !== defaultSortDirection(filters.sort)) params.set("sortDirection", filters.sortDirection);
  if (filters.pageSize !== 50) params.set("pageSize", String(filters.pageSize));
  if (page !== 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/problems?${query}` : "/problems";
};

const fragmentUrl = (url: string, extra?: Record<string, string>): string => {
  const parsed = new URL(url, "http://cflist.local");
  parsed.pathname = "/problems/fragment";
  for (const [key, value] of Object.entries(extra ?? {})) {
    parsed.searchParams.set(key, value);
  }
  return `${parsed.pathname}${parsed.search}`;
};

const pagerData = (filters: ProblemFilters, total: number): PagerData => {
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  return {
    totalPages,
    prev: filters.page > 1 ? problemListUrl(filters, filters.page - 1) : "",
    next: filters.page < totalPages ? problemListUrl(filters, filters.page + 1) : "",
    returnTo: problemListUrl(filters, filters.page),
  };
};

export const problemSummaryText = ({ result, filters }: ProblemsPageOptions): string => {
  return `${formatNumber(result.total)} matched, ${formatNumber(result.solved)} solved, ${formatNumber(result.unsolved)} unsolved for ${filters.handle}`;
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

const ratingTitle = (rating: number | null): { name: string; className: string } => {
  if (rating === null) return { name: "Unrated", className: "rank-unrated" };
  if (rating < 1200) return { name: "Newbie", className: "rank-newbie" };
  if (rating < 1400) return { name: "Pupil", className: "rank-pupil" };
  if (rating < 1600) return { name: "Specialist", className: "rank-specialist" };
  if (rating < 1900) return { name: "Expert", className: "rank-expert" };
  if (rating < 2100) return { name: "Candidate Master", className: "rank-candidate-master" };
  if (rating < 2300) return { name: "Master", className: "rank-master" };
  if (rating < 2400) return { name: "International Master", className: "rank-international-master" };
  if (rating < 2600) return { name: "Grandmaster", className: "rank-grandmaster" };
  if (rating < 3000) return { name: "International Grandmaster", className: "rank-international-grandmaster" };
  return { name: "Legendary Grandmaster", className: "rank-legendary-grandmaster" };
};

const StatusControl = (props: { row: ProblemRow; returnTo: string; adminTokenEnabled: boolean }) => {
  const { row, returnTo, adminTokenEnabled } = props;
  const action = `/problems/${row.contest_id}/${encodeURIComponent(row.problem_index)}/override`;

  if (adminTokenEnabled) {
    return <span class="status unsolved disabled-status" title="Manual status changes require admin access"></span>;
  }

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
      <input type="hidden" name="returnTo" value={returnTo} />
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

const ProblemRow = (props: {
  row: ProblemRow;
  showTags: boolean;
  returnTo: string;
  adminTokenEnabled: boolean;
}) => {
  const { row, showTags, returnTo, adminTokenEnabled } = props;
  const tags = tagsForRow(row);
  const problemId = `${row.contest_id}${row.problem_index}`;
  const title = ratingTitle(row.rating);

  return (
    <tr
      class={row.effective_solved ? "problem-row solved-row" : "problem-row"}
      data-problem-row
      data-contest-id={row.contest_id}
      data-problem-index={row.problem_index}
    >
      <td data-status-cell>
        <StatusControl row={row} returnTo={returnTo} adminTokenEnabled={adminTokenEnabled} />
      </td>
      <td class="mono">
        <a href={row.url} rel="noreferrer" target="_blank">
          {problemId}
        </a>
      </td>
      <td>
        <div class="problem-title-cell">
          <span class={`rank-dot ${title.className}`} title={title.name}></span>
          <a class="problem-name" href={row.url} rel="noreferrer" target="_blank">
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
      <td>{row.derived_label ?? row.contest_name ?? ""}</td>
      <td class="num">{formatNumber(row.solved_count)}</td>
    </tr>
  );
};

export const problemRow = (
  row: ProblemRow,
  options: { showTags: boolean; returnTo: string; adminTokenEnabled: boolean },
): string => render(<ProblemRow row={row} {...options} />);

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
        <noscript>
          <button type="submit">Apply</button>
        </noscript>
        <a
          class="button secondary"
          href="/problems"
          data-filter-reset
          hx-get="/problems/fragment"
          hx-params="none"
          hx-target="#problem-list"
          hx-swap="outerHTML"
          hx-push-url="/problems"
          hx-indicator="#problem-list"
        >
          Reset
        </a>
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
          <Option value="all" label="All tags" selected={filters.tagMode === "all"} />
          <Option value="any" label="Any tag" selected={filters.tagMode === "any"} />
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

const SyncPanel = (options: ProblemsPageOptions) => {
  const { latestSync, syncRunning, adminTokenEnabled } = options;
  const status = syncRunning
    ? "Sync running"
    : latestSync
      ? `${latestSync.status} ${latestSync.finished_at ? `at ${formatDateTime(latestSync.finished_at)}` : ""}`
      : "No sync yet";

  return (
    <section class="sync-panel">
      <div>
        <strong>{status}</strong>
        {latestSync?.message ? <p>{latestSync.message}</p> : ""}
      </div>
      <form method="post" action="/admin/sync">
        {adminTokenEnabled ? (
          <input type="password" name="adminToken" placeholder="admin token" autocomplete="current-password" />
        ) : (
          ""
        )}
        <button type="submit" disabled={syncRunning}>
          Refresh
        </button>
      </form>
    </section>
  );
};

const Pager = ({ prev, next, oob }: { prev: string; next: string; oob?: boolean }) => {
  return (
    <div class="pager" id="problem-pager" hx-swap-oob={oob ? "true" : undefined}>
      {prev ? (
        <a
          class="button secondary"
          href={prev}
          hx-get={fragmentUrl(prev)}
          hx-target="#problem-list"
          hx-swap="outerHTML"
          hx-push-url="true"
          hx-indicator="#problem-list"
        >
          Previous
        </a>
      ) : (
        <span class="button disabled">Previous</span>
      )}
      {next ? (
        <a
          class="button secondary"
          data-next-page
          href={next}
          hx-get={fragmentUrl(next)}
          hx-target="#problem-list"
          hx-swap="outerHTML"
          hx-push-url="true"
          hx-indicator="#problem-list"
        >
          Next
        </a>
      ) : (
        <span class="button disabled">Next</span>
      )}
    </div>
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

const ProblemRows = (props: ProblemsPageOptions & { pager: PagerData }) => {
  const { result, filters, adminTokenEnabled, pager } = props;

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
        <ProblemRow
          row={row}
          showTags={filters.showTags}
          returnTo={pager.returnTo}
          adminTokenEnabled={adminTokenEnabled}
        />
      ))}
    </>
  );
};

const rangeLabel = (filters: ProblemFilters, total: number, append = false): string => {
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
  const pager = pagerData(filters, result.total);

  return (
    <section
      id="problem-list"
      class="table-wrap"
      data-problem-list
      data-page={filters.page}
      data-page-size={filters.pageSize}
      data-total-pages={pager.totalPages}
      data-total={result.total}
      data-solved={result.solved}
      data-unsolved={result.unsolved}
      data-shown={result.rows.length}
      data-next-url={pager.next || undefined}
      data-summary={problemSummaryText(options)}
    >
      <div class="table-head">
        <span id="problem-page-label" data-page-label>
          {rangeLabel(filters, result.total)}
        </span>
        <Pager prev={pager.prev} next={pager.next} />
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
          <ProblemRows {...options} pager={pager} />
        </tbody>
      </table>
      <LoadMore next={pager.next} />
    </section>
  );
};

export const problemsListFragment = (options: ProblemsPageOptions): string => render(<ProblemsListFragment {...options} />);

export const problemsAppendFragment = (options: ProblemsPageOptions): string => {
  const { result, filters } = options;
  const pager = pagerData(filters, result.total);
  const rows = result.rows.map((row) => (
    <ProblemRow
      row={row}
      showTags={filters.showTags}
      returnTo={pager.returnTo}
      adminTokenEnabled={options.adminTokenEnabled}
    />
  ));

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
      <Pager prev={pager.prev} next={pager.next} oob />
      <p id="problem-summary" data-problem-summary hx-swap-oob="true">
        {problemSummaryText(options)}
      </p>
      <LoadMore next={pager.next} />
    </>,
  );
};

export const problemsPage = (options: ProblemsPageOptions): string => {
  return layout({
    title: "CFList Problems",
    body: (
      <>
        <section class="hero">
          <div>
            <h1>Codeforces Problems</h1>
            <p id="problem-summary" data-problem-summary>
              {problemSummaryText(options)}
            </p>
          </div>
        </section>
        <SyncPanel {...options} />
        <div class="workspace">
          <FilterForm {...options} />
          <ProblemsListFragment {...options} />
        </div>
      </>
    ),
  });
};
