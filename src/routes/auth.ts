import type { Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import { safeReturnToWithDefault } from "../http/return-to.js";
import { firstString, formToBody } from "../http/forms.js";
import { signInPage, signUpPage } from "../views/auth.js";

type AuthVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AuthRouteDeps = {
  proxyAuthForm: (
    endpoint: "sign-in/email" | "sign-up/email",
    body: URLSearchParams,
    cookie: string | undefined,
    origin: string,
  ) => Promise<Response>;
  proxyAuthSignOut: (cookie: string | undefined, origin: string) => Promise<Response>;
  authErrorRedirect: (response: Response, fallback: string) => Promise<Response>;
  redirectWithAuthCookies: (authResponse: Response, location: string) => Response;
};

export const registerAuthRoutes = (
  app: Hono<{ Variables: AuthVariables }>,
  deps: AuthRouteDeps,
): void => {
  app.get("/sign-in", (c) => {
    if (c.get("user")) return c.redirect(safeReturnToWithDefault(c.req.query("returnTo")));
    return c.html(signInPage({ error: c.req.query("error"), returnTo: c.req.query("returnTo") }));
  });

  app.post("/sign-in", async (c) => {
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

  app.get("/sign-up", (c) => {
    if (c.get("user")) return c.redirect(safeReturnToWithDefault(c.req.query("returnTo")));
    return c.html(signUpPage({ error: c.req.query("error"), returnTo: c.req.query("returnTo") }));
  });

  app.post("/sign-up", async (c) => {
    const form = await c.req.parseBody();
    const returnTo = safeReturnToWithDefault(firstString(form.returnTo));
    const response = await deps.proxyAuthForm(
      "sign-up/email",
      formToBody(form, ["name", "email", "password", "cfHandle"]),
      c.req.header("cookie"),
      new URL(c.req.url).origin,
    );
    if (!response.ok) return deps.authErrorRedirect(response, "/sign-up");
    return deps.redirectWithAuthCookies(response, returnTo);
  });

  app.post("/sign-out", async (c) => {
    const response = await deps.proxyAuthSignOut(c.req.header("cookie"), new URL(c.req.url).origin);
    return deps.redirectWithAuthCookies(response, "/sign-in");
  });
};
