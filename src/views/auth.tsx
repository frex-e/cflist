import type { Child } from "hono/jsx";
import { layout } from "./layout.js";

type AuthPageOptions = {
  error?: string;
  returnTo?: string;
};

const render = (content: Child): string => String(content);

const safeReturnTo = (returnTo: string | undefined): string => {
  if (!returnTo?.startsWith("/") || returnTo.startsWith("//")) return "/problems";
  return returnTo;
};

export const signInPage = (options: AuthPageOptions = {}): string => {
  const returnTo = safeReturnTo(options.returnTo);

  return layout({
    title: "Sign In",
    activeNav: "sign-in",
    body: render(
      <section class="auth-panel">
        <h1>Sign in</h1>
        {options.error ? <p class="form-error">{options.error}</p> : ""}
        <form class="auth-form" method="post" action="/sign-in">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>
            Email
            <input type="email" name="email" autocomplete="email" required />
          </label>
          <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button type="submit">Sign in</button>
        </form>
        <p>
          Need an account? <a href={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>Sign up</a>
        </p>
      </section>,
    ),
  });
};

export const signUpPage = (options: AuthPageOptions = {}): string => {
  const returnTo = safeReturnTo(options.returnTo);

  return layout({
    title: "Sign Up",
    activeNav: "sign-up",
    body: render(
      <section class="auth-panel">
        <h1>Create account</h1>
        {options.error ? <p class="form-error">{options.error}</p> : ""}
        <form class="auth-form" method="post" action="/sign-up">
          <input type="hidden" name="returnTo" value={returnTo} />
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
          <button type="submit">Create account</button>
        </form>
        <p>
          Already have an account? <a href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</a>
        </p>
      </section>,
    ),
  });
};
