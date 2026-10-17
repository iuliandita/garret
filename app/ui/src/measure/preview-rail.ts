// Only mounted by the persistence harness's staged document.
export async function measurePreviewRail(open: () => void) {
  const state = document.documentElement.dataset.measurePreviewRail;
  if (state === undefined) return null;
  if (state !== "open" && state !== "closed") throw new Error("invalid preview rail measurement state");
  const rail = document.querySelector<HTMLElement>("#preview-rail");
  const pages = document.querySelector<HTMLElement>("#preview-pages");
  const auto = document.querySelector<HTMLButtonElement>("#preview-auto-toggle");
  if (!rail || !pages || !auto) throw new Error("preview measurement controls missing");
  const visible = () => !rail.hidden && rail.getBoundingClientRect().width > 0
    && getComputedStyle(rail).visibility !== "hidden";
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (state === "open") {
    open();
    if (!visible()) throw new Error("preview rail did not open before typing");
    const deadline = performance.now() + 120_000;
    while (!pages.querySelector(".epub-document") && performance.now() < deadline) await wait(100);
    if (!visible() || !pages.querySelector(".epub-document")) {
      throw new Error("preview rail did not open and render before typing");
    }
  } else if (visible()) throw new Error("baseline preview rail is open");
  if (auto.getAttribute("aria-pressed") !== "true") auto.click();
  if (auto.getAttribute("aria-pressed") !== "true") throw new Error("idle refresh is not enabled");
  let idleRenders = 0;
  const observer = new MutationObserver((records) => {
    if (records.some((record) => [...record.addedNodes].some((node) =>
      node instanceof Element && node.matches(".epub-document")))) idleRenders++;
  });
  observer.observe(pages, { childList: true });
  return {
    // Both arms use the same pauses; continuous typing never permits idle refresh.
    pause: () => wait(5000),
    finish() {
      observer.disconnect();
      if (state === "open" && (!visible() || idleRenders === 0)) {
        throw new Error("preview rail was not visible with an idle refresh rendered during typing");
      }
      if (state === "closed" && (visible() || idleRenders !== 0)) {
        throw new Error("closed preview baseline rendered or became visible");
      }
      return { state, visible: visible(), idle_refresh_enabled: true, idle_renders: idleRenders,
        pause_ms_per_complete_cycle: 5000 };
    },
  };
}
