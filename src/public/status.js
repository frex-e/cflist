(() => {
  const STATUS_VIEW = {
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

  const statusAfterOverride = (posted) => {
    if (posted === "skipped") return "skipped";
    if (posted === "solved") return "solved";
    return "unsolved";
  };

  const readCurrentStatus = (button) => {
    if (button.classList.contains("manual-solved") || button.classList.contains("solved")) {
      return "solved";
    }
    if (button.classList.contains("skipped")) return "skipped";
    return "unsolved";
  };

  // Match override POST filter context (HX-Current-URL / location), not the
  // filter form select — that can lag during debounce or history navigation.
  const solvedFilterFromLocation = () => {
    try {
      return new URL(window.location.href).searchParams.get("solved") || "all";
    } catch {
      return "all";
    }
  };

  const statusMatchesSolvedFilter = (filter, status) => {
    if (!filter || filter === "all") return true;
    if (filter === "solved") return status === "solved";
    if (filter === "skipped") return status === "skipped";
    if (filter === "unsolved") return status === "unsolved";
    return true;
  };

  const parseSummaryText = (text) => {
    const match = text
      .trim()
      .match(
        /^([\d,]+)\s+matched,\s+([\d,]+)\s+solved,\s+([\d,]+)\s+skipped,\s+([\d,]+)\s+unsolved for\s+(.+)$/,
      );
    if (!match) return null;
    const parseCount = (value) => Number(value.replace(/,/g, ""));
    return {
      counts: {
        total: parseCount(match[1]),
        solved: parseCount(match[2]),
        skipped: parseCount(match[3]),
        unsolved: parseCount(match[4]),
      },
      cfHandle: match[5],
    };
  };

  const formatNumber = (value) => new Intl.NumberFormat("en").format(value);

  const formatSummaryCounts = (counts, cfHandle) =>
    `${formatNumber(counts.total)} matched, ${formatNumber(counts.solved)} solved, ${formatNumber(counts.skipped)} skipped, ${formatNumber(counts.unsolved)} unsolved for ${cfHandle}`;

  const bump = (counts, status, delta) => {
    if (status === "solved") counts.solved += delta;
    else if (status === "skipped") counts.skipped += delta;
    else counts.unsolved += delta;
  };

  const adjustSummaryCounts = (counts, from, to, filter) => {
    const next = { ...counts };
    const staysVisible = statusMatchesSolvedFilter(filter, to);
    bump(next, from, -1);
    if (staysVisible) bump(next, to, 1);
    else next.total -= 1;
    return next;
  };

  const snapshots = new WeakMap();

  const captureSnapshot = (row, button) => ({
    rowClass: row.className,
    rowHidden: row.hidden,
    buttonClass: button.className,
    buttonText: button.textContent,
    buttonTitle: button.getAttribute("title") ?? "",
    dataStatus: row.getAttribute("data-local-status"),
    previousSummaryText: null,
    writtenSummaryText: null,
  });

  const restoreRowSnapshot = (row, button, snapshot) => {
    row.className = snapshot.rowClass;
    row.hidden = snapshot.rowHidden;
    if (snapshot.dataStatus) row.setAttribute("data-local-status", snapshot.dataStatus);
    else row.removeAttribute("data-local-status");
    button.className = snapshot.buttonClass;
    button.textContent = snapshot.buttonText;
    button.title = snapshot.buttonTitle;
  };

  const applyStatusView = (row, button, status) => {
    const view = STATUS_VIEW[status];
    if (!view) return;
    row.className = view.rowClass;
    row.setAttribute("data-local-status", status);
    button.className = view.buttonClass;
    button.textContent = view.glyph;
    button.title = view.title;
  };

  const statusFormFromEvent = (event) => {
    const elt = event.detail?.elt;
    if (!(elt instanceof HTMLElement)) return null;
    return elt.matches("form.status-form") ? elt : elt.closest("form.status-form");
  };

  document.body.addEventListener("htmx:beforeRequest", (event) => {
    const form = statusFormFromEvent(event);
    if (!(form instanceof HTMLFormElement)) return;

    const row = form.closest("tr[data-problem-row]");
    const button = form.querySelector("button.status-button");
    const statusInput = form.querySelector('input[name="localStatus"]');
    if (!(row instanceof HTMLTableRowElement) || !(button instanceof HTMLButtonElement)) return;

    const posted = statusInput instanceof HTMLInputElement ? statusInput.value : "";
    const nextStatus = statusAfterOverride(posted);
    const currentStatus = readCurrentStatus(button);
    const filter = solvedFilterFromLocation();
    const summary = document.querySelector("#problem-summary");
    const snapshot = captureSnapshot(row, button);

    applyStatusView(row, button, nextStatus);

    if (summary) {
      const previousSummaryText = summary.textContent ?? "";
      const parsed = parseSummaryText(previousSummaryText);
      if (parsed) {
        const writtenSummaryText = formatSummaryCounts(
          adjustSummaryCounts(parsed.counts, currentStatus, nextStatus, filter),
          parsed.cfHandle,
        );
        summary.textContent = writtenSummaryText;
        snapshot.previousSummaryText = previousSummaryText;
        snapshot.writtenSummaryText = writtenSummaryText;
      }
    }

    if (!statusMatchesSolvedFilter(filter, nextStatus)) {
      row.hidden = true;
    }

    snapshots.set(form, snapshot);
  });

  const revertOptimistic = (event) => {
    const form = statusFormFromEvent(event);
    if (!(form instanceof HTMLFormElement)) return;
    const snapshot = snapshots.get(form);
    if (!snapshot) return;

    const row = form.closest("tr[data-problem-row]");
    const button = form.querySelector("button.status-button");
    if (!(row instanceof HTMLTableRowElement) || !(button instanceof HTMLButtonElement)) return;

    restoreRowSnapshot(row, button, snapshot);

    // Only undo our summary write if nothing else replaced it (another toggle
    // success or filter OOB). Restoring a stale absolute snapshot would clobber
    // newer matched/solved/skipped/unsolved counts.
    const summary = document.querySelector("#problem-summary");
    if (
      summary
      && snapshot.writtenSummaryText !== null
      && snapshot.previousSummaryText !== null
      && summary.textContent === snapshot.writtenSummaryText
    ) {
      summary.textContent = snapshot.previousSummaryText;
    }

    snapshots.delete(form);
  };

  document.body.addEventListener("htmx:responseError", revertOptimistic);
  document.body.addEventListener("htmx:sendError", revertOptimistic);
  document.body.addEventListener("htmx:afterSwap", (event) => {
    const form = statusFormFromEvent(event);
    if (form instanceof HTMLFormElement) snapshots.delete(form);
  });
})();
