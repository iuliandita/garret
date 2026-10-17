import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, spyOn, test } from "bun:test";
import { createBibleCreateControl } from "../src/bible-create-control";
import { createNavigator } from "../src/navigator/index";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

test("Bible create follows the root outside recycled rows and releases its subscriptions", async () => {
  const parent = document.createElement("div");
  const container = document.createElement("div");
  parent.append(container); document.body.append(parent);
  let top = 40;
  const bounds = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const y = this.matches('[data-type="bible"]') ? top : 0;
    return { top: y, bottom: y + (this === container ? 100 : 24), left: 0, right: 320, width: 320, height: 24, x: 0, y, toJSON: () => ({}) };
  });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++nextFrame, callback); return nextFrame; });
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const add = spyOn(window, "addEventListener");
  const remove = spyOn(window, "removeEventListener");
  const disconnected = spyOn(MutationObserver.prototype, "disconnect");
  const resized = typeof ResizeObserver === "function" ? spyOn(ResizeObserver.prototype, "disconnect") : null;
  const source = { count: 2, seed: "bible-control", idAt: (i: number) => ["scene", "bible"][i]!, titleAt: (i: number) => ["Scene", "Bible"][i]!, typeAt: (i: number) => ["scene", "bible"][i]!, depthAt: () => 0 };
  const nav = createNavigator({ container, source, rowHeight: 24, overscan: 2, mode: "virtual" });
  let opened = 0;
  const control = createBibleCreateControl(container, () => { opened++; });
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  };
  try {
    await flush();
    const button = document.getElementById("bible-create")!;
    const anchor = button.parentElement!;
    expect(container.contains(button)).toBe(false);
    expect(anchor.hidden).toBe(false);
    expect(anchor.style.top).toBe("40px");
    const selected = nav.activeTitle();
    button.click();
    expect(opened).toBe(1);
    expect(nav.activeTitle()).toBe(selected);
    top = 120; container.dispatchEvent(new Event("scroll")); await flush();
    expect(anchor.hidden).toBe(true);
    top = 60; window.dispatchEvent(new Event("resize")); await flush();
    expect(anchor.style.top).toBe("60px");
    nav.reload({ ...source, count: 1 }); await flush();
    expect(anchor.hidden).toBe(true);
    nav.reload(source); await flush();
    expect(anchor.hidden).toBe(false);
    const listener = add.mock.calls.find(([event]) => event === "resize")?.[1];
    control.destroy();
    expect(disconnected.mock.calls.length).toBeGreaterThan(0);
    if (resized) expect(resized.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.some(([event, handler]) => event === "resize" && handler === listener)).toBe(true);
    button.click(); window.dispatchEvent(new Event("resize")); await flush();
    expect(opened).toBe(1);
    expect(document.getElementById("bible-create")).toBeNull();
  } finally {
    control.destroy(); nav.destroy(); parent.remove();
    resized?.mockRestore();
    disconnected.mockRestore(); remove.mockRestore(); add.mockRestore(); cancel.mockRestore(); raf.mockRestore(); bounds.mockRestore();
  }
});
