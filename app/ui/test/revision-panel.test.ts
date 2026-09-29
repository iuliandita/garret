// The panel that marks where the selected row stands.
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import {
  createRevisionPanel,
  NO_SELECTION,
  type RevisionPanelDeps,
  type SelectedRow,
  type SetStateOutcome,
  type RevisionTaskRow,
  type RevisionPassRow,
  type RevisionPlanningApi,
} from "../src/revision-panel";
import { NO_STATE_LABEL, REVISION_STATES, STATE_LABELS } from "../src/revision-states";

interface Rig {
  container: HTMLElement;
  panel: ReturnType<typeof createRevisionPanel>;
  el(): HTMLElement;
  buttons(): HTMLButtonElement[];
  button(value: string): HTMLButtonElement;
  status(): string;
  calls: { set: { id: string; state: string | null }[]; dismissed: number };
}

function mount(over: Partial<RevisionPanelDeps> = {}, row: SelectedRow | null = null): Rig {
  const container = document.createElement("span");
  document.body.append(container);
  const calls: Rig["calls"] = { set: [], dismissed: 0 };
  let selected: SelectedRow | null = row ?? {
    id: "c-1",
    title: "Chapter Seven",
    state: "draft",
  };
  const deps: RevisionPanelDeps = {
    container,
    selected: () => selected,
    setState: async (itemId, state): Promise<SetStateOutcome> => {
      calls.set.push({ id: itemId, state });
      // The real dep re-reads the walk before it resolves, so the panel's next
      // paint sees the new state. A fake that did not would let a panel that
      // never repaints pass every test here.
      if (selected !== null) selected = { ...selected, state };
      return "applied";
    },
    onDismiss: () => {
      calls.dismissed += 1;
    },
    ...over,
  };
  const panel = createRevisionPanel(deps);
  const el = (): HTMLElement => {
    const found = container.querySelector<HTMLElement>("#state-panel");
    if (found === null) throw new Error("the panel is not in the container");
    return found;
  };
  return {
    container,
    panel,
    calls,
    el,
    buttons: () => [...el().querySelectorAll<HTMLButtonElement>("[data-state-value]")],
    button: (value: string) => {
      const found = el().querySelector<HTMLButtonElement>(`[data-state-value="${value}"]`);
      if (found === null) throw new Error(`no button for ${value || "(none)"}`);
      return found;
    },
    status: () => el().querySelector<HTMLElement>("#state-status")?.textContent ?? "",
  };
}

/** Drain the microtask queue past an async dep and its `.then`.
 *
 *  A TIMER, not a run of `await Promise.resolve()`. An async function wrapping a
 *  promise adds ticks of its own, so counting them is guesswork - and a test
 *  that guesses too few asserts about a panel that has not repainted yet, which
 *  passes for every implementation including none. That is exactly how the
 *  stale-answer test below survived its own mutation. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function teardown(rig: Rig): void {
  rig.panel.destroy();
  rig.container.remove();
}

describe("what the panel offers", () => {
  test("one button per state plus the absence, in the manuscript's order", () => {
    const rig = mount();
    try {
      const values = rig.buttons().map((b) => b.dataset.stateValue);
      expect(values).toEqual([...REVISION_STATES, ""]);
      const labels = rig.buttons().map((b) => b.textContent);
      for (const state of REVISION_STATES) {
        expect(labels.some((l) => l?.includes(STATE_LABELS[state]))).toBe(true);
      }
      expect(labels.at(-1)).toContain(NO_STATE_LABEL);
    } finally {
      teardown(rig);
    }
  });

  test("it opens hidden and stays hidden until asked", () => {
    const rig = mount();
    try {
      expect(rig.el().hidden).toBe(true);
      expect(rig.panel.isOpen()).toBe(false);
      rig.panel.open();
      expect(rig.el().hidden).toBe(false);
      expect(rig.panel.isOpen()).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("the row's current state is the pressed one, and only it", () => {
    // aria-pressed on EVERY button rather than a class on the chosen one: "which
    // of these is in effect" is exactly what a toggle button's pressed state
    // means, and a class says it to nobody.
    const rig = mount();
    try {
      rig.panel.open();
      const pressed = rig
        .buttons()
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.dataset.stateValue);
      expect(pressed).toEqual(["draft"]);
    } finally {
      teardown(rig);
    }
  });

  test("a row with no state presses the absence, not nothing", () => {
    // Otherwise the panel shows five unpressed buttons for a row that IS in a
    // state - the default one - and a writer cannot tell that from a panel that
    // failed to read the row.
    const rig = mount({}, { id: "c-1", title: "Chapter Seven", state: null });
    try {
      rig.panel.open();
      expect(rig.button("").getAttribute("aria-pressed")).toBe("true");
    } finally {
      teardown(rig);
    }
  });

  test("the status names the row it will act on", () => {
    const rig = mount();
    try {
      rig.panel.open();
      expect(rig.status()).toBe("Chapter Seven");
    } finally {
      teardown(rig);
    }
  });

  test("the selection is read at every OPEN, never captured", () => {
    // The writer moves the selection between opening the panel and pressing a
    // button - an arrow key still reaches the navigator with the panel up - and
    // a captured row would mark one they are no longer looking at.
    let row: SelectedRow = { id: "a", title: "First", state: null };
    const rig = mount({ selected: () => row });
    try {
      rig.panel.open();
      expect(rig.status()).toBe("First");
      row = { id: "b", title: "Second", state: "done" };
      rig.panel.open();
      expect(rig.status()).toBe("Second");
      expect(rig.button("done").getAttribute("aria-pressed")).toBe("true");
    } finally {
      teardown(rig);
    }
  });
});

describe("revision planning", () => {
  function planningRig() {
    let selected: SelectedRow | null = { id: "one", title: "First scene", state: null };
    const passes: RevisionPassRow[] = [{ id: 7, name: "Structure", purpose: null, open_count: 1, done_count: 0 }];
    const tasks: RevisionTaskRow[] = [{ id: 11, body: "Fix turn", item_id: "one", target_caption: "First scene",
      target_title: "First scene", binned: false, pass_id: 7, done: false }];
    const created: Array<{ body: string; itemId: string | null; passId: number | null }> = [];
    let fail = false;
    let pendingCreate: Promise<void> | null = null;
    let releaseCreate: (() => void) | null = null;
    const api: RevisionPlanningApi = {
      passes: async () => passes.map((p) => ({ ...p })),
      tasks: async () => tasks.map((t) => ({ ...t })),
      createPass: async (name, purpose) => { passes.push({ id: 8, name, purpose, open_count: 0, done_count: 0 }); },
      updatePass: async (id, name, purpose) => { Object.assign(passes.find((p) => p.id === id)!, { name, purpose }); },
      deletePass: async (id) => { passes.splice(passes.findIndex((p) => p.id === id), 1); tasks.forEach((t) => { if (t.pass_id === id) t.pass_id = null; }); },
      createTask: async (body, itemId, passId) => {
        if (pendingCreate !== null) await pendingCreate;
        if (fail) throw new Error("offline");
        created.push({ body, itemId, passId });
        tasks.push({ id: 12, body, item_id: itemId, target_caption: null, target_title: null, binned: false, pass_id: passId, done: false });
      },
      updateTask: async (id, body, passId) => { Object.assign(tasks.find((t) => t.id === id)!, { body, pass_id: passId }); },
      setDone: async (id, done) => { tasks.find((t) => t.id === id)!.done = done; },
      deleteTask: async (id) => { tasks.splice(tasks.findIndex((t) => t.id === id), 1); },
    };
    const rig = mount({ selected: () => selected, planning: api });
    return { rig, passes, tasks, created, select: (row: SelectedRow | null) => { selected = row; },
      fail: (value: boolean) => { fail = value; },
      deferCreate: () => { pendingCreate = new Promise<void>((resolve) => { releaseCreate = resolve; }); },
      releaseCreate: () => { releaseCreate?.(); pendingCreate = null; },
    };
  }

  test("a failed draft keeps its text and original item through selection and pass changes", async () => {
    const p = planningRig();
    try {
      p.rig.panel.open();
      await settle();
      const scope = p.rig.el().querySelector<HTMLSelectElement>("#planning-scope")!;
      scope.value = "selected";
      scope.dispatchEvent(new Event("change"));
      const body = p.rig.el().querySelector<HTMLTextAreaElement>("#planning-task-body")!;
      body.value = "Strengthen the ending";
      body.dispatchEvent(new Event("input"));
      p.select({ id: "two", title: "Second scene", state: null });
      const pass = p.rig.el().querySelector<HTMLSelectElement>("#planning-pass-filter")!;
      pass.value = "7";
      pass.dispatchEvent(new Event("change"));
      p.fail(true);
      [...p.rig.el().querySelectorAll<HTMLButtonElement>("#revision-planning button")]
        .find((b) => b.textContent === "Save task")!.click();
      await settle();
      expect(body.value).toBe("Strengthen the ending");
      expect(p.rig.el().querySelector("#planning-message")?.textContent).toContain("offline");
      p.fail(false);
      [...p.rig.el().querySelectorAll<HTMLButtonElement>("#revision-planning button")]
        .find((b) => b.textContent === "Save task")!.click();
      await settle();
      expect(p.created).toEqual([{ body: "Strengthen the ending", itemId: "one", passId: null }]);
    } finally { teardown(p.rig); }
  });

  test("removing a pass keeps its tasks ungrouped and task removal requires two presses", async () => {
    const p = planningRig();
    try {
      p.rig.panel.open();
      await settle();
      const scope = p.rig.el().querySelector<HTMLSelectElement>("#planning-scope")!;
      scope.value = "all"; scope.dispatchEvent(new Event("change"));
      const pass = p.rig.el().querySelector<HTMLSelectElement>("#planning-pass-filter")!;
      pass.value = "7"; pass.dispatchEvent(new Event("change"));
      const removePass = [...p.rig.el().querySelectorAll<HTMLButtonElement>("#revision-planning button")]
        .find((b) => b.textContent === "Remove pass")!;
      removePass.click();
      expect(p.passes).toHaveLength(1);
      removePass.click();
      await settle();
      expect(p.tasks[0]?.pass_id).toBeNull();
      expect(p.rig.el().querySelector(".planning-task")?.textContent).toContain("Fix turn");
      const removeTask = [...p.rig.el().querySelectorAll<HTMLButtonElement>(".planning-task button")]
        .find((b) => b.textContent === "Remove")!;
      removeTask.click();
      expect(p.tasks).toHaveLength(1);
      p.rig.el().querySelector<HTMLButtonElement>(".planning-task button:last-child")!.click();
      await settle();
      expect(p.tasks).toHaveLength(0);
    } finally { teardown(p.rig); }
  });

  test("a pending save cannot duplicate a task or clear typing added while it waits", async () => {
    const p = planningRig();
    try {
      p.rig.panel.open(); await settle();
      p.deferCreate();
      const body = p.rig.el().querySelector<HTMLTextAreaElement>("#planning-task-body")!;
      const save = [...p.rig.el().querySelectorAll<HTMLButtonElement>("#revision-planning button")]
        .find((b) => b.textContent === "Save task")!;
      body.value = "First version"; body.dispatchEvent(new Event("input"));
      save.click();
      expect(save.disabled).toBe(true);
      save.click();
      body.value = "Second version"; body.dispatchEvent(new Event("input"));
      p.releaseCreate(); await settle();
      expect(p.created).toEqual([{ body: "First version", itemId: null, passId: null }]);
      expect(body.value).toBe("Second version");
      expect(save.disabled).toBe(false);
    } finally { teardown(p.rig); }
  });

  test("a pass draft survives blur, task refresh, and filter change and saves to its original pass", async () => {
    const p = planningRig();
    p.passes.push({ id: 8, name: "Line edit", purpose: null, open_count: 0, done_count: 0 });
    try {
      p.rig.panel.open(); await settle();
      const filter = p.rig.el().querySelector<HTMLSelectElement>("#planning-pass-filter")!;
      filter.value = "7"; filter.dispatchEvent(new Event("change"));
      const name = p.rig.el().querySelector<HTMLInputElement>("#planning-pass-name")!;
      name.value = "Structure revised"; name.dispatchEvent(new Event("input"));
      name.blur();
      filter.value = "8"; filter.dispatchEvent(new Event("change"));
      expect(p.rig.el().querySelector("#planning-pass-draft-target")?.textContent).toContain("Structure");
      filter.value = "all"; filter.dispatchEvent(new Event("change"));
      const scope = p.rig.el().querySelector<HTMLSelectElement>("#planning-scope")!;
      scope.value = "all"; scope.dispatchEvent(new Event("change"));
      p.rig.el().querySelector<HTMLButtonElement>(".planning-task [data-action=done]")!.click();
      await settle();
      expect(name.value).toBe("Structure revised");
      [...p.rig.el().querySelectorAll<HTMLButtonElement>("#revision-planning button")]
        .find((b) => b.textContent === "Save pass")!.click();
      await settle();
      expect(p.passes.find((pass) => pass.id === 7)?.name).toBe("Structure revised");
      expect(p.passes.find((pass) => pass.id === 8)?.name).toBe("Line edit");
    } finally { teardown(p.rig); }
  });

  test("task editing refuses to replace an unsaved draft, and completion retains button focus", async () => {
    const p = planningRig();
    try {
      p.rig.panel.open(); await settle();
      const scope = p.rig.el().querySelector<HTMLSelectElement>("#planning-scope")!;
      scope.value = "all"; scope.dispatchEvent(new Event("change"));
      const body = p.rig.el().querySelector<HTMLTextAreaElement>("#planning-task-body")!;
      body.value = "My draft"; body.dispatchEvent(new Event("input"));
      p.rig.el().querySelector<HTMLButtonElement>(".planning-task [data-action=edit]")!.click();
      expect(body.value).toBe("My draft");
      expect(p.rig.el().querySelector("#planning-message")?.textContent).toContain("discard");
      [...p.rig.el().querySelectorAll<HTMLButtonElement>("#revision-planning button")]
        .find((b) => b.textContent === "Discard draft")!.click();
      p.rig.el().querySelector<HTMLButtonElement>(".planning-task [data-action=edit]")!.click();
      body.value = "Changed text"; body.dispatchEvent(new Event("input"));
      p.rig.el().querySelector<HTMLButtonElement>(".planning-task [data-action=edit]")!.click();
      expect(body.value).toBe("Changed text");
      const done = p.rig.el().querySelector<HTMLButtonElement>(".planning-task [data-action=done]")!;
      done.focus(); done.click(); await settle();
      const replacement = p.rig.el().querySelector<HTMLButtonElement>(".planning-task [data-action=done]")!;
      expect(document.activeElement).toBe(replacement);
      expect(replacement.textContent).toBe("Reopen");
    } finally { teardown(p.rig); }
  });
});

describe("with nothing selected", () => {
  test("it says so and every button is disabled", () => {
    // Its own sentence, distinct from a failure and from a state of `none`:
    // three different things a reader acts differently on.
    const rig = mount({ selected: () => null });
    try {
      rig.panel.open();
      expect(rig.status()).toBe(NO_SELECTION);
      for (const button of rig.buttons()) expect(button.disabled).toBe(true);
      // Nothing pressed either: a pressed button with no row would claim the
      // manuscript stands somewhere.
      expect(rig.buttons().every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("a click that arrives after the selection left says why", () => {
    // Reachable only between a paint and a click, and the alternative is a
    // control that does nothing and does not say why - the recorded empty-query
    // defect in two other panels.
    let row: SelectedRow | null = { id: "a", title: "First", state: null };
    const rig = mount({ selected: () => row });
    try {
      rig.panel.open();
      row = null;
      rig.button("done").click();
      expect(rig.status()).toBe(NO_SELECTION);
      expect(rig.calls.set.length).toBe(0);
    } finally {
      teardown(rig);
    }
  });
});

describe("setting a state", () => {
  test("a click sends the state for the selected row", async () => {
    const rig = mount();
    try {
      rig.panel.open();
      rig.button("done").click();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.calls.set).toEqual([{ id: "c-1", state: "done" }]);
    } finally {
      teardown(rig);
    }
  });

  test("the absence sends null, never the word", async () => {
    // The whole of the absent-default decision, at the one place the page could
    // spell it as a value.
    const rig = mount();
    try {
      rig.panel.open();
      rig.button("").click();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.calls.set).toEqual([{ id: "c-1", state: null }]);
    } finally {
      teardown(rig);
    }
  });

  test("the panel repaints on the answer, and the button survives it", async () => {
    // REPAINTED BY ATTRIBUTE, never rebuilt. Rebuilding would destroy the button
    // the writer just pressed and drop focus to <body> - the recorded history
    // panel defect, where a writer who then typed reached nothing at all.
    const rig = mount();
    try {
      rig.panel.open();
      const button = rig.button("done");
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.button("done")).toBe(button);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(rig.button("draft").getAttribute("aria-pressed")).toBe("false");
    } finally {
      teardown(rig);
    }
  });

  test("a refusal is reported in the panel and nothing is claimed", async () => {
    const rig = mount({ setState: async () => "failed" });
    try {
      rig.panel.open();
      rig.button("done").click();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.status()).toContain("could not");
      // And the row is still shown standing where it stood.
      expect(rig.button("draft").getAttribute("aria-pressed")).toBe("true");
    } finally {
      teardown(rig);
    }
  });

  test("a rejected promise is reported too, not swallowed", async () => {
    const rig = mount({
      setState: async () => {
        throw new Error("boom");
      },
    });
    try {
      rig.panel.open();
      rig.button("done").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(rig.status()).toContain("could not");
    } finally {
      teardown(rig);
    }
  });

  test("an answer that lands after a newer press does not repaint", async () => {
    // THE ASSERTION IS POSITIVE, and it has to be. The first version asserted
    // the status did NOT hold the failure message, which is equally true of a
    // panel that has not repainted at all - so it survived the mutation that
    // deletes the generation check outright. Here the NEWER press is the one
    // that failed, so the correct panel shows the failure and the mutant paints
    // the row title over it.
    const resolvers: ((outcome: SetStateOutcome) => void)[] = [];
    const rig = mount({
      setState: async () =>
        new Promise<SetStateOutcome>((resolve) => {
          resolvers.push(resolve);
        }),
    });
    try {
      rig.panel.open();
      rig.button("done").click();
      rig.button("outline").click();
      resolvers[1]?.("failed");
      resolvers[0]?.("applied");
      await settle();
      expect(rig.status()).toContain("could not");
    } finally {
      teardown(rig);
    }
  });

  test("an answer that lands after destroy does not paint into a dead panel", async () => {
    // WITH ITS OWN CONTROL, in the same test so it cannot be forgotten. "the
    // status does not hold the failure" is equally true of a panel that never
    // repainted, so the second half proves the same sequence DOES repaint when
    // the panel is alive - which is what makes the first half mean anything.
    const answer = async (destroyFirst: boolean): Promise<string> => {
      let resolve: ((outcome: SetStateOutcome) => void) | null = null;
      const rig = mount({
        setState: async () =>
          new Promise<SetStateOutcome>((r) => {
            resolve = r;
          }),
      });
      rig.panel.open();
      rig.button("done").click();
      const status = rig.el().querySelector<HTMLElement>("#state-status");
      if (destroyFirst) teardown(rig);
      (resolve as ((outcome: SetStateOutcome) => void) | null)?.("failed");
      await settle();
      const seen = status?.textContent ?? "";
      if (!destroyFirst) teardown(rig);
      return seen;
    };

    expect(await answer(false)).toContain("could not");
    expect(await answer(true)).not.toContain("could not");
  });
});

describe("dismissing it", () => {
  test("Escape closes and hands focus back", () => {
    const rig = mount();
    try {
      rig.panel.open();
      rig.el().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(rig.panel.isOpen()).toBe(false);
      expect(rig.calls.dismissed).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("another key does nothing", () => {
    const rig = mount();
    try {
      rig.panel.open();
      rig.el().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(rig.panel.isOpen()).toBe(true);
      expect(rig.calls.dismissed).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("a click outside closes it, and does NOT move focus", () => {
    // Escape moves focus because the writer asked to leave; a click already says
    // where they want to be. The fifth panel shipped with no outside-click
    // handler at all and a writer who clicked into their prose could not dismiss
    // it, because Escape only fires while focus is inside the panel.
    const rig = mount();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      rig.panel.open();
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rig.panel.isOpen()).toBe(false);
      expect(rig.calls.dismissed).toBe(0);
    } finally {
      outside.remove();
      teardown(rig);
    }
  });

  test("destroy removes the panel and unregisters the document listener", () => {
    // The recorded menu-bar shape that only COUNTING finds: a leaked
    // capture-phase document handler changes no DOM state and no behaviour a
    // test can reach, while accumulating one live closure per project switch.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const rig = mount();
      rig.panel.open();
      teardown(rig);
      expect(added.sort()).toEqual(removed.sort());
      expect(document.querySelector("#state-panel") === null).toBe(true);
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });
});
