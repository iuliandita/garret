import { describe, expect, test } from "bun:test";
import type { EditSourceChange } from "../src/edit-source";
import { createSession, type SessionDeps } from "../src/session";

interface Recorded {
  dirty: { itemId: string; body: string; change?: EditSourceChange }[];
  drains: number;
}

/** The fake is typed as the real dependency, with no cast. That matters: the
 *  dependency is Pick<FlushScheduler, "markDirty" | "drain" | "register" |
 *  "failed">, so `settled` is not reachable from inside the session at all.
 *  "flushPending must not call settled" is therefore enforced by the compiler
 *  rather than by a spy. Document switching widened that Pick and the guarantee
 *  still holds: `settled` is not among the four. */
function fakes(body = '{"type":"doc"}'): { rec: Recorded; deps: SessionDeps } {
  const rec: Recorded = { dirty: [], drains: 0 };
  const deps: SessionDeps = {
    editor: { serialize: () => body, replaceDoc: () => {} },
    flusher: {
      markDirty: (itemId: string, b: string, change?: EditSourceChange) => {
        const entry: Recorded["dirty"][number] = { itemId, body: b };
        if (change !== undefined) entry.change = change;
        rec.dirty.push(entry);
      },
      drain: async () => {
        rec.drains++;
      },
      register: () => {},
      failed: () => false,
    },
    loadDoc: async () => ({ body: '{"type":"doc"}', rev: 1 }),
    docId: "scene-1",
  };
  return { rec, deps };
}

describe("createSession", () => {
  test("noteChange marks the active document dirty with the serialized body", () => {
    const { rec, deps } = fakes('{"type":"doc","content":[]}');
    createSession(deps).noteChange();
    expect(rec.dirty).toEqual([{ itemId: "scene-1", body: '{"type":"doc","content":[]}' }]);
  });

  test("noteChange re-serializes on every call rather than caching", () => {
    const rec: Recorded = { dirty: [], drains: 0 };
    let n = 0;
    const session = createSession({
      editor: { serialize: () => `body-${++n}`, replaceDoc: () => {} },
      flusher: {
        markDirty: (itemId: string, body: string) => {
          rec.dirty.push({ itemId, body });
        },
        drain: async () => {
          rec.drains++;
        },
        register: () => {},
        failed: () => false,
      },
      loadDoc: async () => ({ body: '{"type":"doc"}', rev: 1 }),
      docId: "scene-1",
    });
    session.noteChange();
    session.noteChange();
    expect(rec.dirty.map((d) => d.body)).toEqual(["body-1", "body-2"]);
  });

  test("noteChange forwards source ownership with the active body", () => {
    const { rec, deps } = fakes('{"type":"doc","content":[]}');
    createSession(deps).noteChange({ source: "pasted", beforeWords: 4 });
    expect(rec.dirty).toEqual([
      {
        itemId: "scene-1",
        body: '{"type":"doc","content":[]}',
        change: { source: "pasted", beforeWords: 4 },
      },
    ]);
  });

  test("noteChange does not serialize hidden prose while a timeline is active", async () => {
    const { rec, deps } = fakes();
    let serializations = 0;
    deps.editor.serialize = () => { serializations++; return "hidden prose"; };
    deps.isTimelineDoc = (id) => id === "timeline-1";
    deps.loadDoc = async () => ({ body: '{"kind":"timeline"}', rev: 3 });
    const session = createSession(deps);
    expect(await session.switchTo("timeline-1")).toBe("switched");
    serializations = 0;
    session.noteChange({ source: "typing" });
    expect(serializations).toBe(0);
    expect(rec.dirty).toEqual([]);
  });

  test("flushPending drains", async () => {
    // drain() clears an armed debounce timer and fires it; settled() abandons
    // it. Getting this wrong loses the last edit before a quit, which is the
    // exact defect the persistence slice's restart check caught.
    const { rec, deps } = fakes();
    await createSession(deps).flushPending();
    expect(rec.drains).toBe(1);
  });

  test("flushPending drains even when nothing is dirty", async () => {
    // A no-op fast path would be indistinguishable from a lost timer.
    const { rec, deps } = fakes();
    await createSession(deps).flushPending();
    expect(rec.drains).toBe(1);
  });
});
