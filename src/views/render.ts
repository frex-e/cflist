import type { Child } from "hono/jsx";

export const render = (content: Child): string => String(content);
