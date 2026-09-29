// app/ui/src/chrome-toggles.ts
import { createIcon } from "./icons";
import { t } from "./i18n";
import { createTooltip, type Tooltip } from "./tooltip";
import type { FocusMode } from "./writing-modes";
import { isCompositionKey } from "./composition-key";

// TWO HEADER CONTROLS. Both are buttons with aria-pressed, which
// makes them `toggle button` in ATK (nodes.ts's WANTED set). Neither is
// pressed by any rig.

/** On <body>. Session-only: no setting, no chord. A remembered collapse would
 *  move NAV_CLICK_X for every rig and wants its own slice. */
export const NAV_HIDDEN_CLASS = "nav-hidden";

export interface OutlineToggleDeps {
  container: HTMLElement;
  body: HTMLElement;
}

export interface OutlineToggle {
  destroy(): void;
}

export function createOutlineToggle(deps: OutlineToggleDeps): OutlineToggle {
  const { container, body } = deps;
  const button = document.createElement("button");
  button.id = "outline-toggle";
  button.type = "button";
  button.setAttribute("aria-label", t("chrome.outline.label"));
  button.append(createIcon("outline"));

  const narrow = window.matchMedia("(max-width: 900px)");
  let manualHidden = body.classList.contains(NAV_HIDDEN_CLASS);
  let overlayOpen = false;
  const backdrop = document.createElement("button");
  backdrop.id = "outline-backdrop";
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", t("chrome.outline.close"));
  backdrop.tabIndex = -1;
  body.append(backdrop);

  const paint = (): void => {
    const hidden = narrow.matches ? !overlayOpen : manualHidden;
    body.classList.toggle("nav-narrow", narrow.matches);
    body.classList.toggle(NAV_HIDDEN_CLASS, hidden);
    backdrop.hidden = !narrow.matches || !overlayOpen;
    button.setAttribute("aria-pressed", String(!hidden));
    button.setAttribute("aria-expanded", String(!hidden));
    button.setAttribute("aria-controls", "nav-column");
  };
  const closeOverlay = (): void => {
    overlayOpen = false;
    paint();
  };
  const onClick = (): void => {
    if (narrow.matches) {
      overlayOpen = !overlayOpen;
      manualHidden = !overlayOpen;
    } else manualHidden = !manualHidden;
    paint();
  };
  const onResize = (): void => {
    overlayOpen = false;
    paint();
  };
  const onBackdrop = (): void => {
    closeOverlay();
    button.focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!overlayOpen || event.key !== "Escape" || isCompositionKey(event)) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("#nav-column")) return;
    event.preventDefault();
    event.stopPropagation();
    onBackdrop();
  };
  const onEditorFocus = (event: Event): void => {
    if (overlayOpen && event.target instanceof Element && event.target.closest("#editor")) closeOverlay();
  };

  paint();
  narrow.addEventListener("change", onResize);
  backdrop.addEventListener("click", onBackdrop);
  body.addEventListener("keydown", onKey, true);
  body.addEventListener("focus", onEditorFocus, true);
  const tooltip: Tooltip = createTooltip({
    control: button,
    name: t("chrome.outline.label"),
    hint: t("chrome.outline.hint"),
  });
  button.addEventListener("click", onClick);
  container.replaceChildren(tooltip.anchor);

  return {
    destroy(): void {
      button.removeEventListener("click", onClick);
      narrow.removeEventListener("change", onResize);
      body.removeEventListener("keydown", onKey, true);
      body.removeEventListener("focus", onEditorFocus, true);
      backdrop.remove();
      tooltip.destroy();
      body.classList.remove(NAV_HIDDEN_CLASS, "nav-narrow");
      container.replaceChildren();
    },
  };
}

export interface FocusToggleDeps {
  container: HTMLElement;
  initial: FocusMode;
  /** Asks the owner (preferences.ts) for the mode; the owner reports back
   *  through set(). The button never presses itself. */
  setFocus: (mode: FocusMode) => void;
}

export interface FocusToggle {
  set(mode: FocusMode): void;
  destroy(): void;
}

export function createFocusToggle(deps: FocusToggleDeps): FocusToggle {
  const { container } = deps;
  let mode: FocusMode = deps.initial;
  const button = document.createElement("button");
  button.id = "focus-toggle";
  button.type = "button";
  button.textContent = t("chrome.focus.label");

  const paint = (): void => {
    button.setAttribute("aria-pressed", String(mode === "paragraph"));
  };
  const onClick = (): void => {
    deps.setFocus(mode === "paragraph" ? "off" : "paragraph");
  };

  paint();
  const tooltip: Tooltip = createTooltip({
    control: button,
    name: t("chrome.focus.label"),
    hint: t("chrome.focus.hint"),
  });
  button.addEventListener("click", onClick);
  container.replaceChildren(tooltip.anchor);

  return {
    set(next: FocusMode): void {
      mode = next;
      paint();
    },
    destroy(): void {
      button.removeEventListener("click", onClick);
      tooltip.destroy();
      container.replaceChildren();
    },
  };
}
