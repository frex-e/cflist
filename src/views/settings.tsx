import type { Child } from "hono/jsx";
import type { AuthUser } from "../auth.js";
import { isAdminEmail } from "../config.js";
import { layout } from "./layout.js";
import { PageHero } from "./page-hero.js";
import { render } from "./render.js";

type SettingsPageOptions = {
  user: AuthUser;
  error?: string;
  success?: string;
};

const confirmHandleField = (handle: string): Child => (
  <label>
    Type <strong>{handle}</strong> to confirm
    <input type="text" name="confirmHandle" autocomplete="off" required />
  </label>
);

export const settingsPage = (options: SettingsPageOptions): string => {
  const handle = options.user.cfHandle.trim();

  return layout({
    title: "Settings",
    user: options.user,
    body: render(
      <div class="settings-page">
        <PageHero
          title="Settings"
          subtitle="Manage your account and synced Codeforces data."
        />
        {options.error ? <p class="form-error settings-banner">{options.error}</p> : ""}
        {options.success ? <p class="form-success settings-banner">{options.success}</p> : ""}
        <div class="settings-sections">
          <section class="settings-section">
            <h2>Account</h2>
            <dl class="settings-dl">
              <div>
                <dt>Email</dt>
                <dd>{options.user.email}</dd>
              </div>
              <div>
                <dt>Codeforces handle</dt>
                <dd>
                  <a href="/settings/handle">{handle}</a>
                </dd>
              </div>
            </dl>
            {isAdminEmail(options.user.email) ? (
              <p>
                <a href="/admin/catalog">Catalog repair</a> (admin)
              </p>
            ) : (
              ""
            )}
          </section>

          <section class="settings-section">
            <h2>Codeforces data</h2>
            <p>
              Re-fetch contest standings, scores, and performance from Codeforces without clearing
              your solved list or filter defaults.
            </p>
            <form class="settings-form" method="post" action="/settings/refresh-contest-details">
              {confirmHandleField(handle)}
              <button type="submit" class="button secondary">
                Refresh contest details
              </button>
            </form>
            <p>
              Delete your synced solved problems, contest history, and hydration state, then fetch
              everything again from Codeforces. Your handle and saved filter defaults are kept.
            </p>
            <form class="settings-form" method="post" action="/settings/reset-cf-data">
              {confirmHandleField(handle)}
              <button type="submit" class="button secondary">
                Reset Codeforces data
              </button>
            </form>
          </section>

          <section class="settings-section settings-danger">
            <h2>Delete account</h2>
            <p>
              Permanently delete your account and all associated data. This cannot be undone.
            </p>
            <form class="settings-form" method="post" action="/settings/delete-account">
              {confirmHandleField(handle)}
              <button type="submit" class="button danger">
                Delete account
              </button>
            </form>
          </section>
        </div>
      </div>,
    ),
  });
};
