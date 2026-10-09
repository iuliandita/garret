import { t } from "./i18n";
import { createTooltip } from "./tooltip";

/** The control follows the real Bible row but stays outside the virtual tree. */
export function createBibleCreateControl(nav: HTMLElement, open: () => void): { destroy(): void } {
  const button = document.createElement("button");
  button.id = "bible-create";
  button.type = "button";
  button.textContent = t("creation.plus");
  button.setAttribute("aria-label", t("creation.bible.open"));
  button.addEventListener("click", open);
  const tip = createTooltip({ control: button, name: t("creation.bible.open"), hint: null });
  tip.anchor.classList.add("bible-create-anchor");
  tip.anchor.hidden = true;
  (nav.parentElement ?? document.body).append(tip.anchor);
  let frame: number | null = null;
  let destroyed = false;
  function position(): void {
    frame = null;
    if (destroyed) return;
    const row = nav.querySelector<HTMLElement>('[data-type="bible"][aria-level="1"]');
    const bounds = nav.getBoundingClientRect();
    const rect = row?.getBoundingClientRect();
    const shown = rect !== undefined && rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.height > 0;
    if (!shown && tip.anchor.contains(document.activeElement)) nav.focus();
    tip.anchor.hidden = !shown;
    if (shown && rect !== undefined) {
      tip.anchor.style.top = `${rect.top}px`;
      const left = rect.right - 32;
      tip.anchor.style.left = `${left}px`;
    }
  }
  function schedule(): void {
    if (!destroyed && frame === null) frame = requestAnimationFrame(position);
  }
  const mutations = new MutationObserver(schedule);
  mutations.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "data-type"] });
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  resize?.observe(nav);
  nav.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  schedule();
  return {
    destroy(): void {
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      mutations.disconnect();
      resize?.disconnect();
      nav.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      button.removeEventListener("click", open);
      tip.destroy();
      tip.anchor.remove();
    },
  };
}
