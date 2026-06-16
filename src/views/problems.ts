import type { FilterOptions, ListResult, ProblemFilters, ProblemRow } from "../db/queries.js";
import { attrs, escapeHtml, formatDateTime, formatNumber } from "./html.js";
import { layout } from "./layout.js";

type ProblemsPageOptions = {
  filters: ProblemFilters;
  options: FilterOptions;
  result: ListResult;
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  adminTokenEnabled: boolean;
};

const selected = (current: string | undefined, value: string): boolean => current === value;

const option = (value: string | number, label: string, isSelected = false): string => {
  return `<option ${attrs({ value, selected: isSelected })}>${escapeHtml(label)}</option>`;
};

const buildUrl = (filters: ProblemFilters, page: number): string => {
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
  if (filters.pageSize !== 50) params.set("pageSize", String(filters.pageSize));
  if (page !== 1) params.set("page", String(page));
  return `/problems?${params.toString()}`;
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

const rowStatusControl = (row: ProblemRow, returnTo: string, adminTokenEnabled: boolean): string => {
  const title = escapeHtml(sourceLabel(row));
  const action = `/problems/${row.contest_id}/${encodeURIComponent(row.problem_index)}/override`;

  if (adminTokenEnabled) {
    return `<span class="status unsolved disabled-status" title="Open detail to change manual status"></span>`;
  }

  if (row.cf_solved === 1) {
    return `<span class="status solved api-solved" title="${title}">✓</span>`;
  }

  if (row.solved_override === 1) {
    return `<form class="status-form" data-status-form method="post" action="${action}">
      <input type="hidden" name="solvedOverride" value="">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <button class="status status-button solved manual-solved" type="submit" title="Undo manual solved mark">✓</button>
    </form>`;
  }

  return `<form class="status-form" data-status-form method="post" action="${action}">
    <input type="hidden" name="solvedOverride" value="1">
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
    <button class="status status-button unsolved" type="submit" title="Mark solved"></button>
  </form>`;
};

const problemRow = (
  row: ProblemRow,
  options: { showTags: boolean; returnTo: string; adminTokenEnabled: boolean },
): string => {
  const tags = tagsForRow(row);
  const problemId = `${row.contest_id}${row.problem_index}`;
  const title = ratingTitle(row.rating);
  const rowClass = row.effective_solved ? "problem-row solved-row" : "problem-row";

  return `<tr class="${rowClass}" data-problem-row data-contest-id="${row.contest_id}" data-problem-index="${escapeHtml(row.problem_index)}">
    <td data-status-cell>${rowStatusControl(row, options.returnTo, options.adminTokenEnabled)}</td>
    <td class="mono"><a href="/problems/${row.contest_id}/${encodeURIComponent(row.problem_index)}">${escapeHtml(problemId)}</a></td>
    <td><div class="problem-title-cell"><span class="rank-dot ${title.className}" title="${escapeHtml(title.name)}"></span><a class="problem-name" href="/problems/${row.contest_id}/${encodeURIComponent(row.problem_index)}">${escapeHtml(row.name)}</a></div></td>
    <td class="num">${row.rating ?? ""}</td>
    <td>${options.showTags ? `<div class="tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : '<span class="tags-hidden">Hidden</span>'}</td>
    <td>${escapeHtml(row.derived_label ?? row.contest_name ?? "")}</td>
    <td class="num">${formatNumber(row.solved_count)}</td>
  </tr>`;
};

const filterForm = ({ filters, options }: ProblemsPageOptions): string => {
  const minAvailableRating = options.ratings[0] ?? 800;
  const maxAvailableRating = options.ratings.at(-1) ?? 3500;
  const minRatingValue = filters.minRating ?? minAvailableRating;
  const maxRatingValue = filters.maxRating ?? maxAvailableRating;
  const ratingStep = 100;

  return `<form class="filters" method="get" action="/problems">
    <div class="filter-actions filter-actions-top">
      <button type="submit">Apply</button>
      <a class="button secondary" href="/problems">Reset</a>
    </div>
    <label>
      Search
      <input type="search" name="q" value="${escapeHtml(filters.q ?? "")}" placeholder="name or 1900A">
    </label>
    <fieldset
      class="rating-filter"
      data-rating-filter
      data-min="${minAvailableRating}"
      data-max="${maxAvailableRating}"
      data-step="${ratingStep}"
    >
      <legend>Rating</legend>
      <div class="rating-values">
        <output data-rating-min-output>${filters.minRating === undefined ? "Any" : minRatingValue}</output>
        <span>to</span>
        <output data-rating-max-output>${filters.maxRating === undefined ? "Any" : maxRatingValue}</output>
      </div>
      <div class="range-stack">
        <input type="range" data-rating-min min="${minAvailableRating}" max="${maxAvailableRating}" step="${ratingStep}" value="${minRatingValue}">
        <input type="range" data-rating-max min="${minAvailableRating}" max="${maxAvailableRating}" step="${ratingStep}" value="${maxRatingValue}">
      </div>
      <input type="hidden" name="minRating" data-rating-min-hidden value="${filters.minRating ?? ""}" ${filters.minRating === undefined ? "disabled" : ""}>
      <input type="hidden" name="maxRating" data-rating-max-hidden value="${filters.maxRating ?? ""}" ${filters.maxRating === undefined ? "disabled" : ""}>
    </fieldset>
    <label>
      Contest
      <select name="contestFamily">
        ${option("", "Any", !filters.contestFamily)}
        ${options.contestFamilies.map((family) => option(family, family, selected(filters.contestFamily, family))).join("")}
      </select>
    </label>
    <fieldset class="check-filter">
      <legend>Division</legend>
      <div class="check-list">
        ${options.divisions
          .map(
            (division) => `<label class="check-row">
              <input type="checkbox" name="division" value="${escapeHtml(division)}" ${filters.divisions.includes(division) ? "checked" : ""}>
              <span>${escapeHtml(division)}</span>
            </label>`,
          )
          .join("")}
      </div>
    </fieldset>
    <label>
      Solved
      <select name="solved">
        ${option("all", "All", filters.solved === "all")}
        ${option("solved", "Solved", filters.solved === "solved")}
        ${option("unsolved", "Unsolved", filters.solved === "unsolved")}
      </select>
    </label>
    <label>
      Sort
      <select name="sort">
        ${option("contest", "Newest contest", filters.sort === "contest")}
        ${option("rating", "Rating", filters.sort === "rating")}
        ${option("solvedCount", "Solved count", filters.sort === "solvedCount")}
        ${option("name", "Name", filters.sort === "name")}
      </select>
    </label>
    <label>
      Tag mode
      <select name="tagMode">
        ${option("all", "All tags", filters.tagMode === "all")}
        ${option("any", "Any tag", filters.tagMode === "any")}
      </select>
    </label>
    <label class="toggle-row">
      <input type="checkbox" name="showTags" value="1" ${filters.showTags ? "checked" : ""}>
      <span>Show tags in table</span>
    </label>
    <fieldset class="check-filter">
      <legend>Tags</legend>
      <div class="check-list tags-check-list">
        ${options.tags
          .map(
            (tag) => `<label class="check-row">
              <input type="checkbox" name="tags" value="${escapeHtml(tag)}" ${filters.tags.includes(tag) ? "checked" : ""}>
              <span>${escapeHtml(tag)}</span>
            </label>`,
          )
          .join("")}
      </div>
    </fieldset>
    <label>
      Page size
      <select name="pageSize">
        ${[25, 50, 100, 200].map((size) => option(size, String(size), filters.pageSize === size)).join("")}
      </select>
    </label>
  </form>`;
};

const syncPanel = (options: ProblemsPageOptions): string => {
  const { latestSync, syncRunning, adminTokenEnabled } = options;
  const status = syncRunning
    ? "Sync running"
    : latestSync
      ? `${latestSync.status} ${latestSync.finished_at ? `at ${formatDateTime(latestSync.finished_at)}` : ""}`
      : "No sync yet";

  return `<section class="sync-panel">
    <div>
      <strong>${escapeHtml(status)}</strong>
      ${latestSync?.message ? `<p>${escapeHtml(latestSync.message)}</p>` : ""}
    </div>
    <form method="post" action="/admin/sync">
      ${adminTokenEnabled ? '<input type="password" name="adminToken" placeholder="admin token" autocomplete="current-password">' : ""}
      <button type="submit" ${syncRunning ? "disabled" : ""}>Refresh</button>
    </form>
  </section>`;
};

export const problemsPage = (options: ProblemsPageOptions): string => {
  const { result, filters } = options;
  const totalPages = Math.max(1, Math.ceil(result.total / filters.pageSize));
  const prev = filters.page > 1 ? buildUrl(filters, filters.page - 1) : "";
  const next = filters.page < totalPages ? buildUrl(filters, filters.page + 1) : "";
  const returnTo = buildUrl(filters, filters.page);

  const body = `
    <section class="hero">
      <div>
        <h1>Codeforces Problems</h1>
        <p>${formatNumber(result.total)} matched, ${formatNumber(result.solved)} solved, ${formatNumber(result.unsolved)} unsolved for ${escapeHtml(filters.handle)}</p>
      </div>
    </section>
    ${syncPanel(options)}
    <div class="workspace">
      ${filterForm(options)}
      <section class="table-wrap">
        <div class="table-head">
          <span>Page ${formatNumber(filters.page)} of ${formatNumber(totalPages)}</span>
          <div class="pager">
            ${prev ? `<a class="button secondary" href="${escapeHtml(prev)}">Previous</a>` : '<span class="button disabled">Previous</span>'}
            ${next ? `<a class="button secondary" href="${escapeHtml(next)}">Next</a>` : '<span class="button disabled">Next</span>'}
          </div>
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
          <tbody>
            ${
              result.rows.length
                ? result.rows
                    .map((row) =>
                      problemRow(row, {
                        showTags: filters.showTags,
                        returnTo,
                        adminTokenEnabled: options.adminTokenEnabled,
                      }),
                    )
                    .join("")
                : '<tr><td colspan="7" class="empty">No problems match these filters.</td></tr>'
            }
          </tbody>
        </table>
      </section>
    </div>`;

  return layout({ title: "CFList Problems", body });
};
