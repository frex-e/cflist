import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AuthUser } from "../auth.js";

const render = (content: Child): string => String(content);

export const layout = (options: { title: string; body: Child | string; user?: AuthUser }): string => {
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
            <a href="/contests">Contests</a>
            <a href="https://codeforces.com/problemset" rel="noreferrer" target="_blank">
              Codeforces
            </a>
            {options.user ? (
              <form class="sign-out-form" method="post" action="/sign-out">
                <span>{options.user.cfHandle}</span>
                <button type="submit">Sign out</button>
              </form>
            ) : (
              <>
                <a href="/sign-in">Sign in</a>
                <a href="/sign-up">Sign up</a>
              </>
            )}
          </nav>
        </header>
        <main class="page">{body}</main>
      </body>
    </html>,
  )}`;
};
