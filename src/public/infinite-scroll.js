(() => {
  document.documentElement.classList.add("js");

  const VIEWPORT_MARGIN = 240;
  let loading = false;
  let armedScrollY = 0;

  const getSentinel = () => document.querySelector("[data-load-more]:not([hidden])");

  const sentinelNearViewport = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.top <= window.innerHeight + VIEWPORT_MARGIN;
  };

  const scrollTop = () => window.scrollY || document.documentElement.scrollTop;

  const userScrolledSinceArm = () => scrollTop() > armedScrollY;

  const release = () => {
    loading = false;
    armedScrollY = scrollTop();
  };

  const tryLoadMore = () => {
    if (loading || !window.htmx) return;

    const sentinel = getSentinel();
    if (!(sentinel instanceof HTMLElement)) return;
    if (!userScrolledSinceArm() || !sentinelNearViewport(sentinel)) return;

    const url = sentinel.getAttribute("hx-get");
    if (!url) return;

    loading = true;
    window.htmx.ajax("GET", url, {
      target: sentinel,
      swap: "outerHTML",
    });
  };

  window.addEventListener("scroll", tryLoadMore, { passive: true });
  document.body.addEventListener("htmx:afterSettle", release);
  document.body.addEventListener("htmx:responseError", release);
  document.body.addEventListener("htmx:sendError", release);

  const init = () => {
    release();
    tryLoadMore();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
