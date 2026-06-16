(() => {
  const setupRatingFilter = (root) => {
    const min = Number(root.dataset.min);
    const max = Number(root.dataset.max);
    const minInput = root.querySelector("[data-rating-min]");
    const maxInput = root.querySelector("[data-rating-max]");
    const minHidden = root.querySelector("[data-rating-min-hidden]");
    const maxHidden = root.querySelector("[data-rating-max-hidden]");
    const minOutput = root.querySelector("[data-rating-min-output]");
    const maxOutput = root.querySelector("[data-rating-max-output]");

    if (!minInput || !maxInput || !minHidden || !maxHidden || !minOutput || !maxOutput) return;

    const sync = (changed) => {
      let minValue = Number(minInput.value);
      let maxValue = Number(maxInput.value);

      if (minValue > maxValue) {
        if (changed === "min") {
          maxValue = minValue;
          maxInput.value = String(maxValue);
        } else {
          minValue = maxValue;
          minInput.value = String(minValue);
        }
      }

      minOutput.value = minValue === min ? "Any" : String(minValue);
      maxOutput.value = maxValue === max ? "Any" : String(maxValue);

      minHidden.disabled = minValue === min;
      maxHidden.disabled = maxValue === max;
      minHidden.value = minValue === min ? "" : String(minValue);
      maxHidden.value = maxValue === max ? "" : String(maxValue);
    };

    minInput.addEventListener("input", () => sync("min"));
    maxInput.addEventListener("input", () => sync("max"));
    sync();
  };

  document.querySelectorAll("[data-rating-filter]").forEach(setupRatingFilter);

  const renderStatusForm = ({ action, returnTo, solved }) => {
    const escapeAttr = (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const safeAction = escapeAttr(action);
    const safeReturnTo = escapeAttr(returnTo);

    if (solved) {
      return `
        <form class="status-form" data-status-form method="post" action="${safeAction}">
          <input type="hidden" name="solvedOverride" value="">
          <input type="hidden" name="returnTo" value="${safeReturnTo}">
          <button class="status status-button solved manual-solved" type="submit" title="Undo manual solved mark">✓</button>
        </form>
      `;
    }

    return `
      <form class="status-form" data-status-form method="post" action="${safeAction}">
        <input type="hidden" name="solvedOverride" value="1">
        <input type="hidden" name="returnTo" value="${safeReturnTo}">
        <button class="status status-button unsolved" type="submit" title="Mark solved"></button>
      </form>
    `;
  };

  const setupStatusForms = () => {
    document.addEventListener("submit", async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.matches("[data-status-form]")) return;

      event.preventDefault();
      const row = form.closest("[data-problem-row]");
      const cell = form.closest("[data-status-cell]");
      const button = form.querySelector("button");
      if (!row || !cell || !button) {
        form.submit();
        return;
      }

      button.disabled = true;

      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          headers: {
            accept: "application/json",
          },
        });

        if (!response.ok) throw new Error(await response.text());

        const payload = await response.json();
        const solved = Boolean(payload.effectiveSolved);
        row.classList.toggle("solved-row", solved);
        cell.innerHTML = renderStatusForm({
          action: form.getAttribute("action") || form.action,
          returnTo: form.querySelector('input[name="returnTo"]')?.value || window.location.pathname + window.location.search,
          solved,
        });
      } catch (error) {
        console.error(error);
        form.submit();
      }
    });
  };

  setupStatusForms();
})();
