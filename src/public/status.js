(() => {
  const VIEW = {
    unsolved: {
      buttonClass: "status status-button unsolved",
      glyph: "",
      title: "Mark skipped",
      rowClass: "problem-row",
    },
    skipped: {
      buttonClass: "status status-button skipped",
      glyph: "–",
      title: "Mark solved",
      rowClass: "problem-row skipped-row",
    },
    solved: {
      buttonClass: "status status-button solved manual-solved",
      glyph: "✓",
      title: "Clear status (unsolved)",
      rowClass: "problem-row solved-row",
    },
  };

  const statusFromPosted = (posted) =>
    posted === "skipped" || posted === "solved" ? posted : "unsolved";

  // Same filter context as override re-list (HX-Current-URL).
  const solvedFilter = () => {
    try {
      return new URL(window.location.href).searchParams.get("solved") || "all";
    } catch {
      return "all";
    }
  };

  const visibleUnderFilter = (filter, status) =>
    !filter || filter === "all" || filter === status;

  document.body.addEventListener("htmx:beforeRequest", (event) => {
    const elt = event.detail?.elt;
    if (!(elt instanceof HTMLElement)) return;
    const form = elt.matches("form.status-form") ? elt : elt.closest("form.status-form");
    if (!(form instanceof HTMLFormElement)) return;

    const row = form.closest("tr[data-problem-row]");
    const button = form.querySelector("button.status-button");
    const input = form.querySelector('input[name="localStatus"]');
    if (!(row instanceof HTMLTableRowElement) || !(button instanceof HTMLButtonElement)) return;

    const status = statusFromPosted(input instanceof HTMLInputElement ? input.value : "");
    const view = VIEW[status];
    button.className = view.buttonClass;
    button.textContent = view.glyph;
    button.title = view.title;
    row.className = view.rowClass;
    row.setAttribute("data-local-status", status);
    row.hidden = !visibleUnderFilter(solvedFilter(), status);
  });
})();
