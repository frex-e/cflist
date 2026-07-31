export type LocalStatusView = "unsolved" | "skipped" | "solved";
export type SolvedFilter = "all" | "solved" | "unsolved" | "skipped";

export const readLocalStatusView = (input: {
  solved_override?: number | null;
  skipped?: number | null;
}): LocalStatusView => {
  if (input.solved_override === 1) return "solved";
  if (input.skipped === 1) return "skipped";
  return "unsolved";
};

/** Hidden form value posted to advance from the current local status. */
export const nextLocalStatusValue = (current: LocalStatusView): "" | "skipped" | "solved" => {
  if (current === "solved") return "";
  if (current === "skipped") return "solved";
  return "skipped";
};

/** Status after applying a posted localStatus form value. */
export const statusAfterOverride = (posted: string): LocalStatusView => {
  if (posted === "skipped") return "skipped";
  if (posted === "solved") return "solved";
  return "unsolved";
};

export const statusMatchesSolvedFilter = (
  filter: SolvedFilter | string | null | undefined,
  status: LocalStatusView,
): boolean => {
  if (!filter || filter === "all") return true;
  if (filter === "solved") return status === "solved";
  if (filter === "skipped") return status === "skipped";
  if (filter === "unsolved") return status === "unsolved";
  return true;
};

export type SummaryCounts = {
  total: number;
  solved: number;
  skipped: number;
  unsolved: number;
};

const bump = (counts: SummaryCounts, status: LocalStatusView, delta: number): void => {
  if (status === "solved") counts.solved += delta;
  else if (status === "skipped") counts.skipped += delta;
  else counts.unsolved += delta;
};

/** Adjust matched/solved/skipped/unsolved after a local status change. */
export const adjustSummaryCounts = (
  counts: SummaryCounts,
  from: LocalStatusView,
  to: LocalStatusView,
  filter: SolvedFilter | string | null | undefined,
): SummaryCounts => {
  const next = { ...counts };
  const staysVisible = statusMatchesSolvedFilter(filter, to);

  bump(next, from, -1);
  if (staysVisible) {
    bump(next, to, 1);
  } else {
    next.total -= 1;
  }

  return next;
};

export const formatSummaryCounts = (
  counts: SummaryCounts,
  cfHandle: string,
  formatNumber: (value: number) => string,
): string =>
  `${formatNumber(counts.total)} matched, ${formatNumber(counts.solved)} solved, ${formatNumber(counts.skipped)} skipped, ${formatNumber(counts.unsolved)} unsolved for ${cfHandle}`;

export const parseSummaryText = (
  text: string,
): { counts: SummaryCounts; cfHandle: string } | null => {
  const match = text
    .trim()
    .match(
      /^([\d,]+)\s+matched,\s+([\d,]+)\s+solved,\s+([\d,]+)\s+skipped,\s+([\d,]+)\s+unsolved for\s+(.+)$/,
    );
  if (!match) return null;

  const parseCount = (value: string): number => Number(value.replace(/,/g, ""));
  return {
    counts: {
      total: parseCount(match[1]!),
      solved: parseCount(match[2]!),
      skipped: parseCount(match[3]!),
      unsolved: parseCount(match[4]!),
    },
    cfHandle: match[5]!,
  };
};
