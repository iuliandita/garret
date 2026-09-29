// lab/bakeoff/editor-core/src/run.ts
// Page entry, bundled to dist/run.js and loaded identically by both shells.
// Loads the materialized fixture, builds a virtualized editor, replays the
// seeded workload while recording keydown->frame latency, then sinks the run.
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { bakeoffSchema, sceneToDoc } from "./schema";
import { visibleWindow } from "./virtualize";
import { buildWorkload } from "./workload";
import { createRecorder } from "./measure";
import { percentiles } from "./stats";
import type { FixtureData, SceneDoc } from "./model";
import type { Sample, SinkPayload, SoakCycle, SoakPayload } from "./bridge";

const SEED = () => window.__bakeoffSeed ?? "bakeoff-v1";
const CANDIDATE = () => window.__bakeoffCandidate ?? "unknown";

// Baked in by build.ts from BAKEOFF_SOAK_MS. 0 means the normal short run.
declare const __BAKEOFF_SOAK_MS__: number;
const SOAK_MS = typeof __BAKEOFF_SOAK_MS__ === "number" ? __BAKEOFF_SOAK_MS__ : 0;

// A/B variants, one variable each, so a latency change can be attributed.
// Both default off: with neither set the page behaves exactly as measured in
// the baseline runs.
declare const __BAKEOFF_LAZY_DOCS__: boolean;
declare const __BAKEOFF_CONTAIN_NAV__: boolean;
// Rows rendered in the navigator; 0 means all of them. The clean test of "is it
// the navigator's node count?": cap stress (~15k scenes) to the node count the
// passing normal fixture had, changing nothing else — same refs, same docs, same
// workload, same cursor. contain-nav failed to isolate this because it changed
// layout mode AND added an inline style to every row at the same time.
declare const __BAKEOFF_NAV_CAP__: number;
const NAV_CAP = typeof __BAKEOFF_NAV_CAP__ === "number" ? __BAKEOFF_NAV_CAP__ : 0;
const LAZY_DOCS = typeof __BAKEOFF_LAZY_DOCS__ === "boolean" && __BAKEOFF_LAZY_DOCS__;
const CONTAIN_NAV =
  typeof __BAKEOFF_CONTAIN_NAV__ === "boolean" && __BAKEOFF_CONTAIN_NAV__;

// lazy-docs: fetch one scene at a time instead of holding the manuscript. A miss
// is a hard failure: silently mounting an empty scene would make the variant
// look fast for the wrong reason.
//
// The cap is enforced, not assumed. Today nothing mounts outside the initial
// window so the cache would stay small on its own, but an unbounded cache that
// happens to stay small is one navigation change away from retaining the whole
// manuscript — which is the exact thing this variant exists to avoid, and it
// would quietly turn the memory result back into the baseline's.
const DOC_CACHE_MAX = 16; // comfortably above the ~5-scene mount window
const docCache = new Map<number, SceneDoc>();

async function loadDoc(index: number, data: FixtureData): Promise<SceneDoc> {
  if (!data.lazy) return data.docs[index]!;
  const hit = docCache.get(index);
  if (hit) return hit;
  const res = await fetch(`./docs/${index}.json`);
  if (!res.ok) throw new Error(`scene ${index} fetch failed: ${res.status}`);
  const doc = (await res.json()) as SceneDoc;
  docCache.set(index, doc);
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (docCache.size > DOC_CACHE_MAX) {
    const oldest = docCache.keys().next().value;
    if (oldest === undefined) break;
    docCache.delete(oldest);
  }
  return doc;
}

async function fetchFixture(): Promise<FixtureData> {
  const url = window.__bakeoffFixtureUrl ?? "./scene-data.json";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
  return (await res.json()) as FixtureData;
}

// Mount a single scene as a live EditorView inside a host element.
async function mountScene(
  host: HTMLElement,
  docIndex: number,
  data: FixtureData,
): Promise<EditorView> {
  const scene = await loadDoc(docIndex, data);
  const state = EditorState.create({ doc: sceneToDoc(scene), schema: bakeoffSchema });
  return new EditorView(host, { state });
}

async function main(): Promise<void> {
  const coldStart0 = performance.now();
  const data = await fetchFixture();

  const root = document.getElementById("app")!;
  root.innerHTML = "";

  // Virtualized stitch: estimate uniform heights, mount only the window around
  // the cursor scene. For the bake-off the cursor sits mid-project.
  //
  // Sized from `refs`, never `docs`: the two are index-aligned by construction
  // in materializeFixture, and under lazy-docs `docs` ships empty — sizing from
  // it mounts nothing and the run dies on an undefined cursor view.
  const sceneCount = data.refs.length;
  const heights = new Array<number>(sceneCount).fill(600);
  const cursorScene = Math.floor(sceneCount / 2);
  const scrollTop = cursorScene * 600;
  const win = visibleWindow(scrollTop, 900, heights, 2);

  const views = new Map<number, EditorView>();
  for (const idx of win.mounted) {
    const host = document.createElement("div");
    host.dataset.scene = data.refs[idx]?.id ?? String(idx);
    root.appendChild(host);
    views.set(idx, await mountScene(host, idx, data));
  }
  const coldStartMs = performance.now() - coldStart0;

  // Warm start: tear down and rebuild the mounted window, measuring the rebuild.
  const warm0 = performance.now();
  for (const idx of win.mounted) views.get(idx)?.destroy();
  root.innerHTML = "";
  for (const idx of win.mounted) {
    const host = document.createElement("div");
    host.dataset.scene = data.refs[idx]?.id ?? String(idx);
    root.appendChild(host);
    views.set(idx, await mountScene(host, idx, data));
  }
  const warmStartMs = performance.now() - warm0;

  const cursorView = views.get(cursorScene) ?? views.get(win.mounted[0]!)!;
  cursorView.focus();

  // Minimal scene navigator (all refs) so the AT-SPI tree exposes a navigator
  // node (PR10) and quick-open has a backing item set. Plain text divs are cheap
  // even at 2,000 items.
  const nav = document.createElement("nav");
  nav.setAttribute("role", "list");
  nav.setAttribute("aria-label", "scene navigator");
  // contain-nav variant: `contain: strict` stops the navigator's layout from
  // participating in the page's, so a growing editor cannot force relayout of
  // every row; `content-visibility: auto` lets off-screen rows skip layout
  // entirely. The workload interleaves typing with quick-open, so layout dirtied
  // by a nav action is otherwise charged to the next typing sample.
  if (CONTAIN_NAV) {
    nav.style.cssText = "contain: strict; height: 240px; overflow-y: auto;";
  }
  const navRefs = NAV_CAP > 0 ? data.refs.slice(0, NAV_CAP) : data.refs;
  for (const ref of navRefs) {
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    item.textContent = ref.title;
    // NOTE: content-visibility can also drop off-screen rows from the
    // accessibility tree. The a11y_exposure gate is what catches that, and a
    // navigator that vanishes from AT-SPI is a real cost, not a free win.
    if (CONTAIN_NAV) {
      item.style.cssText = "content-visibility: auto; contain-intrinsic-size: 0 20px;";
    }
    nav.appendChild(item);
  }
  document.body.appendChild(nav);

  // Minimal quick-open dialog so navigation has a real target and the AT-SPI
  // tree exposes a dialog node (PR10). Hidden until a nav action opens it.
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "quick open");
  dialog.setAttribute("aria-modal", "true");
  dialog.hidden = true;
  const dialogInput = document.createElement("input");
  dialogInput.setAttribute("aria-label", "quick open filter");
  dialog.appendChild(dialogInput);
  document.body.appendChild(dialog);

  const script = buildWorkload(SEED(), data.refs, {
    typingChars: 400,
    navJumps: 60,
    viewSwitches: 30,
  });
  const rec = createRecorder();

  // One pass over the seeded script. Extracted so the soak can replay it without
  // duplicating the action semantics — a soak that exercised a different code
  // path than the measured run would say nothing about the measured run.
  // Returns false when it stopped early at `until`. Without an in-cycle check a
  // soak overruns by however long one cycle takes, and a degraded cycle at
  // stress scale takes minutes — enough to blow the harness deadline and sink
  // no payload at all, losing the whole run.
  async function replay(into: Sample[], until = Infinity): Promise<boolean> {
    for (const action of script) {
      if (performance.now() >= until) return false;
      if (action.kind === "type") {
        rec.markKey();
        const { state } = cursorView;
        const tr = state.tr.insertText(action.char!, state.selection.from);
        cursorView.dispatch(tr);
        into.push({ workload: "typing", ms: await rec.settle() });
      } else {
        // Navigation: open the quick-open dialog, focus its input (a keyboard
        // jump across the 2,000-item project), then close and refocus the
        // editor. Target scenes may be unmounted by virtualization, so the
        // editor cursor stays put; the frame cost of the open/close is the
        // navigation measurement.
        rec.markKey();
        dialog.hidden = false;
        dialogInput.value = action.targetId ?? "";
        dialogInput.focus();
        dialog.hidden = true;
        cursorView.focus();
        into.push({ workload: "navigation", ms: await rec.settle() });
      }
    }
    return true;
  }

  const samples: Sample[] = [];
  await replay(samples);

  // Soak: keep replaying the same script for the requested duration. Only the
  // first pass feeds the latency gates; the soak reports per-cycle summaries so
  // the payload stays small and drift over time stays visible. Typed text is
  // never undone, so the document really does grow the way a writing session
  // grows — RSS drift and content growth are reported side by side rather than
  // one being engineered away.
  let soak: SoakPayload | undefined;
  if (SOAK_MS > 0) {
    const typedPerCycle = script.filter((a) => a.kind === "type").length;
    const soak0 = performance.now();
    const soakEnd = soak0 + SOAK_MS;
    const cycles: SoakCycle[] = [];
    let charsTyped = typedPerCycle; // the measured pass above already typed once
    while (performance.now() < soakEnd) {
      const cycleSamples: Sample[] = [];
      const complete = await replay(cycleSamples, soakEnd);
      const typed = cycleSamples.filter((s) => s.workload === "typing");
      charsTyped += typed.length;
      // A cut-short cycle is still recorded, flagged partial. Dropping it would
      // discard the slowest cycle in the run — precisely the data that shows
      // how far latency had degraded by the end.
      cycles.push({
        cycle: cycles.length + 1,
        atMs: Math.round(performance.now() - soak0),
        typingP95Ms: percentiles(typed.map((s) => s.ms)).p95,
        charsTyped,
        partial: !complete,
      });
    }
    soak = {
      requestedMs: SOAK_MS,
      actualMs: Math.round(performance.now() - soak0),
      cycles,
      charsTyped,
    };
  }

  // Expose all three required nodes (editor, navigator, dialog) for the shell's
  // post-run AT-SPI snapshot. Drop aria-modal first: a modal dialog correctly
  // makes its siblings inert to assistive tech, which would hide the navigator
  // and editor from the single exposure snapshot. Non-modal keeps all three in
  // the tree. The shell probes after the sink, then kills us.
  dialog.removeAttribute("aria-modal");
  dialog.hidden = false;

  const payload: SinkPayload = {
    candidate: CANDIDATE(),
    fixture: data.fixture,
    seed: SEED(),
    samples,
    coldStartMs,
    warmStartMs,
    soak,
  };
  if (!window.__bakeoffSink) throw new Error("no __bakeoffSink installed by shell");
  window.__bakeoffSink(payload);
}

main().catch((err) => {
  // Surface the failure to the shell so the matrix records a failed run rather
  // than hanging on a missing sink file.
  const payload: SinkPayload = {
    candidate: CANDIDATE(),
    fixture: "error",
    seed: SEED(),
    samples: [],
    coldStartMs: -1,
    warmStartMs: -1,
  };
  window.__bakeoffSink?.(payload);
  console.error("bakeoff run failed:", err);
});
