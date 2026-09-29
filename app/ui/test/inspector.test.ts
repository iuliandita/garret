import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPanelShell, type PanelShell } from "../src/panel-shell";
import { openInspector, setInspectorHost, yieldInspector } from "../src/inspector";

interface Rig {
  panel: HTMLElement;
  field: HTMLInputElement;
  shell: PanelShell;
  closes: number;
  returns: number;
}

const rigs: Rig[] = [];
const uninstalls: (() => void)[] = [];

function rig(id: string, replace?: () => boolean): Rig {
  const panel = document.createElement("div");
  panel.id = id;
  panel.tabIndex = -1;
  panel.hidden = true;
  const field = document.createElement("input");
  panel.append(field);
  document.body.append(panel);
  const r: Rig = { panel, field, closes: 0, returns: 0, shell: null as unknown as PanelShell };
  r.shell = createPanelShell({
    panel,
    title: id,
    close: () => {
      r.closes += 1;
      panel.hidden = true;
    },
    returnFocus: () => {
      r.returns += 1;
    },
    inspector: replace === undefined ? true : { replace },
  });
  rigs.push(r);
  return r;
}

function host(): { rails: number; prose: HTMLButtonElement } {
  const prose = document.createElement("button");
  document.body.append(prose);
  const state = { rails: 0, prose };
  uninstalls.push(setInspectorHost({
    closeRails: () => {
      state.rails += 1;
    },
    focusProse: () => prose.focus(),
  }));
  return state;
}

/** The observer is a microtask. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function open(r: Rig): void {
  r.panel.hidden = false;
  r.field.focus();
}

afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.shell.destroy();
    r.panel.remove();
  }
  for (const u of uninstalls.splice(0)) u();
  document.body.replaceChildren();
});

describe("the inspector (241)", () => {
  test("an outside click leaves it open", async () => {
    const a = rig("a");
    open(a);
    await settle();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(a.panel.hidden).toBe(false);
  });

  test("one at a time: opening another replaces it without moving focus", async () => {
    const state = host();
    const a = rig("a");
    const b = rig("b");
    open(a);
    await settle();
    expect(document.body.dataset.inspectorOpen).toBe("true");
    open(b);
    await settle();
    expect(a.panel.hidden).toBe(true);
    expect(a.returns).toBe(0);
    expect(document.activeElement).toBe(b.field);
    expect(openInspector()).toBe(b.panel);
    // Each open cleared the column of rails.
    expect(state.rails).toBe(2);
  });

  test("a panel holding work refuses: the newcomer stands down and the holder asks", async () => {
    let refuse = true;
    const a = rig("a", () => !refuse);
    const b = rig("b");
    open(a);
    await settle();
    open(b);
    await settle();
    expect(b.panel.hidden).toBe(true);
    expect(a.panel.hidden).toBe(true);
    // The holder's close is its leave question; this one simply closes.
    expect(a.closes).toBe(1);
    refuse = false;
  });

  test("a rail takes the column: yieldInspector closes it, or refuses for held work", async () => {
    let refuse = false;
    const a = rig("a", () => {
      if (refuse) return false;
      a.panel.hidden = true;
      return true;
    });
    open(a);
    await settle();
    expect(yieldInspector()).toBe(true);
    expect(a.panel.hidden).toBe(true);
    await settle();
    expect(document.body.dataset.inspectorOpen).toBeUndefined();

    refuse = true;
    open(a);
    await settle();
    expect(yieldInspector()).toBe(false);
    expect(a.closes).toBe(1);
  });

  test("F6 moves between the prose and the open inspector, and is not taken when none is open", async () => {
    const state = host();
    const a = rig("a");
    const idle = new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true });
    document.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    open(a);
    await settle();
    state.prose.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(a.panel);
    a.panel.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(state.prose);
  });

  test("destroy undocks: a destroyed panel no longer counts as open", async () => {
    const a = rig("a");
    open(a);
    await settle();
    a.shell.destroy();
    expect(openInspector()).toBeNull();
    expect(document.body.dataset.inspectorOpen).toBeUndefined();
  });
});

describe("the stylesheet's half", () => {
  const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8");

  test("the dock is display: contents, so the open panel is the third-column grid item", () => {
    expect(css).toMatch(/#inspector-dock,\s*#inspector-dock > span \{\s*display: contents;/);
    expect(css).toMatch(/#inspector-dock \.panel-shell \{[^}]*grid-column: 3;[^}]*width: 360px;/);
  });

  test("its slide collapses under reduced motion (it outranks the shell's own rule)", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*#inspector-dock \.panel-shell,\s*#inspector-dock \.panel-shell > \* \{\s*animation: none;/,
    );
  });
});
