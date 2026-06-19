import type { AuthUser } from "../../auth.js";
import type { FilterOptions, ListResult, ProblemFilters } from "../../db/queries.js";
import { defaultSortDirection } from "../../db/queries.js";

export type ProblemsPageOptions = {
  filters: ProblemFilters;
  options: FilterOptions;
  result: ListResult;
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  user: AuthUser;
};

export type PagerData = {
  totalPages: number;
  prev: string;
  next: string;
  returnTo: string;
};

export const problemListUrl = (filters: ProblemFilters, page: number): string => {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.minRating !== undefined) params.set("minRating", String(filters.minRating));
  if (filters.maxRating !== undefined) params.set("maxRating", String(filters.maxRating));
  for (const tag of filters.tags) params.append("tags", tag);
  if (filters.tagMode !== "any") params.set("tagMode", filters.tagMode);
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

export const problemListQuery = (filters: ProblemFilters): string => {
  const url = problemListUrl(filters, 1);
  return url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
};

export const fragmentUrl = (url: string, extra?: Record<string, string>): string => {
  const parsed = new URL(url, "http://cflist.local");
  parsed.pathname = "/problems/fragment";
  for (const [key, value] of Object.entries(extra ?? {})) {
    parsed.searchParams.set(key, value);
  }
  return `${parsed.pathname}${parsed.search}`;
};

export const pagerData = (filters: ProblemFilters, total: number): PagerData => {
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  return {
    totalPages,
    prev: filters.page > 1 ? problemListUrl(filters, filters.page - 1) : "",
    next: filters.page < totalPages ? problemListUrl(filters, filters.page + 1) : "",
    returnTo: problemListUrl(filters, filters.page),
  };
};

export const fragmentSwapAttrs = (href: string): Record<string, string> => ({
  "hx-get": fragmentUrl(href),
  "hx-target": "#problem-list",
  "hx-swap": "outerHTML",
  "hx-push-url": "true",
  "hx-indicator": "#problem-list",
});
