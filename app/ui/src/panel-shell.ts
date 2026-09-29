// app/ui/src/panel-shell.ts
// The frame every anchored panel shares: a header with the title, an
// optional one-line subtitle and a Close icon, the body, an optional footer
// for actions, and the three dismissals.
//
// THE PANEL KEEPS WHAT IT OWNS. Its element, id, role, aria attributes and
// position are the caller's: rigs find panels by id and name through AT-SPI,
// and every `top: 100%` rule hangs off #project-bar by id. The shell adds
// children and listeners and nothing else, so the visible title never
// becomes the accessible name by accident (aria-label stays authoritative).
//
// CLOSE IS THE LAST TAB STOP, drawn in the header's corner. Panels take focus
// on themselves when they open, and rigs (shot-cli, history-cli, pictures-cli
// and others) then Tab to reach the first control; a Close first in the DOM
// would take that press and dismiss the panel. Content first for the keyboard
// too: the writer opened the panel to use it, not to leave it.
//
// THREE DISMISSALS, ONE PLACE. Close and Escape hand focus back through
// `returnFocus`; an outside click does not (dismiss-outside.ts says why). An
// inspector has the first two only: it sits beside the prose.
// Escape is heard in the BUBBLE phase and skips an event something inside
// already took (`defaultPrevented`): a field that collapses its own edit, or a
// menu inside the panel, answers first, and only a plain Escape closes.
//
// THE ENTER MOTION IS THE STYLESHEET'S. `.panel-shell` runs a keyframe
// animation, and `hidden` is `display: none`, which ends a running animation
// and restarts it when the element renders again. No class toggling, no
// timer, nothing to clean up, and leaving is instant by construction.
import { closeOnOutsideClick } from "./dismiss-outside";
import { isCompositionKey } from "./composition-key";
import { createIcon } from "./icons";
import { t } from "./i18n";
import { dockInspector } from "./inspector";

export interface PanelShellOptions {
  /** The panel element, already carrying its id, role and aria. */
  panel: HTMLElement;
  /** What the header shows. */
  title: string;
  /** Names Close ("Close {name}") where the visible title changes with what
   *  the panel is about, so the control's name stays one fixed string. */
  name?: string;
  /** An id the title keeps from before the shell (tests and aria point at it). */
  titleId?: string;
  subtitle?: string;
  /** An id the Close control keeps from before the shell. */
  closeId?: string;
  /** Build the footer strip for this panel's actions (primary rightmost). */
  footer?: boolean;
  /** Defaults to `!panel.hidden`. */
  isOpen?: () => boolean;
  /** The panel's own close. Called by Close, Escape and an outside click. */
  close: () => void;
  /** Where the keyboard goes after Close or Escape. */
  returnFocus?: () => void;
  /** false for the one surface a click in the prose must leave open. */
  outsideClick?: boolean;
  /** Docks the panel as the inspector (see inspector.ts): no outside-click
   *  close, since clicking the prose beside it is the point, and one at a
   *  time in the column the rails share. `replace` is how another inspector
   *  or a rail takes the column without moving focus; false refuses, and the
   *  panel's own close asks instead. Without it, `close` replaces. */
  inspector?: boolean | { replace(): boolean };
}

export interface PanelShell {
  readonly header: HTMLElement;
  readonly title: HTMLHeadingElement;
  readonly subtitle: HTMLParagraphElement;
  readonly closeButton: HTMLButtonElement;
  readonly body: HTMLDivElement;
  readonly footer: HTMLDivElement | null;
  setTitle(text: string): void;
  /** Null or empty hides the line rather than leaving an empty gap. */
  setSubtitle(text: string | null): void;
  destroy(): void;
}

export function createPanelShell(options: PanelShellOptions): PanelShell {
  const { panel } = options;
  const doc = panel.ownerDocument;
  panel.classList.add("panel-shell");

  const header = doc.createElement("div");
  header.className = "panel-header";
  const heading = doc.createElement("div");
  heading.className = "panel-heading";
  const title = doc.createElement("h2");
  title.className = "panel-title";
  if (options.titleId !== undefined) title.id = options.titleId;
  title.textContent = options.title;
  const subtitle = doc.createElement("p");
  subtitle.className = "panel-subtitle";
  heading.append(title, subtitle);

  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "panel-close";
  if (options.closeId !== undefined) closeButton.id = options.closeId;
  closeButton.dataset.weight = "quiet";
  closeButton.setAttribute("aria-label", t("panel.close", { title: options.name ?? options.title }));
  closeButton.append(createIcon("x"));
  header.append(heading);

  const body = doc.createElement("div");
  body.className = "panel-body";
  let footer: HTMLDivElement | null = null;
  if (options.footer === true) {
    footer = doc.createElement("div");
    footer.className = "panel-footer";
  }
  // PREPENDED AND APPENDED around whatever the panel already holds, so a unit
  // that built its children first loses nothing; new content goes in `body`.
  const existing = [...panel.childNodes];
  body.append(...existing);
  panel.append(header, body);
  if (footer !== null) panel.append(footer);
  panel.append(closeButton);

  function setSubtitle(text: string | null): void {
    subtitle.textContent = text ?? "";
    subtitle.hidden = text === null || text === "";
  }
  setSubtitle(options.subtitle ?? null);

  const isOpen = options.isOpen ?? ((): boolean => !panel.hidden);
  function dismiss(): void {
    options.close();
    options.returnFocus?.();
  }

  const onClose = (): void => {
    dismiss();
  };
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!isOpen()) return;
    event.preventDefault();
    dismiss();
  };
  closeButton.addEventListener("click", onClose);
  panel.addEventListener("keydown", onKeyDown);
  const inspector = options.inspector ?? false;
  const stopOutsideClick = options.outsideClick === false || inspector !== false
    ? (): void => undefined
    : closeOnOutsideClick(panel, isOpen, options.close, doc);
  const undock = inspector === false
    ? (): void => undefined
    : dockInspector(panel, {
        close: options.close,
        ...(inspector === true ? {} : { replace: inspector.replace }),
      });

  let destroyed = false;
  return {
    header,
    title,
    subtitle,
    closeButton,
    body,
    footer,
    setTitle(text: string): void {
      title.textContent = text;
    },
    setSubtitle,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      closeButton.removeEventListener("click", onClose);
      panel.removeEventListener("keydown", onKeyDown);
      // The one on the DOCUMENT, which outlives the panel's own elements.
      stopOutsideClick();
      undock();
    },
  };
}
