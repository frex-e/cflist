import type { Context } from "hono";

const pathFromUrl = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    const path = `${parsed.pathname}${parsed.search}`;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
    return path;
  } catch {
    return undefined;
  }
};

export const currentPageFromRequest = (c: Context, fallback = "/problems"): string => {
  for (const source of [c.req.header("hx-current-url"), c.req.header("referer")]) {
    const path = source ? pathFromUrl(source) : undefined;
    if (path) return path;
  }
  return fallback;
};
