import { safeReturnToWithDefault } from "../http/return-to.js";
import { layout } from "./layout.js";
import { render } from "./render.js";
import type { AuthUser } from "../auth.js";

type HandleSettingsPageOptions = {
  error?: string;
  returnTo?: string;
  user: AuthUser;
  currentHandle?: string;
  formAction?: string;
  title?: string;
  heading?: string;
  description?: string;
};

export const handleSettingsPage = (options: HandleSettingsPageOptions): string => {
  const returnTo = safeReturnToWithDefault(options.returnTo);
  const currentHandle = options.currentHandle ?? options.user.cfHandle ?? "";

  return layout({
    title: options.title ?? "Codeforces Handle",
    user: options.user,
    body: render(
      <section class="auth-panel">
        <h1>{options.heading ?? "Codeforces handle"}</h1>
        <p>
          {options.description ??
            "Enter your Codeforces handle to sync solved problems and contest history."}
        </p>
        {options.error ? <p class="form-error">{options.error}</p> : ""}
        <form class="auth-form" method="post" action={options.formAction ?? "/settings/handle"}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>
            Codeforces handle
            <input
              type="text"
              name="cfHandle"
              autocomplete="username"
              required
              value={currentHandle}
            />
          </label>
          <button type="submit">Save handle</button>
        </form>
        {options.title === "Change Handle" ? (
          <p>
            <a href="/settings">Back to settings</a>
          </p>
        ) : (
          ""
        )}
      </section>,
    ),
  });
};

export const completeProfilePage = (options: {
  error?: string;
  returnTo?: string;
  user: AuthUser;
}): string =>
  handleSettingsPage({
    ...options,
    title: "Complete Profile",
    heading: "Codeforces handle",
    description: "Enter your Codeforces handle to sync solved problems and contest history.",
    currentHandle: "",
    formAction: "/complete-profile",
  });
