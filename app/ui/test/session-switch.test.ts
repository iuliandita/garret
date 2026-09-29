import { t } from "../src/i18n";
import { describe, expect, test } from "bun:test";
import { createSession, type Session, type SessionDeps } from "../src/session";
import type { DocInput } from "../src/editor";
import { createFlushScheduler, type FlushEntry } from "../src/store/flush";

const BODY_OF = (id: string): string =>
  JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: id }] }] });

interface Rig {
  log: string[];
  dirty: { itemId: string; body: string }[];
  failed: { value: boolean };
  loadResult: { value: Promise<{ body: string; rev: number }> | null };
  /** The editor rejecting a document it cannot build. Mutable so a test can
   *  clear it and switch again against the same session. */
  throwOnReplace: { value: boolean };
  session: Session;
}

/** The session is built inside the rig because the fake editor has to be able
 *  to ask it a question. `replaceDoc@<id>` is the whole ordering assertion: it
 *  records which document the session considered open AT THE MOMENT the swap
 *  ran. Moving `docId = itemId` after `editor.replaceDoc(...)` turns
 *  `replaceDoc@scene-b` into `replaceDoc@scene-a`, and no end-state assertion
 *  can see that difference. */
function rig(
  opts: {
    startId?: string;
    replaceDocThrows?: boolean;
    isTimelineDoc?: (itemId: string) => boolean;
    onTimelineDoc?: (itemId: string, body: string) => void;
  } = {},
): Rig {
  const startId = opts.startId ?? "scene-a";
  const log: string[] = [];
  const dirty: { itemId: string; body: string }[] = [];
  const failed = { value: false };
  const loadResult: Rig["loadResult"] = { value: null };
  const throwOnReplace = { value: opts.replaceDocThrows === true };
  let serialized = "body-of-scene-a";
  let session!: Session;

  const deps: SessionDeps = {
    editor: {
      serialize: () => serialized,
      replaceDoc: (_input: DocInput) => {
        log.push(`replaceDoc@${session.activeDocId()}`);
        if (throwOnReplace.value) throw new Error("cannot build a document from this body");
        serialized = "body-after-replace";
      },
    },
    flusher: {
      markDirty: (itemId, body) => {
        dirty.push({ itemId, body });
      },
      drain: async () => {
        log.push("drain");
      },
      register: (itemId, rev) => {
        log.push(`register:${itemId}:${rev}`);
      },
      failed: () => failed.value,
    },
    loadDoc: async (itemId) => {
      log.push(`load:${itemId}`);
      if (loadResult.value !== null) return loadResult.value;
      return { body: BODY_OF(itemId), rev: 7 };
    },
    docId: startId,
    isTimelineDoc: opts.isTimelineDoc,
    onTimelineDoc: (itemId, body) => {
      log.push(`onTimelineDoc@${itemId}`);
      opts.onTimelineDoc?.(itemId, body);
    },
  };
  session = createSession(deps);
  return { log, dirty, failed, loadResult, throwOnReplace, session };
}

describe("session.switchTo", () => {
  test("captures the final outgoing bytes after a late edit and before the identity swap", async () => {
    let current = "first draft";
    let releaseLoad: (value: { body: string; rev: number }) => void = () => undefined;
    const loaded = new Promise<{ body: string; rev: number }>((resolve) => { releaseLoad = resolve; });
    const events: string[] = [];
    const saved: string[] = [];
    const session = createSession({
      docId: "scene-a",
      editor: { serialize: () => current, replaceDoc: () => { events.push("replace"); current = "second scene"; } },
      flusher: {
        markDirty: (_id, value) => { saved.push(value); },
        drain: async () => { events.push("drain"); },
        failed: () => false,
        register: () => { events.push("register"); },
      },
      loadDoc: async () => loaded,
      beforeSwap: (id, value) => { events.push(`snapshot:${id}:${value}`); },
    });
    const switching = session.switchTo("scene-b");
    await Promise.resolve();
    current = "late edit";
    session.noteChange();
    releaseLoad({ body: BODY_OF("scene-b"), rev: 1 });
    expect(await switching).toBe("switched");
    expect(saved).toEqual(["late edit"]);
    expect(events).toEqual(["drain", "drain", "snapshot:scene-a:late edit", "register", "replace"]);
  });
  test("runs drain, load, register and the swap in that exact order", async () => {
    // The order is the invariant, not the end state. Several wrong orderings
    // produce the same final activeDocId, and one of them - setting the id
    // after replaceDoc - writes the outgoing document's body under the
    // incoming document's id on the next keystroke.
    const r = rig();
    expect(await r.session.switchTo("scene-b")).toBe("switched");
    expect(r.log).toEqual(["drain", "load:scene-b", "drain", "register:scene-b:7", "replaceDoc@scene-b"]);
  });

  test("noteChange marks the new id after the switch and the old id before it", async () => {
    const r = rig();
    r.session.noteChange();
    await r.session.switchTo("scene-b");
    r.session.noteChange();
    expect(r.dirty.map((d) => d.itemId)).toEqual(["scene-a", "scene-b"]);
  });

  test("activeDocId reports the open document", async () => {
    const r = rig();
    expect(r.session.activeDocId()).toBe("scene-a");
    await r.session.switchTo("scene-b");
    expect(r.session.activeDocId()).toBe("scene-b");
  });

  test("switching to the open document is `same` and does not drain", async () => {
    // A click on the already-open row must not cost a store round trip.
    const r = rig();
    expect(await r.session.switchTo("scene-a")).toBe("same");
    expect(r.log).toEqual([]);
  });

  test("a switch during a switch is `busy` and loads nothing", async () => {
    const r = rig();
    let release: (v: { body: string; rev: number }) => void = () => {};
    r.loadResult.value = new Promise((resolve) => {
      release = resolve;
    });
    const first = r.session.switchTo("scene-b");
    const second = await r.session.switchTo("scene-c");
    expect(second).toBe("busy");
    release({ body: BODY_OF("scene-b"), rev: 7 });
    expect(await first).toBe("switched");
    expect(r.log.filter((l) => l.startsWith("load:"))).toEqual(["load:scene-b"]);
  });

  test("a failed flusher after the drain refuses the switch", async () => {
    // Autosave is broken and the failure banner is already up. Swapping
    // documents now would put the unsaved text out of reach with no way back.
    const r = rig();
    r.failed.value = true;
    expect(await r.session.switchTo("scene-b")).toMatchObject({
      kind: "failed",
      reason: t("session.save-refused"),
    });
    expect(r.log).toEqual(["drain"]);
    expect(r.session.activeDocId()).toBe("scene-a");
  });

  test("a rejecting loadDoc leaves the open document alone", async () => {
    const r = rig();
    r.loadResult.value = Promise.reject(new Error("no document for item scene-b"));
    expect(await r.session.switchTo("scene-b")).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("no document for item scene-b"),
    });
    expect(r.session.activeDocId()).toBe("scene-a");
    expect(r.log.some((l) => l.startsWith("replaceDoc"))).toBe(false);
  });

  test("a failed switch releases the busy guard", async () => {
    const r = rig();
    r.loadResult.value = Promise.reject(new Error("boom"));
    expect(await r.session.switchTo("scene-b")).toMatchObject({ kind: "failed" });
    r.loadResult.value = null;
    expect(await r.session.switchTo("scene-b")).toBe("switched");
  });
});

describe("session.switchTo on a body it cannot load", () => {
  // doc.body is the only untrusted input in switchTo. A throw between the id
  // assignment and a completed swap leaves docId naming the incoming document
  // while the editor still holds the outgoing one - and noteChange reads both,
  // so every later keystroke flushes the old document's prose under the new
  // document's id, permanently, with the editor looking entirely normal.
  test("a malformed body leaves the open document alone", async () => {
    const r = rig();
    r.loadResult.value = Promise.resolve({ body: "{not json", rev: 7 });
    const outcome = await r.session.switchTo("scene-b");
    expect(outcome).toMatchObject({ kind: "failed" });
    // The reason must be the parse failure, not a generic "could not switch" -
    // otherwise a writer whose scene is damaged on disk gets no more
    // information than before this reason field existed.
    if (typeof outcome === "object") expect(outcome.reason).toMatch(/JSON/i);
    expect(r.session.activeDocId()).toBe("scene-a");
    r.session.noteChange();
    expect(r.dirty.at(-1)?.itemId).toBe("scene-a");
  });

  test("a replaceDoc that throws leaves the open document alone", async () => {
    // The JSON parses but the editor rejects it: a body written by a schema
    // this build does not have. The parse guard above cannot catch this one.
    const r = rig({ replaceDocThrows: true });
    expect(await r.session.switchTo("scene-b")).toMatchObject({ kind: "failed" });
    expect(r.session.activeDocId()).toBe("scene-a");
    r.session.noteChange();
    expect(r.dirty.at(-1)?.itemId).toBe("scene-a");
  });

  test("a switch that failed on the swap does not wedge the busy guard", async () => {
    const r = rig({ replaceDocThrows: true });
    expect(await r.session.switchTo("scene-b")).toMatchObject({ kind: "failed" });
    r.throwOnReplace.value = false;
    expect(await r.session.switchTo("scene-b")).toBe("switched");
  });
});

describe("session.switchTo, the second document kind", () => {
  test("a timeline id runs drain, load, register and onTimelineDoc, never replaceDoc", async () => {
    const r = rig({ isTimelineDoc: (id) => id === "timeline-1" });
    expect(await r.session.switchTo("timeline-1")).toBe("switched");
    expect(r.log).toEqual(["drain", "load:timeline-1", "drain", "register:timeline-1:7", "onTimelineDoc@timeline-1"]);
    expect(r.log.some((l) => l.startsWith("replaceDoc"))).toBe(false);
    expect(r.session.activeDocId()).toBe("timeline-1");
  });

  test("onTimelineDoc receives the RAW body, never JSON.parsed as PmNodeJson", async () => {
    const received: { value: string | null } = { value: null };
    const r = rig({
      isTimelineDoc: (id) => id === "timeline-1",
      onTimelineDoc: (_id, body) => {
        received.value = body;
      },
    });
    await r.session.switchTo("timeline-1");
    expect(received.value).toBe(BODY_OF("timeline-1"));
  });

  test("switching from a timeline back to a scene calls replaceDoc, not onTimelineDoc", async () => {
    const r = rig({ isTimelineDoc: (id) => id === "timeline-1" });
    await r.session.switchTo("timeline-1");
    r.log.length = 0;
    expect(await r.session.switchTo("scene-b")).toBe("switched");
    expect(r.log).toEqual(["drain", "load:scene-b", "drain", "register:scene-b:7", "replaceDoc@scene-b"]);
  });

  // Mutation target 4's own shape at the session boundary: a body this
  // build's parser would call `newer`/`invalid` still reaches onTimelineDoc
  // unparsed here -- session.ts never inspects it, so there is nothing this
  // layer could refuse. The caller (timeline-view.ts's own mount) is what
  // renders it read-only and never flushes it, tested in timeline-view.test.ts.
  test("an unparseable body for a timeline id does not throw", async () => {
    const r = rig({ isTimelineDoc: (id) => id === "timeline-1" });
    r.loadResult.value = Promise.resolve({ body: "{not json", rev: 7 });
    expect(await r.session.switchTo("timeline-1")).toBe("switched");
  });
});


describe("edits while the next document loads", () => {
  for (const refuseWrite of [false, true]) {
    test(refuseWrite ? "a late save failure preserves the outgoing editor" : "late prose and comment positions land together before the swap", async () => {
      let body = BODY_OF("old prose");
      let anchors = [{ id: 1, from: 1, to: 4 }];
      let session!: Session;
      let finishLoad!: (doc: { body: string; rev: number }) => void;
      let startedLoad!: () => void;
      const loading = new Promise<void>((resolve) => { startedLoad = resolve; });
      const loaded = new Promise<{ body: string; rev: number }>((resolve) => { finishLoad = resolve; });
      const writes: FlushEntry[] = [];
      let swaps = 0;
      const flusher = createFlushScheduler({
        setTimer: () => 1,
        clearTimer: () => {},
        commentsOf: (id) => id === session.activeDocId() ? anchors.map((anchor) => ({ ...anchor })) : undefined,
        invoke: async (entries) => {
          expect(session.activeDocId()).toBe("scene-a");
          expect(swaps).toBe(0);
          if (refuseWrite) throw new Error("disk full");
          writes.push(...entries);
          return entries.map((entry) => ({ item_id: entry.item_id, rev: entry.base_rev + 1 }));
        },
      });
      flusher.register("scene-a", 2);
      session = createSession({
        docId: "scene-a", flusher,
        editor: {
          serialize: () => body,
          replaceDoc: () => { swaps++; body = BODY_OF("incoming"); anchors = []; },
        },
        loadDoc: () => { startedLoad(); return loaded; },
      });
      const switching = session.switchTo("scene-b");
      await loading;
      body = BODY_OF("late old prose");
      anchors = [{ id: 1, from: 6, to: 9 }];
      session.noteChange();
      finishLoad({ body: BODY_OF("incoming"), rev: 3 });
      const outcome = await switching;
      if (refuseWrite) {
        expect(outcome).toMatchObject({ kind: "failed", reason: t("session.late-save-refused") });
        expect(session.activeDocId()).toBe("scene-a");
        expect(body).toBe(BODY_OF("late old prose"));
        expect(anchors).toEqual([{ id: 1, from: 6, to: 9 }]);
        expect(swaps).toBe(0);
      } else {
        expect(outcome).toBe("switched");
        expect(writes).toEqual([{ item_id: "scene-a", base_rev: 2, body: BODY_OF("late old prose"), comments: [{ id: 1, from: 6, to: 9 }] }]);
        expect(session.activeDocId()).toBe("scene-b");
        expect(swaps).toBe(1);
        expect(flusher.dirtyCount()).toBe(0);
      }
      flusher.stop();
    });
  }
});
