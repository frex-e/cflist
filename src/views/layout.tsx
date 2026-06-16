import type { Child } from "hono/jsx";
import { raw } from "hono/html";

const render = (content: Child): string => String(content);

export const layout = (options: { title: string; body: Child | string }): string => {
  const body = typeof options.body === "string" ? raw(options.body) : options.body;

  return `<!doctype html>${render(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{options.title}</title>
        <link rel="stylesheet" href="/public/styles.css" />
        <script src="/public/htmx.min.js" defer></script>
        <script src="/public/filters.js" defer></script>
      </head>
      <body>
        <header class="topbar">
          <a class="brand" href="/problems">
            CFList
          </a>
          <nav class="topnav">
            <a href="/problems">Problems</a>
            <a href="https://codeforces.com/problemset" rel="noreferrer" target="_blank">
              Codeforces
            </a>
          </nav>
        </header>
        <main class="page">{body}</main>
      </body>
    </html>,
  )}`;
};
