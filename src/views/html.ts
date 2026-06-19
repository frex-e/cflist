export const formatNumber = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "";
  return new Intl.NumberFormat("en").format(value);
};

export const formatDateTime = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
};

export const formatDateFromSeconds = (value: number | null): string => {
  if (value === null) return "";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

