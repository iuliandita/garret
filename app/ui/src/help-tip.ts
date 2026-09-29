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

  // A mark near a panel's right edge (the Statistics panel's second column)
  // would have its tip cut off by the scrolling body. Bound AFTER the
  // tooltip's own listeners, so the tip is attached when this measures it;
  // then it opens leftward from the mark instead.
  const place = (): void => {
    const tip = tooltip.tip;
    tip.classList.remove("tip-flip");
    if (tip.parentNode === null) return;
    const edge = Math.min(clipRight(tooltip.anchor), window.innerWidth);
    if (tip.getBoundingClientRect().right > edge) tip.classList.add("tip-flip");
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

/** The right edge of the nearest ancestor that clips its overflow. */
function clipRight(from: HTMLElement): number {
  for (let node = from.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") return node.getBoundingClientRect().right;
  }
  return window.innerWidth;
}
