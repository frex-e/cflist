import type { Child } from "hono/jsx";
import { safeReturnToWithDefault } from "../http/return-to.js";
import { layout } from "./layout.js";
import { render } from "./render.js";

type AuthPageOptions = {
  error?: string;
  returnTo?: string;
};

type AuthPageConfig = {
  title: string;
  activeNav: "sign-in" | "sign-up";
  heading: string;
  action: string;
  submitLabel: string;
  alternateHref: string;
  alternatePrompt: string;
  alternateLinkText: string;
  fields: Child;
};

const AuthPage = (options: AuthPageOptions, config: AuthPageConfig): string => {
  const returnTo = safeReturnToWithDefault(options.returnTo);

  return layout({
    title: config.title,
    activeNav: config.activeNav,
    body: render(
      <section class="auth-panel">
        <h1>{config.heading}</h1>
        {options.error ? <p class="form-error">{options.error}</p> : ""}
        <form class="auth-form" method="post" action={config.action}>
          <input type="hidden" name="returnTo" value={returnTo} />
          {config.fields}
          <button type="submit">{config.submitLabel}</button>
        </form>
        <p>
          {config.alternatePrompt} <a href={`${config.alternateHref}?returnTo=${encodeURIComponent(returnTo)}`}>{config.alternateLinkText}</a>
        </p>
      </section>,
    ),
  });
};

export const signInPage = (options: AuthPageOptions = {}): string => {
  return AuthPage(options, {
    title: "Sign In",
    activeNav: "sign-in",
    heading: "Sign in",
    action: "/sign-in",
    submitLabel: "Sign in",
    alternateHref: "/sign-up",
    alternatePrompt: "Need an account?",
    alternateLinkText: "Sign up",
    fields: (
      <>
        <label>
          Email
          <input type="email" name="email" autocomplete="email" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
      </>
    ),
  });
};

export const signUpPage = (options: AuthPageOptions = {}): string => {
  return AuthPage(options, {
    title: "Sign Up",
    activeNav: "sign-up",
    heading: "Create account",
    action: "/sign-up",
    submitLabel: "Create account",
    alternateHref: "/sign-in",
    alternatePrompt: "Already have an account?",
    alternateLinkText: "Sign in",
    fields: (
      <>
        <label>
          Name
          <input type="text" name="name" autocomplete="name" required />
        </label>
        <label>
          Email
          <input type="email" name="email" autocomplete="email" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="new-password" minlength={8} required />
        </label>
        <label>
          Codeforces handle
          <input type="text" name="cfHandle" autocomplete="username" required />
        </label>
      </>
    ),
  });
};
