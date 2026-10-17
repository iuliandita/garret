// app/ui/src/help-tip.ts
// A figure's definition, one question mark away.
//
// Statistics, Analytics and the craft reports used to print how every figure
// is counted under the figure itself, and the page read as a manual. The
// definitions moved off the page: each figure's label gets a
// small help mark whose tooltip holds the definition. THE TEXT IS KEPT, only
// moved: it is the tooltip and it is the button's accessible description, so
// a screen reader still hears it on focus and a pointer or keyboard user sees
// it on hover or focus through `tooltip.ts` (sibling, attached only while
// shown).
//
// The description lives in a hidden sibling that `aria-describedby` names. A
// hidden node referenced by id still contributes its text to the description,
// and the tooltip itself is `aria-hidden` and absent at rest, so it cannot be
// the one the reference points at.
import { t } from "./i18n";
import { createIcon } from "./icons";
import { createTooltip } from "./tooltip";

export interface HelpTip {
  /** The mark and its hidden definition, ready to place after a label. */
  readonly anchor: HTMLElement;
  readonly button: HTMLButtonElement;
  destroy(): void;
}

let next = 0;

/** `id`, when given, names the button so a rig can hover it by id; the
 *  description takes `<id>-text`. */
export function createHelpTip(spec: { label: string; definition: string; id?: string }): HelpTip {
  next += 1;
  const id = spec.id ?? `help-tip-${next}`;
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "help-tip";
  button.dataset.weight = "quiet";
  button.setAttribute("aria-label", t("help.about", { label: spec.label }));
  button.append(createIcon("circle-help"));

  const description = document.createElement("span");
  description.id = `${id}-text`;
  description.className = "help-tip-text";
  description.hidden = true;
  description.textContent = spec.definition;
  button.setAttribute("aria-describedby", description.id);

  const tooltip = createTooltip({ control: button, name: spec.definition, hint: null });
  tooltip.anchor.classList.add("help-tip-anchor");
  tooltip.anchor.append(description);

  // Clamp to every edge of the clipping ancestors; flipping can put a
  // definition outside the other edge of a narrow inspector.
  const place = (): void => {
    const tip = tooltip.tip;
    if (tip.parentNode === null) return;
    const bounds = clipBounds(tooltip.anchor);
    tip.style.maxHeight = `${Math.max(0, bounds.bottom - bounds.top - 8)}px`;
    tip.style.overflowY = "";
    tip.style.maxWidth = `${Math.max(0, Math.min(300, bounds.right - bounds.left - 8))}px`;
    tip.style.left = "0px";
    const anchor = tooltip.anchor.getBoundingClientRect();
    const scrolls = tip.scrollHeight > tip.clientHeight;
    if (scrolls) tip.style.overflowY = "auto";
    const gap = scrolls ? 0 : 6;
    const size = tip.getBoundingClientRect();
    const width = size.width;
    const left = Math.max(bounds.left + 4, Math.min(anchor.left, bounds.right - width - 4));
    tip.style.left = `${left - anchor.left}px`;
    const below = anchor.bottom + gap;
    const top = below + size.height <= bounds.bottom - 4
      ? below
      : Math.max(bounds.top + 4, anchor.top - size.height - gap);
    tip.style.top = `${top - anchor.top}px`;
    tip.classList.toggle("tip-above", top < anchor.top);
  };
  button.addEventListener("mouseenter", place);
  button.addEventListener("focus", place);
  return {
    anchor: tooltip.anchor,
    button,
    destroy: () => {
      button.removeEventListener("mouseenter", place);
      button.removeEventListener("focus", place);
      tooltip.destroy();
    },
  };
}

/** The space visible through all scrolling/clipping ancestors. */
function clipBounds(from: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  let left = 0;
  let right = window.innerWidth;
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = from.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if ([style.overflowX, style.overflowY].some((value) => ["auto", "scroll", "hidden", "clip"].includes(value))) {
      const rect = node.getBoundingClientRect();
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
  }
  return { left, right, top, bottom };
}
