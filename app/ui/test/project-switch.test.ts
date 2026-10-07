import { describe, expect, test } from "bun:test";
import {
  createProjectSwitcher,
  type ProjectSwitchDeps,
  type ProjectSwitchOutcome,
  type ProjectOpenDecision,
  type SwitchableProject,
} from "../src/project-switch";
import { splitHostDetail } from "../src/command-error";
import { CLOSE_EVENT, wireLifecycle, type LifecycleDeps } from "../src/lifecycle";

/** The minimum the switcher is allowed to read. Typing the fakes as this rather
 *  than as a real MountedProject is the point: a switcher that reached for the
 *  navigator, the editor or the flusher's write surface would not compile
 *  against it. */
interface FakeProject extends SwitchableProject {
  readonly label: string;
}

interface Rig {
  log: string[];
  failed: { value: boolean };
  /** Held open so a test can start a switch and inspect the log mid-flight. */
  openResult: { value: Promise<{ path: string; name: string; generation: number }> | null };
  mountResult: { value: Promise<FakeProject> | null };
  setCurrentCalls: FakeProject[];
  failures: string[];
  closedFailures: boolean[];
  flushRejects: { value: boolean };
  currentProject(): FakeProject;
  switchTo(path: string, name?: string): Promise<ProjectSwitchOutcome>;
}

function rig(opts: {
  startPath?: string;
  prepareOpen?: ProjectSwitchDeps<FakeProject>["prepareOpen"];
  openedWith?: (decision: ProjectOpenDecision | undefined) => void;
} = {}): Rig {
  const log: string[] = [];
  const failed = { value: false };
  const openResult: Rig["openResult"] = { value: null };
  const mountResult: Rig["mountResult"] = { value: null };
  const setCurrentCalls: FakeProject[] = [];
  const failures: string[] = [];
  const closedFailures: boolean[] = [];

  let path = opts.startPath ?? "/p/a.db";
  const flushRejects = { value: false };
  let current: FakeProject = {
    label: "a",
    session: {
      flushPending: async () => {
        log.push("flushPending");
        if (flushRejects.value) throw new Error("the store stopped answering");
      },
    },
    flusher: { failed: () => failed.value },
    destroy: () => {
      log.push("destroy");
    },
  };

  const deps: ProjectSwitchDeps<FakeProject> = {
    current: () => current,
    setCurrent: (next) => {
      setCurrentCalls.push(next);
      current = next;
    },
    currentPath: () => path,
    prepareOpen: opts.prepareOpen,
    openProject: async (p, decision) => {
      opts.openedWith?.(decision);
      log.push(`openProject:${p}`);
      if (openResult.value !== null) return openResult.value;
      path = p;
      return { path: p, name: "b", generation: 7 };
    },
    mount: async (generation) => {
      log.push(`mount:${generation}`);
      if (mountResult.value !== null) return mountResult.value;
      return {
        label: `mounted:${generation}`,
        session: { flushPending: async () => {} },
        flusher: { failed: () => false },
        destroy: () => {},
      };
    },
    onSwitched: (opened) => {
      log.push(`onSwitched:${opened.path}`);
    },
    onFailure: (message, closed) => {
      failures.push(message);
      closedFailures.push(closed);
    },
  };

  const switchTo = createProjectSwitcher(deps);
  return {
    log,
    failed,
    openResult,
    mountResult,
    setCurrentCalls,
    failures,
    closedFailures,
    flushRejects,
    currentProject: () => current,
    switchTo,
  };
}

describe("createProjectSwitcher", () => {
  test("a review draft can cancel a book switch before any teardown", async () => {
    const r = rig();
    let mayLeave = false;
    let releases = 0;
    r.currentProject().prepareToLeave = async () => mayLeave;
    r.currentProject().cancelLeave = () => { releases++; };
    expect(await r.switchTo("/p/b.db")).toBe("cancelled");
    expect(r.log).toEqual([]);
    expect(releases).toBe(0);
    mayLeave = true;
    expect(await r.switchTo("/p/b.db")).toBe("switched");
    expect(releases).toBe(0);
  });

  test("a failed manuscript drain releases a prepared review departure", async () => {
    const r = rig();
    let releases = 0;
    r.currentProject().prepareToLeave = async () => true;
    r.currentProject().cancelLeave = () => { releases++; };
    r.flushRejects.value = true;
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.log).toEqual(["flushPending"]);
    expect(releases).toBe(1);
  });

  test("a busy close cannot release an overlapping book switch's departure hold", async () => {
    const r = rig(); r.flushRejects.value = true;
    let started!: () => void; let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const prepared = new Promise<void>((resolve) => { finish = resolve; });
    let held = false; let releases = 0;
    const prepare = async (): Promise<boolean> => {
      if (held) return false;
      held = true; started(); await prepared; return true;
    };
    const cancel = (): void => { held = false; releases++; };
    r.currentProject().prepareToLeave = prepare;
    r.currentProject().cancelLeave = cancel;
    let close!: (event?: { payload: number }) => void | Promise<void>;
    const deps: LifecycleDeps = {
      session: { flushPending: async () => {}, failed: () => false, dirtyCount: () => 0 },
      drafts: { pending: () => true, prepareClose: prepare, cancelClose: cancel },
      invoke: async () => undefined,
      listen: async (event, cb) => { if (event === CLOSE_EVENT) close = cb; },
      addWindowListener: () => {}, addDocumentListener: () => {}, isHidden: () => false,
    };
    await wireLifecycle(deps);
    const switching = r.switchTo("/p/b.db"); await entered;
    await close({ payload: 2 });
    expect(held).toBe(true);
    expect(releases).toBe(0);
    finish();
    expect(await switching).toBe("failed");
    expect(releases).toBe(1);
    expect(held).toBe(false);
  });

  test("cancelling copied-book choice leaves the current project untouched", async () => {
    let cancel = true;
    const r = rig({ prepareOpen: async () => cancel ? null : undefined });
    expect(await r.switchTo("/p/copy.db")).toBe("cancelled");
    expect(r.log).toEqual([]);
    expect(r.currentProject().label).toBe("a");
    expect(r.failures).toEqual([]);
    cancel = false;
    expect(await r.switchTo("/p/copy.db")).toBe("switched");
  });

  test("waits for the choice before flushing and forwards that exact choice", async () => {
    let release!: (decision: ProjectOpenDecision) => void;
    let received: ProjectOpenDecision | undefined;
    const r = rig({
      prepareOpen: () => new Promise((resolve) => { release = resolve; }),
      openedWith: (decision) => { received = decision; },
    });
    const pending = r.switchTo("/p/copy.db");
    expect(r.log).toEqual([]);
    expect(await r.switchTo("/p/other.db")).toBe("busy");
    const decision: ProjectOpenDecision = {
      bookId: "0123456789abcdef0123456789abcdef",
      canonicalPath: "/p/a.db",
      kind: "separate",
    };
    release(decision);
    expect(await pending).toBe("switched");
    expect(received).toBe(decision);
    expect(r.log.slice(0, 3)).toEqual(["flushPending", "destroy", "openProject:/p/copy.db"]);
  });

  test("failed copied-book preflight keeps the current project and permits retry", async () => {
    let fail = true;
    const r = rig({ prepareOpen: async () => {
      if (fail) throw new Error("cannot read the candidate");
      return undefined;
    } });
    expect(await r.switchTo("/p/copy.db")).toBe("failed");
    expect(r.log).toEqual([]);
    expect(r.failures[0]).toContain("still open");
    expect(r.closedFailures).toEqual([false]);
    fail = false;
    expect(await r.switchTo("/p/copy.db")).toBe("switched");
  });

  test("flushes, destroys, opens and mounts in that exact order", async () => {
    // The order is the invariant, not the end state. doc_flush carries item ids
    // and base_rev values that only mean something in the project they came
    // from, and both projects in the graded rig are seeded from the same
    // generator - so `it-000013` exists in both files. A flush still in flight
    // across the swap lands on a real row in the wrong manuscript.
    const r = rig();
    expect(await r.switchTo("/p/b.db")).toBe("switched");
    expect(r.log).toEqual([
      "flushPending",
      "destroy",
      "openProject:/p/b.db",
      "mount:7",
      "onSwitched:/p/b.db",
    ]);
  });

  test("switching to the open project is `same` and touches nothing", async () => {
    const r = rig();
    expect(await r.switchTo("/p/a.db")).toBe("same");
    expect(r.log).toEqual([]);
    expect(r.setCurrentCalls).toEqual([]);
  });

  test("a switch during a switch is `busy` and opens nothing", async () => {
    const r = rig();
    let release: (v: { path: string; name: string; generation: number }) => void = () => {};
    r.openResult.value = new Promise((resolve) => {
      release = resolve;
    });
    const first = r.switchTo("/p/b.db");
    const second = await r.switchTo("/p/c.db");
    expect(second).toBe("busy");
    release({ path: "/p/b.db", name: "b", generation: 7 });
    expect(await first).toBe("switched");
    expect(r.log.filter((l) => l.startsWith("openProject:"))).toEqual(["openProject:/p/b.db"]);
  });

  test("a failed flusher refuses the switch and destroys nothing", async () => {
    // Autosave is broken and the banner is already up. Tearing the project down
    // now puts the unsaved text out of reach with no way back to it.
    const r = rig();
    r.failed.value = true;
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.log).toEqual(["flushPending"]);
    expect(r.setCurrentCalls).toEqual([]);
  });

  test("a rejecting openProject fails loudly and says nothing is open", async () => {
    // The old project is already destroyed at this point and cannot be brought
    // back, so the message has to state that plainly rather than read as a
    // retryable hiccup.
    const r = rig();
    r.openResult.value = Promise.reject(new Error("no such project"));
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.setCurrentCalls).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/nothing is open/i);
    expect(r.closedFailures).toEqual([true]);
  });

  test("a rejecting mount fails loudly", async () => {
    const r = rig();
    r.mountResult.value = Promise.reject(new Error("mount blew up"));
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.setCurrentCalls).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/nothing is open/i);
    expect(r.closedFailures).toEqual([true]);
  });

  test("a failed switch releases the busy guard", async () => {
    const r = rig();
    r.mountResult.value = Promise.reject(new Error("boom"));
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    r.mountResult.value = null;
    expect(await r.switchTo("/p/c.db")).toBe("switched");
  });

  test("setCurrent is called exactly once, with the mounted project", async () => {
    const r = rig();
    expect(await r.switchTo("/p/b.db")).toBe("switched");
    expect(r.setCurrentCalls).toHaveLength(1);
    expect(r.setCurrentCalls[0]?.label).toBe("mounted:7");
    expect(r.currentProject().label).toBe("mounted:7");
  });
});

describe("createProjectSwitcher failure messages", () => {
  // The teardown is irreversible, so the message must not claim it happened
  // when it did not. A writer told their project was closed while it is still
  // on screen learns to distrust every message after it.
  test("a rejection before the teardown says the project is still open", async () => {
    const r = rig();
    r.flushRejects.value = true;
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.log).toEqual(["flushPending"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("still open");
    expect(r.closedFailures).toEqual([false]);
  });

  test("a rejection after the teardown says nothing is open", async () => {
    const r = rig();
    r.openResult.value = Promise.reject(new Error("no such project"));
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.log).toEqual(["flushPending", "destroy", "openProject:/p/b.db"]);
    expect(r.failures[0]).toMatch(/nothing is open/i);
    const message = splitHostDetail(r.failures[0]!);
    expect(message.headline).toContain("the selected book");
    expect(message.headline).not.toContain("/p/b.db");
    expect(message.detail).toContain("/p/b.db");
    expect(r.closedFailures).toEqual([true]);
  });
});

describe("createProjectSwitcher onSwitched", () => {
  test("fires after setCurrent, and only on success", async () => {
    const r = rig();
    expect(await r.switchTo("/p/b.db")).toBe("switched");
    expect(r.log).toEqual([
      "flushPending",
      "destroy",
      "openProject:/p/b.db",
      "mount:7",
      "onSwitched:/p/b.db",
    ]);
  });

  test("does NOT fire when the mount fails", async () => {
    // The caller records "which project is open" from this. Firing it on a
    // failed mount would name a project that is not open: the header would show
    // it and the `same` check would swallow every retry, with no way back
    // except picking a third project.
    const r = rig();
    r.mountResult.value = Promise.reject(new Error("no scene"));
    expect(await r.switchTo("/p/b.db")).toBe("failed");
    expect(r.log.some((l) => l.startsWith("onSwitched"))).toBe(false);
  });
});

test("a failed named book keeps its path behind Details", async () => {
  const r = rig();
  const path = "/a/very/long/books/folder/manuscript.db";
  r.flushRejects.value = true;
  expect(await r.switchTo(path, "Pride and Prejudice")).toBe("failed");
  const message = splitHostDetail(r.failures[0]!);
  expect(message.headline).toContain("Pride and Prejudice");
  expect(message.headline).not.toContain(path);
  expect(message.detail).toContain(path);
  expect(message.detail).toContain("the store stopped answering");
});
