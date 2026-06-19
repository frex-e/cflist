export const fragmentUrl = (
  fragmentPath: string,
  listUrl: string,
  extra?: Record<string, string>,
): string => {
  const parsed = new URL(listUrl, "http://cflist.local");
  parsed.pathname = fragmentPath;
  for (const [key, value] of Object.entries(extra ?? {})) {
    parsed.searchParams.set(key, value);
  }
  return `${parsed.pathname}${parsed.search}`;
};
