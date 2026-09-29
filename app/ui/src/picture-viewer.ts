// app/ui/src/picture-viewer.ts
// LOOKING AT A PICTURE PROPERLY, the thing this
// application could not do: "the panel shows a thumbnail bounded at 160 px of a
// cache bounded at 256 px, and nothing in the application opens the original. A
// writer who wants to look properly opens the file in their own viewer, and
// nothing tells them where it is."
//
// ONE VIEWER FOR BOTH, and that is the whole reason this is a unit rather than a
// block inside a panel. A cast photograph and a book cover are the same problem;
// two viewers would be two answers to how big "full size" is, two places to
// forget to drop the bytes on close, and two surfaces to add to the stylesheet's
// selector lists.
//
// IT NEVER HOLDS AN ORIGINAL, and neither does the process it runs in. What
// arrives is a `data:` URI of a picture the HOST has already bounded at
// `pictures::FULL_MAX` -- 1600 px on its long side, a few megabytes rather than
// the ~48 MB a 4000x3000 photograph decodes to. That bound is the founding
// memory rule and this surface is exactly where it would have been given up.
//
// THE BYTES ARE DROPPED ON CLOSE. The picture is the biggest thing this page
// ever holds, and an `<img>` left in a hidden panel holds it for the life of the
// window. `close` empties the frame rather than hiding it, which is the same
// reason the cast panel's picture block is rebuilt per state rather than shown
// and hidden.
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";

export interface PictureViewerDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** Where focus goes when the viewer is dismissed with Escape or with Close. */
  onDismiss(): void;
}

export interface PictureViewer {
  /** Paint `dataUri` under `label` and open.
   *
   *  IT TAKES A PICTURE AND NOT A STATE. A full read that came back missing or
   *  unreadable is the CALLER's to report -- through the notice surface it
   *  already uses for that member or that cover -- because an empty viewer
   *  carrying a sentence is a window a writer has to close to learn nothing. */
  show(dataUri: string, label: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createPictureViewer(deps: PictureViewerDeps): PictureViewer {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "picture-viewer";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("viewer.label"));
  // So Escape is heard before anything inside takes focus. The recorded failure
  // of the fifth panel is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;

  /** The picture's own box. EMPTIED on close rather than left holding a hidden
   *  `<img>`: this is the largest thing the page ever carries. */
  const frame = document.createElement("div");
  frame.id = "picture-viewer-frame";

  panel.append(frame);
  container.append(panel);

  let destroyed = false;

  function close(): void {
    panel.hidden = true;
    // THE BYTES GO WITH THE WINDOW. Hiding the panel would leave a megabyte or
    // two of data URI attached to a node in the document for the life of the
    // project, and a writer who looked at six pictures would be holding six.
    frame.replaceChildren();
  }

  // Close, Escape and a click elsewhere (the shell's). The click calls no
  // `onDismiss`: it has already said where the writer wants to be. The title
  // is the picture's label; Close keeps one fixed name.
  const shell = createPanelShell({
    panel,
    title: "",
    name: t("viewer.label"),
    titleId: "picture-viewer-heading",
    closeId: "picture-viewer-close",
    close,
    returnFocus: deps.onDismiss,
  });
  const heading = shell.title;

  return {
    show(dataUri: string, label: string): void {
      if (destroyed) return;
      heading.textContent = label;
      const img = document.createElement("img");
      img.id = "picture-viewer-image";
      img.src = dataUri;
      // THE SAME WORDS AS THE HEADING, not a second description. The heading
      // says whose picture this is and the image is that picture; a different
      // sentence in the alt text would be a second thing to keep in step for no
      // reader's benefit.
      img.alt = label;
      frame.replaceChildren(img);
      panel.hidden = false;
      // The PANEL, not the Close button: landing on Close would read as the
      // application suggesting the writer leave.
      panel.focus();
    },
    close,
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // THE ONE THAT MATTERS: its outside-click listener is on the document, so
      // it outlives these elements and would accumulate one per project switch.
      shell.destroy();
      container.replaceChildren();
    },
  };
}
