import type { ProblemDetail } from "../db/queries.js";
import { escapeHtml, formatDateTime, formatNumber } from "./html.js";
import { layout } from "./layout.js";

const tagsForProblem = (problem: ProblemDetail): string[] => {
  try {
    const parsed = JSON.parse(problem.tags_json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const statusText = (problem: ProblemDetail): string => {
  if (problem.solved_override === 1) return "Solved locally";
  if (problem.cf_solved === 1) return "Solved on Codeforces";
  return "Unsolved";
};

export const problemPage = (options: {
  problem: ProblemDetail;
  handle: string;
  adminTokenEnabled: boolean;
}): string => {
  const { problem, handle, adminTokenEnabled } = options;
  const tags = tagsForProblem(problem);
  const problemId = `${problem.contest_id}${problem.problem_index}`;

  const body = `
    <section class="detail-header">
      <a href="/problems" class="back-link">← Problems</a>
      <div>
        <h1>${escapeHtml(problem.name)}</h1>
        <p class="subtle">${escapeHtml(problemId)} · ${escapeHtml(problem.contest_name ?? "Unknown contest")}</p>
      </div>
      <a class="button" href="${escapeHtml(problem.url)}" rel="noreferrer" target="_blank">Open on CF</a>
    </section>

    <section class="detail-grid">
      <div class="panel">
        <h2>Problem</h2>
        <dl>
          <dt>Rating</dt><dd>${problem.rating ?? "Unrated"}</dd>
          <dt>Solved count</dt><dd>${formatNumber(problem.solved_count)}</dd>
          <dt>Type</dt><dd>${escapeHtml(problem.type ?? "")}</dd>
          <dt>Points</dt><dd>${problem.points ?? ""}</dd>
          <dt>Contest class</dt><dd>${escapeHtml(problem.derived_label ?? "")}</dd>
        </dl>
        <div class="tags detail-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
      </div>

      <div class="panel">
        <h2>${escapeHtml(handle)}</h2>
        <dl>
          <dt>Status</dt><dd>${escapeHtml(statusText(problem))}</dd>
          <dt>CF accepted count</dt><dd>${formatNumber(problem.accepted_count)}</dd>
          <dt>First AC</dt><dd>${formatDateTime(problem.first_accepted_at_seconds)}</dd>
          <dt>Submission</dt><dd>${problem.first_accepted_submission_id ? `<a href="https://codeforces.com/contest/${problem.contest_id}/submission/${problem.first_accepted_submission_id}" rel="noreferrer" target="_blank">${problem.first_accepted_submission_id}</a>` : ""}</dd>
          <dt>Override updated</dt><dd>${formatDateTime(problem.override_updated_at)}</dd>
        </dl>
      </div>

      <form class="panel override-form" method="post" action="/problems/${problem.contest_id}/${encodeURIComponent(problem.problem_index)}/override">
        <h2>Manual Override</h2>
        <label>
          Solved status
          <select name="solvedOverride">
            <option value="" ${problem.solved_override === null ? "selected" : ""}>Use Codeforces status</option>
            <option value="1" ${problem.solved_override === 1 ? "selected" : ""}>Solved locally</option>
          </select>
        </label>
        <label>
          Note
          <textarea name="note" rows="4">${escapeHtml(problem.override_note ?? "")}</textarea>
        </label>
        ${adminTokenEnabled ? '<label>Admin token<input type="password" name="adminToken" autocomplete="current-password"></label>' : ""}
        <button type="submit">Save override</button>
      </form>
    </section>`;

  return layout({ title: `${problemId} ${problem.name}`, body });
};

export const notFoundPage = (): string => {
  return layout({
    title: "Problem Not Found",
    body: `<section class="hero"><h1>Problem not found</h1><p>The problem is not in the local CFList database yet.</p><a class="button" href="/problems">Back to problems</a></section>`,
  });
};
