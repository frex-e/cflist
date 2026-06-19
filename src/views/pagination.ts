import { formatNumber } from "./html.js";

export type PageNav = {
  next: string;
};

export const pageNav = (page: number, pageSize: number, total: number, nextListUrl: string): PageNav => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    next: page < totalPages ? nextListUrl : "",
  };
};

export const rangeLabel = (page: number, pageSize: number, total: number, append = false): string => {
  if (total === 0) return "Showing 0 of 0";
  if (append) {
    const cumulativeEnd = Math.min(page * pageSize, total);
    return `Showing 1-${formatNumber(cumulativeEnd)} of ${formatNumber(total)}`;
  }
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `Showing ${formatNumber(start)}-${formatNumber(end)} of ${formatNumber(total)}`;
};
