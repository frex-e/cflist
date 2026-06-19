import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AuthUser } from "../auth.js";
import { render } from "./render.js";

type ActiveNav = "problems" | "contests" | "sign-in" | "sign-up";

export const layout = (options: {
  title: string;
  body: Child | string;
  user?: AuthUser;
  activeNav?: ActiveNav;
  scripts?: string[];
  requiresJs?: boolean;
}): string => {
  const body = typeof options.body === "string" ? raw(options.body) : options.body;
  const activeNav = options.activeNav;
  const scripts = [...(options.scripts ?? [])];
  if (options.user && !scripts.includes("/public/sync.js")) {
    scripts.push("/public/sync.js");
  }

  return `<!doctype html>${render(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{options.title}</title>
        <link rel="stylesheet" href="/public/styles.css" />
        <script src="/public/htmx.min.js" defer></script>
        {scripts.map((src) => <script src={src} defer></script>)}
      </head>
      <body>
        <header class="topbar">
          <a class="brand" href="/problems">
            CFList
          </a>
          <nav class="topnav">
            <a href="/problems" aria-current={activeNav === "problems" ? "page" : undefined}>
              Problems
            </a>
            <a href="/contests" aria-current={activeNav === "contests" ? "page" : undefined}>
              Contests
            </a>
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
                <a href="/sign-in" aria-current={activeNav === "sign-in" ? "page" : undefined}>
                  Sign in
                </a>
                <a href="/sign-up" aria-current={activeNav === "sign-up" ? "page" : undefined}>
                  Sign up
                </a>
              </>
            )}
          </nav>
        </header>
        <main class="page">
          {options.requiresJs ? (
            <noscript>
              <p class="noscript-banner">CFList requires JavaScript on this page.</p>
            </noscript>
          ) : null}
          {body}
        </main>
      </body>
    </html>,
  )}`;
};
