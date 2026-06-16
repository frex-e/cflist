import { escapeHtml } from "./html.js";

export const layout = (options: { title: string; body: string }): string => {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
    <link rel="stylesheet" href="/public/styles.css">
    <script src="/public/filters.js" defer></script>
  </head>
  <body>
    <header class="topbar">
      <a class="brand" href="/problems">CFList</a>
      <nav class="topnav">
        <a href="/problems">Problems</a>
        <a href="https://codeforces.com/problemset" rel="noreferrer" target="_blank">Codeforces</a>
      </nav>
    </header>
    <main class="page">
      ${options.body}
    </main>
  </body>
</html>`;
};
