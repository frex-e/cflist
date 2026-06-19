import type { Child } from "hono/jsx";
import { safeReturnToWithDefault } from "../http/return-to.js";
import { layout } from "./layout.js";
import { render } from "./render.js";

type AuthPageOptions = {
  error?: string;
  returnTo?: string;
  githubEnabled?: boolean;
  githubOnly?: boolean;
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

const githubSignInLink = (returnTo: string): Child => (
  <a class="button secondary auth-github" href={`/sign-in/github?returnTo=${encodeURIComponent(returnTo)}`}>
    <img class="auth-github-icon" src="/public/github.svg" width="20" height="20" alt="" />
    <span>Continue with GitHub</span>
  </a>
);

const AuthPage = (options: AuthPageOptions, config: AuthPageConfig): string => {
  const returnTo = safeReturnToWithDefault(options.returnTo);
  const githubOnly = options.githubOnly === true;

  return layout({
    title: config.title,
    activeNav: config.activeNav,
    body: render(
      <section class="auth-panel">
        <h1>{config.heading}</h1>
        {options.error ? <p class="form-error">{options.error}</p> : ""}
        {options.githubEnabled ? (
          <>
            {githubSignInLink(returnTo)}
            {githubOnly ? "" : <p class="auth-divider">or</p>}
          </>
        ) : (
          ""
        )}
        {githubOnly ? (
          ""
        ) : (
          <>
            <form class="auth-form" method="post" action={config.action}>
              <input type="hidden" name="returnTo" value={returnTo} />
              {config.fields}
              <button type="submit" class="auth-submit">{config.submitLabel}</button>
            </form>
            <p>
              {config.alternatePrompt}{" "}
              <a href={`${config.alternateHref}?returnTo=${encodeURIComponent(returnTo)}`}>{config.alternateLinkText}</a>
            </p>
          </>
        )}
      </section>,
    ),
  });
};

export const signInPage = (options: AuthPageOptions = {}): string => {
  const githubOnly = options.githubOnly === true;

  return AuthPage(options, {
    title: "Sign In",
    activeNav: "sign-in",
    heading: githubOnly ? "Sign in or create account" : "Sign in",
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
