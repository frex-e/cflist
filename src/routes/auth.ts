import type { Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import { needsCfHandle } from "../auth.js";
import { safeReturnToWithDefault } from "../http/return-to.js";
import { firstString, formToBody } from "../http/forms.js";
import { signInPage, signUpPage } from "../views/auth.js";
import { completeProfilePage } from "../views/complete-profile.js";
import type { Db } from "../db/connection.js";

const formatSignInError = (error?: string): string | undefined => {
  if (!error) return undefined;

  const messages: Record<string, string> = {
    account_not_linked:
      "An account with this email already exists. Sign in with email and password — GitHub sign-in cannot be used for that address.",
    email_not_found: "GitHub did not share an email address. Make your primary email public on GitHub.",
  };

  return messages[error] ?? error.replaceAll("_", " ");
};

type AuthVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AuthRouteDeps = {
  githubEnabled: boolean;
  emailEnabled: boolean;
  db: Db;
  proxyAuthForm: (
    endpoint: "sign-in/email" | "sign-up/email",
    body: URLSearchParams,
    cookie: string | undefined,
    origin: string,
  ) => Promise<Response>;
  proxyAuthSignOut: (cookie: string | undefined, origin: string) => Promise<Response>;
  startGitHubSignIn: (returnTo: string, origin: string) => Promise<Response>;
  authErrorRedirect: (response: Response, fallback: string) => Promise<Response>;
  redirectWithAuthCookies: (authResponse: Response, location: string) => Response;
  maybeStartInitialSync: (user: AuthUser) => boolean;
};

export const registerAuthRoutes = (
  app: Hono<{ Variables: AuthVariables }>,
  deps: AuthRouteDeps,
): void => {
  app.get("/sign-in", (c) => {
    if (c.get("user")) return c.redirect(safeReturnToWithDefault(c.req.query("returnTo")));
    return c.html(
      signInPage({
        error: formatSignInError(c.req.query("error")),
        returnTo: c.req.query("returnTo"),
        githubEnabled: deps.githubEnabled,
        githubOnly: deps.githubEnabled && !deps.emailEnabled,
      }),
    );
  });

  app.post("/sign-in", async (c) => {
    if (!deps.emailEnabled) return c.text("Not found", 404);

    const form = await c.req.parseBody();
    const returnTo = safeReturnToWithDefault(firstString(form.returnTo));
    const response = await deps.proxyAuthForm(
      "sign-in/email",
      formToBody(form, ["email", "password"]),
      c.req.header("cookie"),
      new URL(c.req.url).origin,
    );
    if (!response.ok) return deps.authErrorRedirect(response, "/sign-in");
    return deps.redirectWithAuthCookies(response, returnTo);
  });

  app.get("/sign-in/github", async (c) => {
    if (!deps.githubEnabled) return c.text("Not found", 404);
    if (c.get("user")) return c.redirect(safeReturnToWithDefault(c.req.query("returnTo")));

    const returnTo = safeReturnToWithDefault(c.req.query("returnTo"));
    const response = await deps.startGitHubSignIn(returnTo, new URL(c.req.url).origin);
    const body = (await response.json().catch(() => undefined)) as { url?: string } | undefined;
    if (!response.ok || !body?.url) {
      return c.redirect(`/sign-in?error=${encodeURIComponent("GitHub sign-in failed")}`);
    }

    return deps.redirectWithAuthCookies(response, body.url);
  });

  app.get("/sign-up", (c) => {
    if (!deps.emailEnabled) {
      const returnTo = c.req.query("returnTo");
      const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
      return c.redirect(`/sign-in${query}`);
    }

    if (c.get("user")) return c.redirect(safeReturnToWithDefault(c.req.query("returnTo")));
    return c.html(
      signUpPage({
        error: c.req.query("error"),
        returnTo: c.req.query("returnTo"),
        githubEnabled: deps.githubEnabled,
      }),
    );
  });

  app.post("/sign-up", async (c) => {
    if (!deps.emailEnabled) return c.text("Not found", 404);

    const form = await c.req.parseBody();
    const returnTo = safeReturnToWithDefault(firstString(form.returnTo));
    const cfHandle = firstString(form.cfHandle)?.trim();
    if (!cfHandle) {
      return c.redirect(`/sign-up?error=${encodeURIComponent("Codeforces handle is required")}`);
    }

    const response = await deps.proxyAuthForm(
      "sign-up/email",
      formToBody(form, ["name", "email", "password", "cfHandle"]),
      c.req.header("cookie"),
      new URL(c.req.url).origin,
    );
    if (!response.ok) return deps.authErrorRedirect(response, "/sign-up");
    return deps.redirectWithAuthCookies(response, returnTo);
  });

  app.get("/complete-profile", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/sign-in");
    if (!needsCfHandle(user)) return c.redirect(safeReturnToWithDefault(c.req.query("returnTo")));

    return c.html(
      completeProfilePage({
        error: c.req.query("error"),
        returnTo: c.req.query("returnTo"),
        user,
      }),
    );
  });

  app.post("/complete-profile", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/sign-in");

    const form = await c.req.parseBody();
    const returnTo = safeReturnToWithDefault(firstString(form.returnTo));
    const cfHandle = firstString(form.cfHandle)?.trim();
    if (!cfHandle) {
      return c.redirect(
        `/complete-profile?error=${encodeURIComponent("Codeforces handle is required")}&returnTo=${encodeURIComponent(returnTo)}`,
      );
    }

    deps.db
      .prepare(`UPDATE "user" SET cfHandle = @cfHandle, updatedAt = @updatedAt WHERE id = @userId`)
      .run({ cfHandle, userId: user.id, updatedAt: new Date().toISOString() });

    deps.maybeStartInitialSync({ ...user, cfHandle });
    return c.redirect(returnTo);
  });

  app.post("/sign-out", async (c) => {
    const response = await deps.proxyAuthSignOut(c.req.header("cookie"), new URL(c.req.url).origin);
    return deps.redirectWithAuthCookies(response, "/sign-in");
  });
};
