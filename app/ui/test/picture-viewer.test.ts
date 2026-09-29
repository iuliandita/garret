import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPictureViewer, type PictureViewer } from "../src/picture-viewer";

interface Rig {
  viewer: PictureViewer;
  container: HTMLElement;
  dismissals: number;
}

const rigs: Rig[] = [];

const URI = "data:image/png;base64,AAAA";

function rig(): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = { viewer: undefined as unknown as PictureViewer, container, dismissals: 0 };
  r.viewer = createPictureViewer({
    container,
    onDismiss: () => {
      r.dismissals += 1;
    },
  });
  rigs.push(r);
  return r;
}

afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.viewer.destroy();
    r.container.remove();
  }
});

const panel = (): HTMLElement => document.getElementById("picture-viewer") as HTMLElement;
const image = (): HTMLImageElement | null =>
  document.getElementById("picture-viewer-image") as HTMLImageElement | null;

describe("the shared full-size viewer", () => {
  test("it starts hidden and holds no picture", () => {
    rig();
    expect(panel().hidden).toBe(true);
    expect(image()).toBe(null);
  });

  test("showing paints the picture and the label and opens", () => {
    const r = rig();

    r.viewer.show(URI, "Front cover");

    expect(r.viewer.isOpen()).toBe(true);
    expect(image()?.getAttribute("src")).toBe(URI);
    expect(document.getElementById("picture-viewer-heading")?.textContent).toBe("Front cover");
    // THE SAME WORDS as the heading: the heading says whose picture this is and
    // the image is that picture, so a second description would be a second
    // thing to keep in step for no reader's benefit.
    expect(image()?.getAttribute("alt")).toBe("Front cover");
  });

  test("closing DROPS THE BYTES rather than hiding them", () => {
    // THE POINT OF THE UNIT. A full-size picture is the largest thing this page
    // ever holds -- the host bounds it at 1600px on its long side, which is
    // still megabytes -- and an `<img>` left in a hidden panel holds it for the
    // life of the window. A writer who looked at six pictures would be holding
    // six. `panel.hidden = true` alone passes every other test in this file.
    const r = rig();
    r.viewer.show(URI, "Front cover");

    r.viewer.close();

    expect(r.viewer.isOpen()).toBe(false);
    expect(image()).toBe(null);
    expect(panel().textContent).not.toContain(URI);
  });

  test("a second picture replaces the first rather than stacking", () => {
    const r = rig();
    r.viewer.show(URI, "Front cover");

    r.viewer.show("data:image/png;base64,BBBB", "Back cover");

    expect(document.querySelectorAll("#picture-viewer img").length).toBe(1);
    expect(image()?.getAttribute("src")).toBe("data:image/png;base64,BBBB");
  });

  test("Escape closes it and hands focus back", () => {
    const r = rig();
    r.viewer.show(URI, "Front cover");

    panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(r.viewer.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);
  });

  test("Close closes it and hands focus back", () => {
    const r = rig();
    r.viewer.show(URI, "Front cover");

    (document.getElementById("picture-viewer-close") as HTMLButtonElement).click();

    expect(r.viewer.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);
    expect(image()).toBe(null);
  });

  test("a click outside closes it and does NOT move focus", () => {
    // `dismiss-outside.ts`'s recorded rule: a click has already said where the
    // writer wants to be, unlike Escape.
    const r = rig();
    r.viewer.show(URI, "Front cover");

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(r.viewer.isOpen()).toBe(false);
    expect(r.dismissals).toBe(0);
  });

  test("a key that is not Escape leaves it open", () => {
    // The control for the Escape test: a handler that closed on any key would
    // satisfy that one.
    const r = rig();
    r.viewer.show(URI, "Front cover");

    panel().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

    expect(r.viewer.isOpen()).toBe(true);
    expect(r.dismissals).toBe(0);
  });

  test("showing after destroy does nothing", () => {
    const r = rig();
    r.viewer.destroy();

    r.viewer.show(URI, "Front cover");

    expect(document.getElementById("picture-viewer")).toBe(null);
  });

  test("destroy unregisters the document listener it bound", () => {
    // COUNTED, not observed: the outside-click handler returns immediately when
    // the viewer is hidden, so leaking it changes no DOM state and no behaviour
    // a test can reach -- while accumulating one live closure per project
    // switch. The recorded menu-bar defect, in another unit.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const r = rig();
      r.viewer.destroy();
      expect(added.length).toBeGreaterThan(0);
      expect(removed.sort()).toEqual(added.sort());
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });
});
