// app/ui/src/chrome-toggles.ts
import { createIcon } from "./icons";
import { t } from "./i18n";
import { createTooltip, type Tooltip } from "./tooltip";
import type { FocusMode } from "./writing-modes";

// TWO HEADER CONTROLS, since 067. Both are buttons with aria-pressed, which
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

  const paint = (): void => {
    button.setAttribute("aria-pressed", String(!body.classList.contains(NAV_HIDDEN_CLASS)));
  };
  const onClick = (): void => {
    body.classList.toggle(NAV_HIDDEN_CLASS);
    paint();
  };

  paint();
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
      tooltip.destroy();
      body.classList.remove(NAV_HIDDEN_CLASS);
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
