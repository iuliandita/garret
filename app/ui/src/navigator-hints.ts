import { isCompositionKey } from "./composition-key";

/** One delegated tip outside the recycled tree rows. Their names stay titles. */
export function createNavigatorHints(container: HTMLElement) {
  const tip = document.createElement("div");
  tip.className = "nav-indicator-tip";
  tip.setAttribute("aria-hidden", "true");
  tip.hidden = true;
  let listening = false;
  let pendingHide: ReturnType<typeof setTimeout> | null = null;
  const cancelHide = (): void => {
    if (pendingHide !== null) clearTimeout(pendingHide);
    pendingHide = null;
  };
  const hide = (): void => {
    cancelHide();
    tip.hidden = true; tip.remove();
    if (listening) {
      container.ownerDocument.removeEventListener("keydown", escape, true);
      listening = false;
    }
  };
  function show(anchor: HTMLElement, text: string, keyboard = false): void {
    if (!text) { hide(); return; }
    cancelHide();
    tip.textContent = text;
    tip.hidden = false;
    container.ownerDocument.body.append(tip);
    if (!listening) {
      container.ownerDocument.addEventListener("keydown", escape, true);
      listening = true;
    }
    const box = anchor.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    let x = box.left;
    let y = box.bottom + 4;
    if (keyboard) {
      if (box.right + 8 + size.width <= window.innerWidth - 4) {
        x = box.right + 8;
        y = box.top;
      } else if (box.left - size.width - 8 >= 4) {
        x = box.left - size.width - 8;
        y = box.top;
      } else {
        y = box.top - size.height - 4;
      }
    }
    const left = Math.max(4, Math.min(x, window.innerWidth - size.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - size.height - 4));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  const refresh = (): void => {
    if (document.activeElement !== container) return;
    const row = container.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row) { hide(); return; }
    const text = [...row.querySelectorAll<HTMLElement>("[data-nav-hint]")]
      .map((mark) => mark.dataset.navHint).filter(Boolean).join("; ");
    show(row, text, true);
  };
  const scheduleHide = (): void => {
    cancelHide();
    pendingHide = setTimeout(hide, 200);
  };
  const over = (event: MouseEvent): void => {
    const mark = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-nav-hint]") : null;
    if (mark && container.contains(mark)) show(mark, mark.dataset.navHint ?? "");
    else scheduleHide();
  };
  const out = (event: MouseEvent): void => {
    if (event.relatedTarget instanceof Node && tip.contains(event.relatedTarget)) return;
    scheduleHide();
  };
  const escape = (event: KeyboardEvent): void => {
    if (isCompositionKey(event) || event.key !== "Escape" || tip.hidden) return;
    hide();
    event.preventDefault();
    event.stopPropagation();
  };
  container.addEventListener("mouseover", over);
  container.addEventListener("mouseout", out);
  container.addEventListener("focus", refresh);
  container.addEventListener("blur", hide);
  container.addEventListener("scroll", hide, true);
  tip.addEventListener("mouseenter", cancelHide);
  tip.addEventListener("mouseleave", hide);
  return { hide, refresh, destroy(): void {
    hide();
    container.removeEventListener("mouseover", over);
    container.removeEventListener("mouseout", out);
    container.removeEventListener("focus", refresh);
    container.removeEventListener("blur", hide);
    container.removeEventListener("scroll", hide, true);
    tip.removeEventListener("mouseenter", cancelHide);
    tip.removeEventListener("mouseleave", hide);
  } };
}
