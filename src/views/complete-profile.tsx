import { safeReturnToWithDefault } from "../http/return-to.js";
import { layout } from "./layout.js";
import { render } from "./render.js";
import type { AuthUser } from "../auth.js";

type CompleteProfilePageOptions = {
  error?: string;
  returnTo?: string;
  user: AuthUser;
};

export const completeProfilePage = (options: CompleteProfilePageOptions): string => {
  const returnTo = safeReturnToWithDefault(options.returnTo);

  return layout({
    title: "Complete Profile",
    user: options.user,
    body: render(
      <section class="auth-panel">
        <h1>Codeforces handle</h1>
        <p>Enter your Codeforces handle to sync solved problems and contest history.</p>
        {options.error ? <p class="form-error">{options.error}</p> : ""}
        <form class="auth-form" method="post" action="/complete-profile">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>
            Codeforces handle
            <input type="text" name="cfHandle" autocomplete="username" required />
          </label>
          <button type="submit">Continue</button>
        </form>
      </section>,
    ),
  });
};
