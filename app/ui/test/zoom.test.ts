import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  DEFAULT_ZOOM,
  ZOOMS,
  installZoomKeys,
  isZoom,
  stepZoom,
  zoomActionFor,
  zoomFrom,
  type Zoom,
} from "../src/zoom";

describe("zoom words", () => {
  test("five words, 100 first, and the default is 100", () => {
    expect(ZOOMS).toEqual(["100", "125", "150", "175", "200"]);
    expect(DEFAULT_ZOOM).toBe("100");
  });

  test("what the host injected is narrowed, never trusted", () => {
    expect(zoomFrom("150")).toBe("150");
    expect(zoomFrom("110")).toBe("100");
    expect(zoomFrom(undefined)).toBe("100");
    expect(zoomFrom(150)).toBe("100");
    expect(isZoom("200")).toBe(true);
    expect(isZoom("2")).toBe(false);
  });

  test("stepping clamps at both ends rather than wrapping", () => {
    expect(stepZoom("100", 1)).toBe("125");
    expect(stepZoom("200", 1)).toBe("200");
    expect(stepZoom("100", -1)).toBe("100");
    expect(stepZoom("175", -1)).toBe("150");
  });
});

describe("zoom keys", () => {
  const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
    new KeyboardEvent("keydown", { key: k, ctrlKey: true, cancelable: true, ...init });

  test("Ctrl+= and Ctrl++ step in, Ctrl+- steps out, Ctrl+0 resets", () => {
    expect(zoomActionFor(key("="))).toBe("in");
    expect(zoomActionFor(key("+", { shiftKey: true }))).toBe("in");
    expect(zoomActionFor(key("-"))).toBe("out");
    expect(zoomActionFor(key("0"))).toBe("reset");
  });

  test("without Ctrl, or with Alt, it is the writer's keystroke", () => {
    expect(zoomActionFor(key("=", { ctrlKey: false }))).toBeNull();
    expect(zoomActionFor(key("0", { altKey: true }))).toBeNull();
    expect(zoomActionFor(key("z"))).toBeNull();
  });

  test("installed on a document, a chord changes the zoom once and is consumed", () => {
    const set: string[] = [];
    let current: Zoom = "125";
    const stop = installZoomKeys(document, {
      current: () => current,
      set: (z) => {
        current = z;
        set.push(z);
      },
    });
    const e = key("-");
    document.dispatchEvent(e);
    expect(set).toEqual(["100"]);
    expect(e.defaultPrevented).toBe(true);
    document.dispatchEvent(key("0"));
    expect(set).toEqual(["100"]); // already 100: no call, nothing to persist
    stop();
    document.dispatchEvent(key("="));
    expect(set).toEqual(["100"]);
  });

  test("a held chord is consumed once, not stepped per autorepeat tick", () => {
    const set: string[] = [];
    let current: Zoom = "125";
    installZoomKeys(document, {
      current: () => current,
      set: (z) => {
        current = z;
        set.push(z);
      },
    });
    const e = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      repeat: true,
      cancelable: true,
    });
    document.dispatchEvent(e);
    expect(set).toEqual([]);
    // Consumed anyway: it is the writer's chord, held, and nothing else on the
    // page should react to it either.
    expect(e.defaultPrevented).toBe(true);
  });
});
