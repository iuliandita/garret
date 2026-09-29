import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { mountProject, type MountDeps, type MountedProject } from "../src/project";
import type { FlushEntry } from "../src/store/flush";
import type { ProjectItem } from "../src/store/source";

interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

const body = (text: string): string =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

/** A depth-first walk: part-0 > chapter-0 > scene-0, scene-1. The first row is
 *  a part on purpose - the mount must skip it and open the first SCENE. */
function walk(): ProjectItem[] {
  return [
    { id: "part-0", parent_id: null, type: "part", title: "Part One", position: "0000", rev: 1, state: null, depth: 0 },
    { id: "chapter-0", parent_id: "part-0", type: "chapter", title: "One", position: "0000", rev: 1, state: null, depth: 1 },
    { id: "scene-0", parent_id: "chapter-0", type: "scene", title: "Arrival", position: "0000", rev: 1, state: null, depth: 2 },
    { id: "scene-1", parent_id: "chapter-0", type: "scene", title: "Departure", position: "0001", rev: 1, state: null, depth: 2 },
  ];
}

interface Host {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  calls: Call[];
  of: (cmd: string) => Call[];
  /** The entries of every doc_flush, flattened. */
  flushed: () => FlushEntry[];
}

interface HostOpts {
  items?: ProjectItem[];
  docRev?: number;
  /** Successive project_items answers. The boot walk is [0]; every outline
   *  mutation re-reads and takes the next one, so a test can make the store's
   *  tree actually change under the navigator. The last entry repeats. */
  walks?: ProjectItem[][];
  /** Commands that reject instead of answering. */
  reject?: readonly string[];
  /** Per-item document bodies. Every other item answers with the one-word
   *  default, so a test only names the scenes whose text it cares about. */
  bodies?: Record<string, string>;
  /** Per-item comment rows. Every other item answers with none. */
  comments?: Record<string, unknown[]>;
  /** The readable folder's change set. Empty by default: the mirror is off for
   *  every project until a writer turns it on, so an empty answer is what the
   *  shipped path produces for all but one of them. */
  mirrorRows?: unknown[];
  /** Per-item synopsis rows. Every other item answers with null, which is what
   *  the host sends for a row nobody has written about. */
  synopses?: Record<string, { body: string } | null>;
  /** The book's cast, for the cast panel and both appearance panels. Empty by
   *  default, which is the state every new project is in. */
  cast?: unknown[];
  /** Every tag in the project, by item id. Empty by default. */
  appearances?: Record<string, string[]>;
  /** What archive_status and mirror_status answer. Absent by default, and an
   *  absent answer REJECTS: the fixture predates both surfaces, every test so
   *  far took the negative each indicator opens on, and a content answer here
   *  would turn the status dot quiet under tests that never asked about it. */
  archive?: unknown;
  mirror?: unknown;
  /** Past states of the open scene, for the history panel. */
  versions?: unknown[];
  /** Whole-manuscript snapshots, for the history panel. */
  snapshots?: unknown[];
  /** `doc_restore`'s answer body, overriding the fixture's own
   *  `body("restored")` -- a timeline test needs a body that is never
   *  ProseMirror JSON, which the default never is. */
  restoreBody?: string;
  /** `mirror_accept`'s answer document body, overriding the fixture's own
   *  `body("taken in")`, for the same reason. */
  mirrorAcceptBody?: string;
  /** Whether this book's saved words are being measured. Collecting by
   *  default; the pause and reset commands move the host's copy. */
  collecting?: boolean;
}

/** What project_progress answers, once per ask. A moving number rather than a
 *  constant: a display that asked once at mount and never again would render the
 *  right figure forever against a fixed answer. */
const WORD_COUNT_STEP = 100;

/** The only seam to the host. Records everything so a test can assert on what
 *  was sent, not merely on what the page believes it sent. */
function host(opts: HostOpts = {}): Host {
  const calls: Call[] = [];
  const items = opts.items ?? walk();
  // Comment mutations update the host's stored rows. Copy each fixture row so a
  // resolve in one test cannot turn a later test's seed into resolved-only.
  const comments = Object.fromEntries(
    Object.entries(opts.comments ?? {}).map(([itemId, rows]) => [
      itemId,
      rows.map((row) => ({ ...(row as Record<string, unknown>) })),
    ]),
  );
  const docRev = opts.docRev ?? 7;
  const reject = new Set(opts.reject ?? []);
  let read = 0;
  let counted = 0;
  let collecting = opts.collecting ?? true;
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args });
    if (reject.has(cmd)) throw new Error(`${cmd} refused`);
    // The total AND the day, from one call, which is what the bar takes.
    // `today` is a fixed slice of it rather than another moving number: the
    // tests here are about whether the page asks and repaints, and a second
    // moving figure would make a stale reading look like a fresh one.
    if (cmd === "project_progress") return { total: ++counted * WORD_COUNT_STEP, today: 40 };
    if (cmd === "project_items") {
      if (opts.walks === undefined) return items;
      const at = Math.min(read, opts.walks.length - 1);
      read++;
      return opts.walks[at];
    }
    if (cmd === "doc_load") {
      const itemId = String(args?.itemId ?? "");
      return { body: opts.bodies?.[itemId] ?? body("alpha"), rev: docRev };
    }
    if (cmd === "doc_flush") {
      const entries = (args?.entries ?? []) as FlushEntry[];
      return entries.map((e) => ({ item_id: e.item_id, rev: e.base_rev + 1 }));
    }
    // The outline commands. The page never reads their return: every mutation is
    // command -> project_items -> reload, so the fresh walk is the only answer
    // that matters.
    // The store answers a create with the row it made, and the outline takes
    // the created id from THAT answer (never from a walk diff), so a fixture
    // that returned `{}` here silently disabled every onCreated path.
    if (cmd === "item_create") return { id: "scene-2", position: "0002", rev: 1, doc_rev: 1 };
    if (
      cmd === "item_rename" ||
      cmd === "item_move" ||
      cmd === "item_set_state"
    ) {
      return {};
    }
    // Every document open reads its notes. An empty list is the fixture's
    // ordinary answer; a test that wants rows overrides it.
    if (cmd === "comment_list") return comments[String(args?.itemId ?? "")] ?? [];
    if (cmd === "comment_set_resolved") {
      const id = Number(args?.id);
      for (const rows of Object.values(comments)) {
        const row = rows.find((candidate) => (candidate as { id?: number }).id === id) as
          | { resolved: boolean }
          | undefined;
        if (row !== undefined) row.resolved = args?.resolved === true;
      }
      return {};
    }
    // The synopsis. `null` is the fixture's ordinary answer: nobody has written
    // one, which is what every row in a fresh manuscript looks like.
    if (cmd === "synopsis_get") return opts.synopses?.[String(args?.itemId ?? "")] ?? null;
    if (cmd === "synopsis_set") return null;
    if (cmd === "project_export") return { path: "/exports/test.md" };
    // The recovery surface. The two times DISAGREE on purpose: the manifest's
    // newest verified point is five minutes old and the last attempt is one
    // minute old, so a page reading the attempt time for the verified one is
    // visible here rather than passing on a fixture where they coincide.
    if (cmd === "recovery_status") {
      const now = Date.now();
      return {
        slug: "project",
        status: {
          last_attempt_ms: now - 60_000,
          last_attempt_ok: true,
          last_error: null,
          last_verified_ms: now - 5 * 60_000,
          consecutive_failures: 0,
        },
        newest_verified_ms: now - 5 * 60_000,
        verified_points: 2,
      };
    }
    if (cmd === "project_backup_now") return { id: "2026-08-21T00-00-00Z", verified: true };
    if (cmd === "archive_status" && opts.archive !== undefined) return opts.archive;
    if (cmd === "mirror_status" && opts.mirror !== undefined) return opts.mirror;
    // The history panel. `doc_restore` answers with a body DIFFERENT from the
    // one doc_load gives, so a test can tell a restored document from the one
    // that was already open.
    if (cmd === "doc_versions") return opts.versions ?? [];
    if (cmd === "doc_restore") return { rev: docRev + 1, body: opts.restoreBody ?? body("restored") };
    if (cmd === "snapshot_list") return opts.snapshots ?? [];
    // The readable folder's change set and the accept it now offers.
    if (cmd === "mirror_changes") return opts.mirrorRows ?? [];
    if (cmd === "mirror_accept") {
      const ids = (args?.ids ?? []) as string[];
      return {
        report: {
          documents: ids.map((id) => ({ item_id: id, rev: docRev + 1, body: opts.mirrorAcceptBody ?? body("taken in"), version_id: 10 })),
          snapshot: {
            id: 9,
            label: "Before accepting 1 change from the readable folder",
            created_at: 0,
            documents: 4,
          },
          net_words: 2,
        },
        paths: ids.map(() => "0000-One/0000-Arrival.md"),
        underlined: 0,
      };
    }
    if (cmd === "mirror_undo_accept") return { rev: docRev + 2, body: body("undone") };
    if (cmd === "writing_time_today") return 0;
    if (cmd === "project_document_counts") return {};
    if (cmd === "project_source_words") {
      return {
        available: true, collecting, interrupted: false, started_at: 0, today_typing: 0, warning: null,
        totals: { typing: { added: 0, deleted: 0 }, pasted: { added: 0, deleted: 0 }, imported: { added: 0, deleted: 0 },
          restored: { added: 0, deleted: 0 }, unattributed: { added: 0, deleted: 0 } },
      };
    }
    if (cmd === "project_source_words_collecting") {
      collecting = args?.collecting === true;
      return null;
    }
    if (cmd === "project_source_words_reset") return null;
    if (cmd === "snapshot_restore") return { documents: 2, covered: 2 };
    // The cast and who appears where. Both empty by default: a fresh manuscript
    // has nobody in it, which is the state the empty-state sentences are for.
    if (cmd === "cast_list") return opts.cast ?? [];
    if (cmd === "appearances_list") return opts.appearances ?? {};
    if (cmd === "appearances_set") return args?.memberIds ?? [];
    throw new Error(`unexpected command ${cmd}`);
  };
  const of = (cmd: string): Call[] => calls.filter((c) => c.cmd === cmd);
  return {
    invoke,
    calls,
    of,
    flushed: () => of("doc_flush").flatMap((c) => (c.args?.entries ?? []) as FlushEntry[]),
  };
}

/** The page shell mountProject reads out of index.html. Sized here because
 *  happy-dom reports clientHeight 0, which would mount no rows at all. */
const SHELL_IDS = [
  "rename-controls",
  "scene-name",
  "word-count",
  "goal-bar",
  "status-controls",
  // No #export-controls: the export command has no element at all since the
  // retirement slice, so index.html carries no anchor for it and project.ts
  // looks none up. #prefs-controls is in the page but not here - mountProject
  // does not read it; the preferences panel is main.ts's. No #format-controls
  // either: the bubble toolbar mounts on document.body, which
  // mountProject reaches directly rather than through a shell anchor.
  "find-controls",
  "quick-open-controls",
  "history-controls",
  "stats-controls",
  "state-controls",
  "synopsis-controls",
  "cast-controls",
  "craft-controls",
  "appears-controls",
  "appears-map-controls",
  "design-controls",
  "covers-controls",
  "identity-controls",
  "preflight-controls",
  "picture-viewer-controls",
  "preview-controls",
  "reference-controls",
  "comments-controls",
  "review-controls",
  "recovery-controls",
  "archive-controls",
  "mirror-controls",
  "mirror-changes-controls",
  "save-controls",
  "nav",
  "editor",
  // Not created as a sibling div by the loop below: it is #editor's first
  // child, the way index.html has it, so shell() builds it there instead.
  "scene-heading",
] as const;

/** The three copies' anchors live INSIDE the status popover, which is static
 *  markup under #status-controls in index.html. Built the same way here, so the
 *  dot's "mounted before the popover" claim is tested against the shape the
 *  page actually has rather than against three loose siblings. */
const POPOVER_IDS = ["recovery-controls", "archive-controls", "mirror-controls"] as const;

function shell(): void {
  for (const id of SHELL_IDS) {
    if ((POPOVER_IDS as readonly string[]).includes(id)) continue;
    if (id === "scene-heading") continue;
    const el = document.createElement(id === "craft-controls" ? "span" : "div");
    el.id = id;
    if (id === "nav") Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    if (id === "status-controls") {
      const popover = document.createElement("div");
      popover.id = "status-popover";
      popover.hidden = true;
      for (const inner of POPOVER_IDS) {
        const span = document.createElement("span");
        span.id = inner;
        popover.appendChild(span);
      }
      el.appendChild(popover);
    }
    if (id === "editor") {
      const heading = document.createElement("h1");
      heading.id = "scene-heading";
      el.appendChild(heading);
    }
    document.body.appendChild(el);
  }
}

function tearDownShell(): void {
  for (const id of SHELL_IDS) document.getElementById(id)?.remove();
}

/** Drains the microtask chain behind an outline mutation (command -> re-read ->
 *  reload). A timer callback runs only once every pending microtask has. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Microtask-only settling. `settle` above is a real timer, and the tone tests
 *  below run under FAKE timers - where a setTimeout nobody advances never
 *  resolves and the test hangs rather than failing. */
const micro = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A banner's message, without the dismiss button's glyph. */
const labelOf = (id: string): string | undefined =>
  document.getElementById(id)?.querySelector(".app-banner-text")?.textContent ?? undefined;

/** Every banner in the page, by id. They are prepended to <body>, so one left
 *  standing leaks into every file that runs after this one. */
const bannerIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".app-banner")].map((el) => el.id);

/** How many dismiss controls a banner carries. A COUNT, never the element:
 *  `expect(node).not.toBeNull()` prints the whole happy-dom node on failure -
 *  megabytes of getters - which times the runner out and reads as a pass. */
const dismissCount = (id: string): number =>
  document.getElementById(id)?.querySelectorAll(".app-banner-dismiss").length ?? -1;

const deps = (over: Partial<MountDeps> & Pick<MountDeps, "invoke">): MountDeps => ({
  mode: "virtual",
  seed: "test",
  persistMode: "write",
  projectPath: "/tmp/project.db",
  generation: 1,
  ...over,
});

describe("captured review integration", () => {
  const reviewSummary = { id: 7, author_name: "Mara", rev: 2, created_at: 1, pending: 1, conflicted: 0, accepted: 0, rejected: 0, messages: 0 };
  const reviewGroup = (itemId: string) => ({ id: 7, item_id: itemId, author_id: 3, author_name: "Mara", rev: 2, created_at: 1,
    hunks: [{ id: 10, state: "pending", original: { from: 1, to: 2, before: [{ kind: "text", text: "a" }], after: [{ kind: "text", text: "b" }] },
      mapped_from: 1, mapped_to: 2, conflicted_at: null, decided_at: null, decision_author_id: null, decision_author_name: null }] });
  function reviewHost() {
    const h = host({ bodies: { "scene-0": body("alpha"), "scene-1": body("other") } });
    const docs = new Map([["scene-0", body("alpha")], ["scene-1", body("other")]]);
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_load") return { body: docs.get(String(args?.itemId)), rev: docs.get(String(args?.itemId)) === body("accepted") ? 8 : 7 };
      if (cmd === "review_state") return { document: { item_id: args?.itemId, body: docs.get(String(args?.itemId)), rev: 7 },
        authors: [{ id: 3, display_name: "Mara", created_at: 1 }], page: { groups: [reviewSummary], before_id: null } };
      if (cmd === "review_group") return reviewGroup("scene-0");
      if (cmd === "review_messages") return [];
      if (cmd === "review_decide") { docs.set("scene-0", body("accepted")); return { doc_rev: 8, body: body("accepted") }; }
      return h.invoke(cmd, args);
    };
    return { h, docs, invoke };
  }
  async function selectDecision() {
    document.querySelector<HTMLButtonElement>('[data-group="7"]')!.click(); await settle();
    const author = document.querySelector<HTMLSelectElement>("#review-author")!;
    author.value = "3"; author.dispatchEvent(new Event("change"));
    document.querySelector<HTMLInputElement>('[data-hunk="10"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-decision="accept"]')!.click();
    await settle(); await settle();
  }

  test("accept installs host prose in the captured active scene before the next edit", async () => {
    shell(); const r = reviewHost();
    const calls: Call[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => { calls.push({ cmd, args }); return r.invoke(cmd, args); };
    const mounted = await mountProject(deps({ invoke, generation: 19 }));
    try {
      mounted.menuActions.openReviewProposals(); await settle();
      await selectDecision();
      const decision = calls.find((call) => call.cmd === "review_decide")!;
      expect(decision.args?.request).toEqual({ generation: 19, item_id: "scene-0", group_id: 7,
        expected_group_rev: 2, expected_doc_rev: 7, selected_ids: [10], decision: "accept", author_id: 3 });
      expect(mounted.editor.serialize()).toBe(body("accepted"));
      expect(calls.filter((call) => call.cmd === "comment_list").length).toBeGreaterThan(1);
      mounted.editor.typeChar("x"); await mounted.session!.flushPending();
      expect(r.h.flushed().at(-1)?.base_rev).toBe(8);
    } finally { mounted.destroy(); }
  });

  test("accept for captured scene leaves a different active editor untouched", async () => {
    shell(); const r = reviewHost(); const calls: Call[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => { calls.push({ cmd, args }); return r.invoke(cmd, args); };
    const mounted = await mountProject(deps({ invoke }));
    try {
      mounted.menuActions.openReviewProposals(); await settle();
      expect(await mounted.session!.switchTo("scene-1")).toBe("switched");
      const before = mounted.editor.serialize();
      await selectDecision();
      expect((calls.find((call) => call.cmd === "review_decide")!.args?.request as Record<string, unknown>).item_id).toBe("scene-0");
      expect(mounted.session!.activeDocId()).toBe("scene-1");
      expect(mounted.editor.serialize()).toBe(before);
      expect(r.docs.get("scene-0")).toBe(body("accepted"));
    } finally { mounted.destroy(); }
  });

  test("accepted prose stays read-only until its remapped comments arrive", async () => {
    shell(); const r = reviewHost();
    let releaseComments = (): void => undefined;
    const commentsReady = new Promise<void>((resolve) => { releaseComments = resolve; });
    let commentReads = 0;
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "comment_list" && ++commentReads > 1) { await commentsReady; return []; }
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      mounted.menuActions.openReviewProposals(); await settle();
      await selectDecision();
      expect(mounted.editor.serialize()).toBe(body("accepted"));
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      expect(mounted.reviewPending()).toBe(true);
      releaseComments(); await settle(); await settle();
      mounted.editor.typeChar("y");
      expect(mounted.editor.serialize()).toContain("y");
    } finally { releaseComments(); mounted.destroy(); }
  });

  test("opening review blocks scene navigation and a canceled leave cannot unlock it", async () => {
    shell(); const r = reviewHost();
    let releaseState = (): void => undefined;
    const stateReady = new Promise<void>((resolve) => { releaseState = resolve; });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "review_state") await stateReady;
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      mounted.menuActions.openReviewProposals(); await settle();
      expect(mounted.reviewPending()).toBe(true);
      mounted.navigator.selectById("scene-1"); mounted.navigator.activate(); await settle();
      expect(mounted.session!.activeDocId()).toBe("scene-0");
      expect(await mounted.prepareToLeave()).toBe(false);
      mounted.cancelLeave();
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      releaseState(); await settle(); await settle();
      mounted.editor.typeChar("y"); expect(mounted.editor.serialize()).toContain("y");
    } finally { releaseState(); mounted.destroy(); }
  });

  test("pending acceptance refuses departure until the host answers", async () => {
    shell(); const r = reviewHost();
    let releaseDecision = (): void => undefined;
    const decisionReady = new Promise<void>((resolve) => { releaseDecision = resolve; });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "review_decide") await decisionReady;
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      mounted.menuActions.openReviewProposals(); await settle();
      await selectDecision();
      expect(mounted.reviewPending()).toBe(true);
      expect(await mounted.prepareToLeave()).toBe(false);
      mounted.cancelLeave();
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      releaseDecision(); await settle(); await settle();
      expect(mounted.editor.serialize()).toBe(body("accepted"));
    } finally { releaseDecision(); mounted.destroy(); }
  });

  test("departure keeps unsent discussion until explicit discard and freezes the editor", async () => {
    shell(); const r = reviewHost(); const mounted = await mountProject(deps({ invoke: r.invoke }));
    try {
      mounted.menuActions.openReviewProposals(); await settle();
      document.querySelector<HTMLButtonElement>('[data-group="7"]')!.click(); await settle();
      const message = document.querySelector<HTMLTextAreaElement>("#review-message")!;
      message.value = "Unsent"; message.dispatchEvent(new Event("input"));
      const keeping = mounted.prepareToLeave();
      document.querySelector<HTMLButtonElement>("#review-leave button:first-of-type")!.click();
      expect(await keeping).toBe(false);
      expect(message.value).toBe("Unsent");
      const leaving = mounted.prepareToLeave();
      document.querySelector<HTMLButtonElement>("#review-leave button:last-of-type")!.click();
      expect(await leaving).toBe(true);
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      expect(document.querySelector<HTMLButtonElement>("#review-close")?.disabled).toBe(true);
      mounted.cancelLeave();
      expect(document.querySelector<HTMLButtonElement>("#review-close")?.disabled).toBe(false);
    } finally { mounted.destroy(); }
  });

  const returnedPreview = { token: "opaque-return", item_id: "scene-0", scene_title: "Arrival", doc_rev: 7,
    decisions: [{ hunk_id: 10, decision: "accept", proposal_author: "Mara",
      before: [{ kind: "text", text: "alpha" }], after: [{ kind: "text", text: "accepted" }] }],
    new_hunks: [{ author_name: "Word Writer", hunk: { from: 1, to: 2,
      before: [{ kind: "text", text: "a" }], after: [{ kind: "text", text: "A" }] } }],
    new_messages: [], source_authors: ["Word Writer"] };
  async function openTransport(mounted: MountedProject): Promise<void> {
    mounted.menuActions.openReviewProposals(); await settle();
    document.querySelector<HTMLButtonElement>("#review-transport-tab")!.click();
  }
  function chooseReturnAuthors(): void {
    const actor = document.querySelector<HTMLSelectElement>("#review-transport [data-actor] select")!;
    actor.value = "existing:3"; actor.dispatchEvent(new Event("change"));
    const source = document.querySelector<HTMLSelectElement>('#review-transport [data-source="Word Writer"] select')!;
    source.value = "existing:3"; source.dispatchEvent(new Event("change"));
  }

  test("returned accept installs only host prose and waits for remapped comments", async () => {
    shell(); const r = reviewHost(); const calls: Call[] = [];
    let releaseComments = (): void => undefined;
    const commentsReady = new Promise<void>((resolve) => { releaseComments = resolve; });
    let commentReads = 0;
    const invoke: Host["invoke"] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "review_return_preview") return returnedPreview;
      if (cmd === "review_return_apply") { r.docs.set("scene-0", body("accepted")); return { item_id: "scene-0", doc_rev: 8, body: body("accepted") }; }
      if (cmd === "comment_list" && ++commentReads > 1) { await commentsReady; return []; }
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke, generation: 19 }));
    try {
      await openTransport(mounted);
      document.querySelector<HTMLButtonElement>("#review-transport button:nth-of-type(2)")!.click(); await settle();
      chooseReturnAuthors();
      document.querySelector<HTMLButtonElement>("#review-transport-apply")!.click(); await settle();
      expect(calls.find((call) => call.cmd === "review_return_preview")?.args).toEqual({ generation: 19, itemId: "scene-0" });
      expect(calls.find((call) => call.cmd === "review_return_apply")?.args).toEqual({ request: {
        token: "opaque-return", deciding_actor: { kind: "existing", id: 3 },
        sources: [{ source_name: "Word Writer", choice: { kind: "existing", id: 3 } }],
      } });
      expect(mounted.editor.serialize()).toBe(body("accepted"));
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      expect(mounted.reviewPending()).toBe(true);
      releaseComments(); await settle(); await settle();
      mounted.editor.typeChar("y"); await mounted.session!.flushPending();
      expect(r.h.flushed().at(-1)?.base_rev).toBe(8);
    } finally { releaseComments(); mounted.destroy(); }
  });

  test("a committed return with failed view reconciliation clears pending status but keeps the editor frozen", async () => {
    shell(); const r = reviewHost();
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "review_return_preview") return returnedPreview;
      if (cmd === "review_return_apply") {
        r.docs.set("scene-0", body("accepted"));
        return { item_id: "scene-0", doc_rev: 8, body: "invalid body" };
      }
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      await openTransport(mounted);
      document.querySelector<HTMLButtonElement>("#review-transport button:nth-of-type(2)")!.click(); await settle();
      chooseReturnAuthors();
      document.querySelector<HTMLButtonElement>("#review-transport-apply")!.click(); await settle(); await settle();
      expect(mounted.reviewPending()).toBe(false);
      expect(document.querySelector<HTMLButtonElement>("#review-transport-apply")).toBeNull();
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      expect(await mounted.prepareToLeave()).toBe(true);
      mounted.cancelLeave();
      mounted.editor.typeChar("y");
      expect(mounted.editor.serialize()).toBe(before);
    } finally { mounted.destroy(); }
  });

  test("return for a captured background scene leaves the active editor alone", async () => {
    shell(); const r = reviewHost(); const calls: Call[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "review_return_preview") return returnedPreview;
      if (cmd === "review_return_apply") { r.docs.set("scene-0", body("accepted")); return { item_id: "scene-0", doc_rev: 8, body: body("accepted") }; }
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      await openTransport(mounted);
      expect(await mounted.session!.switchTo("scene-1")).toBe("switched");
      const before = mounted.editor.serialize();
      document.querySelector<HTMLButtonElement>("#review-transport button:nth-of-type(2)")!.click(); await settle();
      chooseReturnAuthors(); document.querySelector<HTMLButtonElement>("#review-transport-apply")!.click(); await settle(); await settle();
      expect(calls.find((call) => call.cmd === "review_return_preview")?.args?.itemId).toBe("scene-0");
      expect(mounted.session!.activeDocId()).toBe("scene-1");
      expect(mounted.editor.serialize()).toBe(before);
      expect(r.docs.get("scene-0")).toBe(body("accepted"));
    } finally { mounted.destroy(); }
  });

  test("prepared return protects departure until explicit discard cancels its token", async () => {
    shell(); const r = reviewHost(); const calls: Call[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "review_return_preview") return returnedPreview;
      if (cmd === "review_transport_cancel") return null;
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      await openTransport(mounted);
      document.querySelector<HTMLButtonElement>("#review-transport button:nth-of-type(2)")!.click(); await settle();
      const keep = mounted.prepareToLeave();
      document.querySelector<HTMLButtonElement>("#review-leave button:first-of-type")!.click();
      expect(await keep).toBe(false);
      expect(mounted.reviewPending()).toBe(true);
      const leave = mounted.prepareToLeave();
      document.querySelector<HTMLButtonElement>("#review-leave button:last-of-type")!.click();
      expect(await leave).toBe(true);
      expect(calls.find((call) => call.cmd === "review_transport_cancel")?.args).toEqual({ token: "opaque-return" });
      mounted.cancelLeave();
    } finally { mounted.destroy(); }
  });

  test("privacy invalidation removes a prepared return before unlock", async () => {
    shell(); const r = reviewHost(); const calls: Call[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "review_return_preview") return returnedPreview;
      if (cmd === "review_transport_cancel") return null;
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      await openTransport(mounted);
      document.querySelector<HTMLButtonElement>("#review-transport button:nth-of-type(2)")!.click(); await settle();
      expect(document.querySelector<HTMLButtonElement>("#review-transport-apply")).not.toBeNull();
      mounted.reviewPrivacyChanged(); await settle();
      expect(document.querySelector<HTMLButtonElement>("#review-transport-apply")).toBeNull();
      expect(calls.find((call) => call.cmd === "review_transport_cancel")?.args).toEqual({ token: "opaque-return" });
      expect(mounted.reviewPending()).toBe(false);
    } finally { mounted.destroy(); }
  });

  test("export preview drains the captured scene before asking the host and passes no path", async () => {
    shell(); const r = reviewHost(); const calls: Call[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "review_export_preview") return { token: "opaque-export", item_id: "scene-0", scene_title: "Arrival",
        doc_rev: 8, authors: ["Mara"], messages: [{ author_name: "Mara", body: "Discussion" }] };
      if (cmd === "review_transport_cancel") return null;
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      await openTransport(mounted);
      mounted.editor.typeChar("x");
      document.querySelector<HTMLButtonElement>("#review-transport button:first-of-type")!.click(); await settle(); await settle();
      const flushed = calls.findIndex((call) => call.cmd === "doc_flush");
      const preview = calls.findIndex((call) => call.cmd === "review_export_preview");
      expect(flushed).toBeGreaterThan(-1);
      expect(preview).toBeGreaterThan(flushed);
      expect(calls[preview]?.args).toEqual({ generation: 1, itemId: "scene-0" });
      expect(document.querySelector<HTMLElement>("#review-transport-preview")?.textContent).toContain("Discussion");
      mounted.reviewPrivacyChanged(); await settle();
    } finally { mounted.destroy(); }
  });

  test("the native return picker blocks scene opening and departure until it resolves", async () => {
    shell(); const r = reviewHost();
    let release = (): void => undefined;
    const picker = new Promise<void>((resolve) => { release = resolve; });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "review_return_preview") { await picker; return null; }
      return r.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      await openTransport(mounted);
      document.querySelector<HTMLButtonElement>("#review-transport button:nth-of-type(2)")!.click(); await settle();
      expect(mounted.reviewPending()).toBe(true);
      expect(await mounted.prepareToLeave()).toBe(false);
      mounted.navigator.selectById("scene-1"); mounted.navigator.activate(); await settle();
      expect(mounted.session!.activeDocId()).toBe("scene-0");
      const before = mounted.editor.serialize(); mounted.editor.typeChar("x");
      expect(mounted.editor.serialize()).toBe(before);
      release(); await settle(); await settle();
      expect(mounted.reviewPending()).toBe(false);
    } finally { release(); mounted.destroy(); }
  });
});

afterEach(() => {
  tearDownShell();
});

describe("mountProject store path", () => {
  test("continuous chapter writes two scene ids through the one editor and preserves active undo on exit", async () => {
    shell();
    const h = host();
    const saved = new Map([["scene-0", body("first")], ["scene-1", body("second")]]);
    const flushed: FlushEntry[] = [];
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_load") return { body: saved.get(String(args?.itemId)) ?? body("alpha"), rev: 7 + flushed.filter((entry) => entry.item_id === args?.itemId).length };
      if (cmd === "doc_flush") {
        const entries = args?.entries as FlushEntry[];
        for (const entry of entries) { saved.set(entry.item_id, entry.body); flushed.push(entry); }
        return entries.map((entry) => ({ item_id: entry.item_id, rev: entry.base_rev + 1 }));
      }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      const node = document.querySelector("#editor .ProseMirror");
      mounted.menuActions.showContinuousChapter();
      await settle();
      expect(mounted.menuActions.outlineViewMode()).toBe("continuous");
      expect(document.querySelectorAll("#editor .ProseMirror")).toHaveLength(1);
      mounted.editor.typeChar("X");
      document.querySelector<HTMLButtonElement>('.continuous-scene[data-item-id="scene-1"] button')?.click();
      await settle();
      expect(mounted.session?.activeDocId()).toBe("scene-1");
      expect(saved.get("scene-0")).toContain("X");
      expect(document.querySelector('.continuous-scene[data-item-id="scene-0"]')?.textContent).toContain("X");
      expect(document.querySelector("#editor .ProseMirror")).toBe(node);
      mounted.editor.typeChar("Y");
      await mounted.session?.flushPending();
      expect(saved.get("scene-1")).toContain("Y");
      expect(flushed.map((entry) => entry.item_id)).toEqual(["scene-0", "scene-1"]);
      mounted.menuActions.showManuscript();
      expect(mounted.menuActions.outlineViewMode()).toBe("manuscript");
      mounted.menuActions.undo();
      expect(mounted.editor.serialize()).not.toContain("Y");
      mounted.menuActions.showContinuousChapter();
      const chord = new KeyboardEvent("keydown", { key: "PageUp", altKey: true, bubbles: true, cancelable: true });
      node?.dispatchEvent(chord);
      await settle();
      expect(chord.defaultPrevented).toBe(true);
      expect(mounted.session?.activeDocId()).toBe("scene-0");
      expect(mounted.editor.serialize()).toContain("X");
      expect(h.of("comment_list").map((call) => call.args?.itemId)).toContain("scene-1");
    } finally { mounted.destroy(); }
  });

  test("continuous selection guards edits without trapping panel input or keyboard navigation", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    try {
      mounted.menuActions.showContinuousChapter();
      await settle();
      const editor = document.querySelector<HTMLElement>("#editor .ProseMirror")!;
      const first = editor.querySelector("p")!.firstChild!;
      const neighbor = document.querySelector(".continuous-prose p")!.firstChild!;
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(neighbor, 1);
      // ProseMirror normalizes happy-dom's synthetic cross-editor range.
      // Supply the browser selection endpoints to test the document handler.
      const selected = jest.spyOn(document, "getSelection").mockReturnValue({
        isCollapsed: false, anchorNode: first, focusNode: neighbor,
        rangeCount: 1, getRangeAt: () => range,
      } as unknown as Selection);
      try {
      const cut = new Event("cut", { bubbles: true, cancelable: true });
      editor.dispatchEvent(cut);
      expect(cut.defaultPrevented).toBe(true);
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      editor.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      const input = document.createElement("input");
      document.body.append(input);
      const typing = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
      input.dispatchEvent(typing);
      expect(typing.defaultPrevented).toBe(false);
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      input.dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(false);
      } finally { selected.mockRestore(); selection.removeAllRanges(); }
    } finally { mounted.destroy(); }
  });

  test("continuous chapter keeps the active draft when a switch cannot save", async () => {
    shell();
    const h = host({ reject: ["doc_flush"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    try {
      mounted.menuActions.showContinuousChapter();
      mounted.editor.typeChar("X");
      document.querySelector<HTMLButtonElement>('.continuous-scene[data-item-id="scene-1"] button')?.click();
      await settle();
      expect(mounted.session?.activeDocId()).toBe("scene-0");
      expect(mounted.editor.serialize()).toContain("X");
      expect(mounted.menuActions.outlineViewMode()).toBe("continuous");
    } finally { mounted.destroy(); }
  });
  test("opens the first scene, not row 0", async () => {
    // idAt(0) is a part. A mount that opened it would ask the store for a
    // document row that only scenes have.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    expect(mounted.activeDocId).toBe("scene-0");
    expect(h.of("doc_load")[0]?.args).toEqual({ itemId: "scene-0" });
    expect(mounted.activeDocRev).toBe(7);
    mounted.destroy();
  });

  test("marks the opened scene as the current row in the navigator", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const row = document.querySelector('[data-item-id="scene-0"]');
    expect(row?.getAttribute("aria-current")).toBe("true");
    mounted.destroy();
  });

  test("reference source opens through the visible editor and close focuses the reading view", async () => {
    shell();
    const h = host({ bodies: { "scene-1": body("second scene") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.navigator.selectById("scene-1");
    mounted.menuActions.openReference();
    await settle();
    expect(document.querySelector("#reference-rail .reference-body")?.textContent).toBe("second scene");
    mounted.menuActions.showReadThrough();
    await settle();
    expect(document.getElementById("editor")?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>("#reference-close")?.click();
    expect(document.activeElement).toBe(document.querySelector("#outline-view h1"));
    mounted.menuActions.openReference();
    await settle();
    document.querySelector<HTMLButtonElement>("#reference-open-source")?.click();
    await settle();
    expect(document.getElementById("editor")?.hidden).toBe(false);
    expect(document.getElementById("outline-view")?.hidden).toBe(true);
    expect(mounted.session?.activeDocId()).toBe("scene-1");
    expect(document.getElementById("editor")?.contains(document.activeElement)).toBe(true);
    mounted.destroy();
  });

  test("opens a Bible shortcut through the normal document route and removes it on teardown", async () => {
    shell();
    const items = [
      ...walk(),
      { id: "bible", parent_id: null, type: "bible", title: "Bible", position: "0002", rev: 1, state: null, depth: 0 },
      { id: "note", parent_id: "bible", type: "note", title: "World", position: "0000", rev: 1, state: null, depth: 1 },
    ];
    const changed = items.map((item) => item.id === "note" ? { ...item, title: "Updated world" } : item);
    const h = host({ items, walks: [items, changed], bodies: { note: body("world") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const shortcut = document.querySelector<HTMLButtonElement>("[data-bible-id='note']");
    if (shortcut === null) throw new Error("Bible shortcut was not mounted");
    shortcut.click();
    await settle();
    expect(h.of("doc_load").at(-1)?.args).toEqual({ itemId: "note" });
    expect(document.querySelector("[data-bible-id='note']")?.getAttribute("aria-current")).toBe("true");
    await mounted.outline?.rename("note", "Updated world");
    expect(document.querySelector("[data-bible-id='note']")?.textContent).toBe("Updated world");
    mounted.destroy();
    expect(document.getElementById("bible-section")).toBeNull();
  });

  test("Bible shortcut reveals a note below a collapsed root only after it opens", async () => {
    shell();
    const items = [
      ...walk(),
      { id: "bible", parent_id: null, type: "bible", title: "Bible", position: "0002", rev: 1, state: null, depth: 0 },
      { id: "note", parent_id: "bible", type: "note", title: "World", position: "0000", rev: 1, state: null, depth: 1 },
    ];
    const h = host({ items, bodies: { note: body("world") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    try {
      mounted.navigator.selectById("bible");
      mounted.navigator.handleKey("ArrowLeft");
      expect(mounted.navigator.rows().some((row) => row.id === "note")).toBe(false);
      const shortcut = document.querySelector<HTMLButtonElement>("[data-bible-id='note']");
      if (shortcut === null) throw new Error("Bible shortcut was not mounted");
      shortcut.click();
      await settle();
      expect(mounted.navigator.activeTitle()).toBe("World");
      expect(mounted.navigator.rows().some((row) => row.id === "note")).toBe(true);
    } finally {
      mounted.destroy();
    }
  });

  test("rapid Bible shortcuts leave selection on the document whose open was accepted", async () => {
    shell();
    const items = [
      ...walk(),
      { id: "bible", parent_id: null, type: "bible", title: "Bible", position: "0002", rev: 1, state: null, depth: 0 },
      { id: "one", parent_id: "bible", type: "note", title: "First note", position: "0000", rev: 1, state: null, depth: 1 },
      { id: "two", parent_id: "bible", type: "note", title: "Second note", position: "0001", rev: 1, state: null, depth: 1 },
    ];
    const h = host({ items });
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_load" && args?.itemId === "one") await pending;
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    try {
      document.querySelector<HTMLButtonElement>("[data-bible-id='one']")?.click();
      await settle();
      document.querySelector<HTMLButtonElement>("[data-bible-id='two']")?.click();
      await settle();
      expect(mounted.navigator.activeTitle()).toBe("Arrival");
      release();
      await settle();
      expect(mounted.navigator.activeTitle()).toBe("First note");
      expect(document.querySelector("[data-bible-id='one']")?.getAttribute("aria-current")).toBe("true");
    } finally {
      release();
      mounted.destroy();
    }
  });

  test("a Bible shortcut that cannot open leaves the existing outline selection alone", async () => {
    shell();
    const items = [
      ...walk(),
      { id: "bible", parent_id: null, type: "bible", title: "Bible", position: "0002", rev: 1, state: null, depth: 0 },
      { id: "note", parent_id: "bible", type: "note", title: "Broken", position: "0000", rev: 1, state: null, depth: 1 },
    ];
    const h = host({ items, bodies: { note: "not a document" } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    try {
      const shortcut = document.querySelector<HTMLButtonElement>("[data-bible-id='note']");
      if (shortcut === null) throw new Error("Bible shortcut was not mounted");
      shortcut.click();
      await settle();
      expect(mounted.navigator.activeTitle()).toBe("Arrival");
      expect(document.querySelector("[data-bible-id='note']")?.getAttribute("aria-current")).toBe("false");
    } finally {
      mounted.destroy();
    }
  });

  test("the open scene's title is painted as the page's heading", async () => {
    shell();
    const h = host({ walks: [walk()] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const heading = document.getElementById("scene-heading");
    expect(heading?.textContent).toBe(document.getElementById("scene-name")?.textContent);
    expect(heading?.textContent).not.toBe("");
    mounted.destroy();
    expect(heading?.textContent).toBe("");
  });

  test("typing in focus mode arms the chrome fade; teardown wakes it", async () => {
    shell();
    document.documentElement.setAttribute("data-focus", "paragraph");
    let mounted: MountedProject | null = null;
    try {
      const h = host({ walks: [walk()] });
      mounted = await mountProject(deps({ invoke: h.invoke }));
      mounted.editor.typeChar("a");
      // The fade arms a real 1500 ms timer here; what this test pins is the
      // wiring, so it waits for it with the real clock rather than a fake
      // one project.ts exposes none of.
      await new Promise((res) => setTimeout(res, 1600));
      expect(document.body.classList.contains("chrome-hidden")).toBe(true);
    } finally {
      // Inside finally, not the last statement: a failing assertion above
      // must not skip teardown, which is the only thing that removes the
      // fade's document listeners -- a leaked fade broke a later test's own
      // assertions this way once already.
      mounted?.destroy();
      document.documentElement.removeAttribute("data-focus");
    }
    expect(document.body.classList.contains("chrome-hidden")).toBe(false);
  }, 5000);

  test("throws its exact message when the project has no scene", async () => {
    // A rig matches on this string.
    shell();
    const h = host({ items: [walk()[0]!] });
    await expect(mountProject(deps({ invoke: h.invoke }))).rejects.toThrow(
      "project has no scene: nothing to open in the editor",
    );
  });

  test("throws when the page shell is missing", async () => {
    const h = host();
    await expect(mountProject(deps({ invoke: h.invoke }))).rejects.toThrow(
      "page shell is missing #nav or #editor",
    );
  });

  test("throws when a project path is set but the bridge is absent", async () => {
    shell();
    await expect(mountProject(deps({ invoke: undefined }))).rejects.toThrow(
      "APP_PROJECT is set but the Tauri bridge is absent",
    );
  });
});

describe("mountProject flush contract", () => {
  test("every flush carries the mount's generation", async () => {
    // The host refuses a flush whose generation does not match the project it
    // holds, so a page that dropped this would have every save rejected.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke, generation: 42 }));
    mounted.flusher?.markDirty("scene-0", body("edited"));
    await mounted.flusher?.drain();
    expect(h.of("doc_flush")).toHaveLength(1);
    expect(h.of("doc_flush")[0]?.args?.generation).toBe(42);
    mounted.destroy();
  });

  test("the first flush's base_rev is the rev the document loaded at", async () => {
    // Without the boot-time register the scheduler falls back to base_rev 0 and
    // the store rejects the first save of every session as a conflict.
    shell();
    const h = host({ docRev: 7 });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.flusher?.markDirty("scene-0", body("edited"));
    await mounted.flusher?.drain();
    expect(h.flushed()).toEqual([{ item_id: "scene-0", body: body("edited"), base_rev: 7 }]);
    mounted.destroy();
  });

  test("a typed character reaches the scheduler through the session", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.editor.typeChar("x");
    expect(mounted.flusher?.dirtyCount()).toBe(1);
    mounted.destroy();
  });

  test("in verify mode a typed character does not arm a flush", async () => {
    // Verify mode reads the store back; typing into it would rewrite the very
    // body the restart check is comparing against.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke, persistMode: "verify" }));
    mounted.editor.typeChar("x");
    expect(mounted.flusher?.dirtyCount()).toBe(0);
    mounted.destroy();
  });
});

describe("mountProject failure surface", () => {
  test("raiseFailure shows a persist banner and latches", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseFailure("disk is full");
    mounted.raiseFailure("something else");
    const banner = document.getElementById("persist-error");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("disk is full");
    expect(banner?.textContent).not.toContain("something else");
    expect(mounted.persistError()).toBe("disk is full");
    mounted.destroy();
  });

  test("raiseNotice does not latch the persist error", async () => {
    // A failed OPEN is not a failed save. If it latched, the first unopenable
    // document would suppress the banner for a genuine autosave failure after
    // it - the one case the surface exists for.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseNotice("could not open that document");
    // The LABEL, not the banner's whole textContent: a dismissible banner
    // carries the button's glyph too, and asserting on the concatenation would
    // make the dismiss control's presence a property of this test.
    expect(labelOf("open-error")).toBe("could not open that document");
    expect(mounted.persistError()).toBeNull();
    mounted.raiseFailure("disk is full");
    expect(mounted.persistError()).toBe("disk is full");
    mounted.destroy();
  });
});

describe("mountProject destroy", () => {
  test("a second notice replaces the first rather than stacking a duplicate id", async () => {
    // raiseFailure is latched so it can only fire once; raiseNotice is not.
    // Two failed opens used to leave two elements sharing #open-error, and
    // destroy()'s getElementById teardown removes exactly one - so the survivor
    // carried a dead project's error into the next mount, by a different route
    // than the one the teardown loop was written for.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseNotice("first");
    mounted.raiseNotice("second");
    expect(document.querySelectorAll("#open-error").length).toBe(1);
    expect(labelOf("open-error")).toBe("second");

    mounted.destroy();

    expect(document.querySelectorAll("#open-error").length).toBe(0);
  });

  test("removes both banners", async () => {
    // A banner surviving a remount tells the writer their NEW manuscript failed
    // to save, and the latch means the next mount could never replace it.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseFailure("disk is full");
    mounted.raiseNotice("could not open that document");
    expect(document.getElementById("persist-error")).not.toBeNull();
    expect(document.getElementById("open-error")).not.toBeNull();

    mounted.destroy();

    expect(document.getElementById("persist-error")).toBeNull();
    expect(document.getElementById("open-error")).toBeNull();
  });

  test("stops the flush scheduler", async () => {
    // Held across destroy on purpose: mounted.flusher is nulled, but the
    // session closes over the same scheduler, so dropping the field proves
    // nothing about the armed debounce timer.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const flusher = mounted.flusher;
    if (flusher === null) throw new Error("the store path must build a scheduler");

    // Control: while mounted, a change does arm the scheduler.
    mounted.session?.noteChange();
    expect(flusher.dirtyCount()).toBe(1);

    mounted.destroy();

    mounted.session?.noteChange();
    // Asserted on the scheduler's own state rather than by waiting out the
    // 1000 ms debounce: a stopped scheduler accepts no work, so nothing is
    // pending and no timer can fire into a store these item ids no longer
    // describe.
    expect(flusher.dirtyCount()).toBe(0);
    expect(h.of("doc_flush")).toHaveLength(0);
    // A drain cannot resurrect it either.
    await flusher.drain();
    expect(h.of("doc_flush")).toHaveLength(0);
  });

  test("does not flush", async () => {
    // The caller drains first, deliberately: a teardown must never be the thing
    // that decides whether the user's text was saved.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.editor.typeChar("x");
    expect(mounted.flusher?.dirtyCount()).toBe(1);

    mounted.destroy();
    await Promise.resolve();

    expect(h.of("doc_flush")).toHaveLength(0);
  });

  test("drops the scheduler reference and empties the navigator", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    expect(document.querySelector('[data-item-id="scene-0"]')).not.toBeNull();
    mounted.destroy();
    expect(mounted.flusher).toBeNull();
    expect(document.querySelector('[data-item-id="scene-0"]')).toBeNull();
  });
});

describe("mountProject outline editing", () => {
  /** The boot walk plus one more scene, as the store would report it after a
   *  create. */
  function grownWalk(): ProjectItem[] {
    return [
      ...walk(),
      {
        id: "scene-2",
        parent_id: "chapter-0",
        type: "scene",
        title: "Untitled scene",
        position: "0002",
        rev: 1,
        state: null,
        depth: 2,
      },
    ];
  }

  test("Alt+ArrowDown on the navigator routes to the outline unit", async () => {
    // The navigator reports the intent only; the move arithmetic and the IPC
    // belong to the outline. Driven as a real keydown because the wiring under
    // test is the onMove option, not handleKey - the synthetic workload calls
    // handleKey directly and must never reach a mutation.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    // Boot selects the open scene, which is scene-0 with scene-1 below it.
    expect(mounted.navigator.rows()[mounted.navigator.activeIndex()]?.id).toBe("scene-0");

    document
      .getElementById("nav")
      // bubbles AND cancelable, matching navigator-move-keys: a non-cancelable
      // event reports defaultPrevented false however many times preventDefault
      // was called, so a handler that stopped preventing would still pass.
      ?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    await settle();

    expect(h.of("item_move")).toHaveLength(1);
    expect(h.of("item_move")[0]?.args).toEqual({
      id: "scene-0",
      newParentId: "chapter-0",
      afterId: "scene-1",
      baseRev: 1,
    });
    mounted.destroy();
  });

  test("Ctrl+Z on the navigator undoes the last outline change", async () => {
    // The same wiring shape as Alt+ArrowDown above, and driven the same way:
    // a real keydown on #nav, not handleKey, and the outline unit's own undo
    // stack decides what happens - the page only routes the chord to it.
    // scene-1 now comes FIRST in the walk, matching the store's own reorder -
    // outline.ts reads sibling order off the ARRAY, not off `position`.
    const afterMove: ProjectItem[] = walk().map((i) => (i.id === "scene-0" ? { ...i, rev: 2 } : i));
    [afterMove[2], afterMove[3]] = [afterMove[3]!, afterMove[2]!];
    shell();
    const h = host({ walks: [walk(), afterMove, walk()] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    const nav = document.getElementById("nav");
    nav?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }),
    );
    await settle();
    expect(h.of("item_move")).toHaveLength(1);

    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    nav?.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(h.of("item_move")).toHaveLength(2);
    // The row's ORIGINAL parent and sibling, read live from the walk the
    // move's own re-read left behind - not the rev the move itself sent.
    expect(h.of("item_move")[1]?.args).toEqual({
      id: "scene-0",
      newParentId: "chapter-0",
      afterId: null,
      baseRev: 2,
    });
    mounted.destroy();
  });

  test("a created item reaches the navigator without remounting the editor", async () => {
    // The whole point of the slice: command -> project_items -> navigator.reload.
    // A mount that rebuilt the page instead would show the new row too, and
    // would silently discard the writer's unsaved keystrokes and undo history
    // doing it - so the row count alone proves nothing.
    shell();
    const h = host({ walks: [walk(), grownWalk()] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const before = mounted.navigator.rows().length;
    // .ProseMirror, not firstElementChild: #scene-heading is the
    // editor's first child, so the identity that proves "no remount" is the
    // mount node itself.
    const editorNode = document.querySelector("#editor .ProseMirror");
    expect(editorNode).not.toBeNull();
    mounted.editor.typeChar("Z");
    const typed = mounted.editor.serialize();
    expect(typed).toContain("Z");

    mounted.menuActions.create("scene");
    await settle();

    expect(h.of("item_create")).toHaveLength(1);
    // BESIDE the selected scene, inside its chapter -- not inside the scene.
    //
    // This assertion used to read `parentId: "scene-0"` and carried a comment
    // saying it was "not a mistake waiting to be tightened", because product
    // spec section 6 makes the hierarchy arbitrary and the outline-editing
    // design placed a new item as the last child of the selection. THAT WAS
    // OVERTURNED after a scene swallowed a part: the
    // hierarchy is still arbitrary and nothing is forbidden, but where a new
    // item LANDS is now type-aware. See `placement.ts` and the write-back.
    expect(h.of("item_create")[0]?.args).toEqual({
      parentId: "chapter-0",
      afterId: "scene-0",
      itemType: "scene",
      title: "Scene 1",
    });
    expect(mounted.navigator.rows().length).toBe(before + 1);
    expect(mounted.navigator.rows().some((r) => r.id === "scene-2")).toBe(true);
    // Same editor node: no remount. The DOCUMENT is now the new scene, by the
    // rule that a create opens what it made, so the typed
    // text is gone from the editor and was flushed on the way out rather than
    // discarded.
    expect(document.querySelector("#editor .ProseMirror")).toBe(editorNode ?? null);
    expect(h.of("doc_load").map((c) => c.args?.itemId)).toContain("scene-2");
    expect(mounted.editor.serialize()).not.toContain("Z");
    expect(h.of("doc_flush").length).toBeGreaterThan(0);
    mounted.destroy();
  });

  test("a create OPENS the created scene, so typing lands in it", async () => {
    // Before 2026-09-01 a create selected the row and left the previous scene
    // open, so New scene followed by typing wrote into the OLD scene. The rig
    // gate outline_created_scene_opens still clicks the row and still passes:
    // clicking an already-open row is the "same" outcome and only moves focus.
    shell();
    const h = host({ walks: [walk(), grownWalk()] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    mounted.menuActions.create("scene");
    await settle();

    expect(h.of("doc_load").map((c) => c.args?.itemId)).toContain("scene-2");
    expect(
      document.querySelector('[data-item-id="scene-2"]')?.getAttribute("aria-current"),
    ).toBe("true");
    expect(document.getElementById("open-error")).toBeNull();
    mounted.destroy();
  });

  test("a scene created AFTER boot can be opened", async () => {
    // The headline loop of this slice: New scene -> click the new row -> the
    // editor shows it. A `typeOf` built once from the boot walk reports
    // undefined for scene-2, and undefined takes the same silent early return
    // as a part or a chapter - the row appears, the click does nothing, and
    // nothing anywhere says so.
    shell();
    const h = host({ walks: [walk(), grownWalk()] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    mounted.menuActions.create("scene");
    await settle();
    expect(mounted.navigator.rows().some((r) => r.id === "scene-2")).toBe(true);

    document
      .querySelector('[data-item-id="scene-2"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(h.of("doc_load").map((c) => c.args?.itemId)).toContain("scene-2");
    expect(
      document.querySelector('[data-item-id="scene-2"]')?.getAttribute("aria-current"),
    ).toBe("true");
    // Silence would be the defect; so would a banner.
    expect(document.getElementById("open-error")).toBeNull();
    mounted.destroy();
  });

  test("activating an id that is in no walk at all is reported, not swallowed", async () => {
    // A page bug, not a writer action. It reached the opener from somewhere, so
    // "nothing happened" is the one outcome that must not be possible.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const row = document.querySelector('[data-item-id="scene-1"]');
    if (!(row instanceof HTMLElement)) throw new Error("scene-1 is not mounted");
    row.dataset.itemId = "ghost";
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(document.getElementById("open-error")?.textContent).toContain("ghost");
    expect(h.of("doc_load").map((c) => c.args?.itemId)).not.toContain("ghost");
    mounted.destroy();
  });

  test("a failed mutation raises an UNLATCHED notice", async () => {
    // An outline failure must go through raiseNotice. raiseFailure latches, so
    // one refused rename would suppress the banner for every genuine autosave
    // failure after it - the one case that surface exists for.
    shell();
    const h = host({ reject: ["item_rename"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const outline = mounted.outline;
    if (outline === null) throw new Error("the store path must build an outline");

    expect(await outline.rename("scene-0", "First light")).toBe("failed");
    expect(document.getElementById("open-error")?.textContent).toContain("item_rename");
    expect(mounted.persistError()).toBeNull();

    // Clear it by hand, then fail again. Replacing an existing banner would
    // satisfy a latched implementation too; only a banner raised from nothing
    // proves the latch is not set.
    document.getElementById("open-error")?.remove();
    expect(await outline.rename("scene-1", "Last light")).toBe("failed");
    expect(document.getElementById("open-error")).not.toBeNull();
    expect(mounted.persistError()).toBeNull();
    mounted.destroy();
  });

  test("an outline op in flight across destroy leaves the shell untouched", async () => {
    // Click New scene, then switch projects before the item_create +
    // project_items round trip returns - comfortably longer than a click. The
    // reload lands on a destroyed navigator, which does not throw and whose
    // container is still #nav: the element the next project mounts into.
    shell();
    const h = host({ walks: [walk(), grownWalk()] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    mounted.menuActions.create("scene");
    mounted.destroy();
    await settle();

    const nav = document.getElementById("nav");
    expect(nav?.children.length).toBe(0);
    expect(nav?.getAttribute("aria-activedescendant")).toBeNull();
    expect(mounted.outline).toBeNull();
  });

  test("destroy tears the rename panel down", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    expect(document.getElementById("rename-controls")?.children.length).toBeGreaterThan(0);

    mounted.destroy();

    expect(document.getElementById("rename-controls")?.children.length).toBe(0);
  });

  test("the header names the open scene, and follows a rename", async () => {
    // The rename goes the way a writer's does: the menu opens the panel on the
    // selected row, Enter commits it, and the outline re-reads the walk. The
    // fixture's second walk is what the store answers after that rename.
    const renamed = walk().map((item) =>
      item.id === "scene-1" ? { ...item, title: "Departure, renamed" } : item,
    );
    shell();
    const h = host({ walks: [walk(), renamed] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const name = document.getElementById("scene-name");
    expect(name?.textContent).toBe("Arrival");

    const row = document.querySelector('[data-item-id="scene-1"]');
    if (!(row instanceof HTMLElement)) throw new Error("scene-1 is not mounted");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(name?.textContent).toBe("Departure");

    mounted.menuActions.beginRename();
    const field = document.getElementById("rename-field");
    if (!(field instanceof HTMLInputElement)) throw new Error("the rename panel did not open");
    field.value = "Departure, renamed";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(h.of("item_rename")[0]?.args).toEqual({ id: "scene-1", title: "Departure, renamed", baseRev: 1 });
    expect(name?.textContent).toBe("Departure, renamed");

    mounted.destroy();
    expect(name?.textContent).toBe("");
  });

  test("throws its exact message when the rename anchor is missing from the shell", async () => {
    shell();
    document.getElementById("rename-controls")?.remove();
    const h = host();
    await expect(mountProject(deps({ invoke: h.invoke }))).rejects.toThrow(
      "page shell is missing #rename-controls",
    );
  });
});

describe("mountProject word count", () => {
  const shown = (id: string): string =>
    document.querySelector(`#word-count ${id}`)?.textContent ?? "";

  test("the mount asks the store for the project total", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(h.of("project_progress")).toHaveLength(1);
    // The seeded scene is one word ("alpha"), counted from the live document
    // rather than from anything the host said.
    expect(shown("#word-count-scene")).toBe("1 word");
    expect(shown("#word-count-project")).toBe("100 in the book");
    mounted.destroy();
  });

  test("the first keystroke of a burst repaints the scene figure without asking the store", async () => {
    shell();
    // "a b c", so ONE Backspace changes the count: deleting the last character
    // takes it to "a b " and from three words to two. A keystroke that left the
    // count unchanged would make this pass against a display that never
    // repaints at all.
    const h = host({ bodies: { "scene-0": body("a b c") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(shown("#word-count-scene")).toBe("3 words");
    const asked = h.of("project_progress").length;

    mounted.editor.caretToParagraph(0); // A caret jump: no document change.
    mounted.editor.erasePrev();

    // The leading edge of the throttle: the first edit after an idle moment
    // shows immediately, so the number never reads as stuck.
    expect(shown("#word-count-scene")).toBe("2 words");
    // The scene half is computed in the page. A keystroke that asked the host
    // would put a scan of every document on the typing path.
    expect(h.of("project_progress")).toHaveLength(asked);
    mounted.destroy();
  });

  test("a keystroke inside the throttle window does not recount the document", async () => {
    // THE MEASURED REGRESSION. Counting the scene synchronously from onChange
    // put a whole-document textBetween and a Unicode scan inside every typed
    // character: 111 and 116 frames in the 40-100 ms bucket across the two
    // graded stress runs, where the same runs had ZERO before the count
    // existed. p95 and the stall gate are both blind to it.
    //
    // Asserted through the DISPLAY rather than by counting calls, because the
    // display is what a synchronous implementation would keep in step. The
    // trailing repaint that follows is word-count.test.ts's claim, where the
    // timer is injected and the window can be closed by hand.
    shell();
    const h = host({ bodies: { "scene-0": body("a b c") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.editor.caretToParagraph(0);

    mounted.editor.erasePrev(); // "a b " - painted, and arms the window.
    expect(shown("#word-count-scene")).toBe("2 words");
    mounted.editor.erasePrev(); // "a b"
    mounted.editor.erasePrev(); // "a " - one word, and the display must not know yet.

    expect(mounted.editor.wordCount()).toBe(1);
    expect(shown("#word-count-scene")).toBe("2 words");
    mounted.destroy();
  });

  test("opening another scene repaints the scene figure at once, throttle or not", async () => {
    // The defect this pins: refreshScene was called from the editor's onChange
    // and nowhere else, but a switch reaches the editor through replaceDoc,
    // which uses updateState specifically so onChange does NOT fire. So the bar
    // kept the previous scene's number until the writer typed, and a writer who
    // opened a scene only to read it never saw a correct one.
    //
    // The typing below is not scenery: it arms the keystroke throttle, so a
    // switch routed through the coalesced path would leave the OUTGOING scene's
    // number under the incoming document until the window closed. The switch
    // takes refreshSceneNow for exactly that reason.
    shell();
    const h = host({ bodies: { "scene-1": body("one two three four") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(shown("#word-count-scene")).toBe("1 word");
    mounted.editor.typeChar("x");

    const row = document.querySelector('[data-item-id="scene-1"]');
    if (!(row instanceof HTMLElement)) throw new Error("scene-1 is not mounted");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(mounted.session?.activeDocId()).toBe("scene-1");
    expect(shown("#word-count-scene")).toBe("4 words");
    mounted.destroy();
  });

  test("a successful flush refreshes the project figure", async () => {
    // The scheduler has no success hook; the refresh hangs off the flush
    // closure the page passes it, after the await, so a rejected flush throws
    // past it.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(shown("#word-count-project")).toBe("100 in the book");

    mounted.flusher?.markDirty("scene-0", body("edited"));
    await mounted.flusher?.drain();
    await settle();

    expect(h.of("doc_flush")).toHaveLength(1);
    expect(shown("#word-count-project")).toBe("200 in the book");
    mounted.destroy();
  });

  test("an outline mutation refreshes the project figure", async () => {
    // A created scene carries a document row, so the total the store would
    // answer with is no longer the one on screen.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(shown("#word-count-project")).toBe("100 in the book");

    mounted.menuActions.create("scene");
    await settle();

    expect(h.of("item_create")).toHaveLength(1);
    expect(shown("#word-count-project")).toBe("200 in the book");
    mounted.destroy();
  });

  test("a store that cannot count raises no banner and keeps the scene figure", async () => {
    // Routing this through raiseFailure would tell a writer their manuscript
    // was not being saved, which would be false: nothing about the count
    // touches the store's contents.
    shell();
    const h = host({ reject: ["project_progress"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(shown("#word-count-project")).toBe("— in the book");
    expect(document.getElementById("persist-error")).toBeNull();
    expect(mounted.persistError()).toBeNull();
    expect(document.getElementById("open-error")).toBeNull();
    expect(shown("#word-count-scene")).toBe("1 word");
    mounted.destroy();
  });

  test("destroy empties the count", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.getElementById("word-count")?.children.length).toBe(5);

    mounted.destroy();

    expect(document.getElementById("word-count")?.children.length).toBe(0);
  });

  test("throws its exact message when the word count is missing from the shell", async () => {
    shell();
    document.getElementById("word-count")?.remove();
    const h = host();
    await expect(mountProject(deps({ invoke: h.invoke }))).rejects.toThrow(
      "page shell is missing #word-count",
    );
  });
});

describe("mountProject appearances", () => {
  const CAST = [
    { id: "m-ada", kind: "character", name: "Ada", summary: "", fields: [], aliases: [] },
    { id: "m-harbour", kind: "place", name: "The harbour", summary: "", fields: [], aliases: [] },
  ];

  test("Who appears here opens on the row the navigator has selected", async () => {
    shell();
    const h = host({ cast: CAST });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const readsBeforeOpen = h.of("appearances_list").length;

    mounted.menuActions.openAppearances();
    await settle();

    expect(document.querySelector<HTMLElement>("#appears-panel")?.hidden).toBe(false);
    // The boot selection is the open scene, not row 0.
    expect(document.querySelector("#appears-status")?.textContent).toContain("Arrival");
    // The navigator reads once for its marks at mount; the panel makes one
    // additional whole-project read and takes its row from that answer.
    expect(h.of("appearances_list")).toHaveLength(readsBeforeOpen + 1);
    mounted.destroy();
  });

  test("Save reaches the store under the row the panel was OPENED on", async () => {
    // The capture, end to end. `openAppearances` reads the selection ONCE and
    // hands it to the panel; moving the selection afterwards must not move
    // where the writer's answer lands.
    shell();
    const h = host({ cast: CAST });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openAppearances();
    await settle();
    const box = document.querySelector<HTMLInputElement>("#appears-list input[value='m-ada']");
    if (box === null) throw new Error("no box for Ada");
    box.checked = true;
    mounted.navigator.handleKey("ArrowDown");
    document.querySelector<HTMLButtonElement>("#appears-save")?.click();
    await settle();

    expect(h.of("appearances_set").map((c) => c.args)).toEqual([
      { itemId: "scene-0", memberIds: ["m-ada"] },
    ]);
    mounted.destroy();
  });

  test("Who appears where reads NO selection and rolls the live walk up", async () => {
    shell();
    const h = host({ cast: CAST, appearances: { "scene-0": ["m-ada"] } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openAppearancesMap();
    await settle();

    expect(document.querySelector<HTMLElement>("#appears-map-panel")?.hidden).toBe(false);
    const rows = [...document.querySelectorAll<HTMLElement>(".appears-map-row")];
    // The scene the tag is on, plus every ancestor the union reached -- which is
    // the rollup, derived here, from the walk the page already holds.
    expect(rows.map((r) => r.dataset.id)).toContain("scene-0");
    expect(rows.length).toBeGreaterThan(1);
    mounted.destroy();
  });

  test("both panels leave the page when the project is torn down", async () => {
    // Each registers a document-level outside-click listener, so a mount that
    // did not destroy them would accumulate two live closures per project
    // switch AND leave two more panels in the page for the next mount to fight
    // with. The leak itself is unobservable; the elements are not.
    shell();
    const h = host({ cast: CAST });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.querySelector("#appears-panel")).not.toBeNull();
    expect(document.querySelector("#appears-map-panel")).not.toBeNull();

    mounted.destroy();

    expect(document.querySelector("#appears-panel")).toBeNull();
    expect(document.querySelector("#appears-map-panel")).toBeNull();
  });
});

describe("mountProject synopsis", () => {
  const panel = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>("#synopsis-panel");
    if (found === null) throw new Error("no synopsis panel in the page");
    return found;
  };

  test("the menu opens the panel on the row the navigator has selected", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(panel().hidden).toBe(true);
    mounted.menuActions.openSynopsis();
    await settle();

    expect(panel().hidden).toBe(false);
    // The boot selection is the open scene, not row 0.
    expect(document.querySelector("#synopsis-status")?.textContent).toBe("About Arrival");
    expect(h.of("synopsis_get").map((c) => c.args)).toEqual([{ itemId: "scene-0" }]);
    mounted.destroy();
  });

  test("Save reaches the store under the row the panel was OPENED on", async () => {
    // The capture, end to end. `openSynopsis` reads the selection ONCE and
    // hands it to the panel; moving the selection afterwards must not move
    // where the writer's paragraphs land.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openSynopsis();
    await settle();
    const field = document.querySelector<HTMLTextAreaElement>("#synopsis-field");
    if (field === null) throw new Error("no synopsis field");
    field.value = "she burns the letter";
    mounted.navigator.handleKey("ArrowDown");
    document.querySelector<HTMLButtonElement>("#synopsis-save")?.click();
    await settle();

    expect(h.of("synopsis_set").map((c) => c.args)).toEqual([
      { itemId: "scene-0", body: "she burns the letter" },
    ]);
    mounted.destroy();
  });

  test("the body reaches the host VERBATIM: the store owns the trim", async () => {
    // Two places deciding one thing is how they drift. The store trims, refuses
    // an empty body and deletes the row for one; a page that trimmed first
    // would be a second implementation of the first of those three, free to
    // disagree with the other two the day any of them changes.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openSynopsis();
    await settle();
    const field = document.querySelector<HTMLTextAreaElement>("#synopsis-field");
    if (field === null) throw new Error("no synopsis field");
    field.value = "  padded on both sides  ";
    document.querySelector<HTMLButtonElement>("#synopsis-save")?.click();
    await settle();

    expect(h.of("synopsis_set").map((c) => c.args?.body)).toEqual([
      "  padded on both sides  ",
    ]);
    mounted.destroy();
  });

  test("the panel leaves the page when the project is torn down", async () => {
    // It registers a document-level outside-click listener, so a mount that did
    // not destroy it would accumulate one live closure per project switch AND
    // leave a second #synopsis-panel in the page for the next mount to fight
    // with. The leak itself is unobservable; the element is not.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.querySelector("#synopsis-panel")).not.toBeNull();

    mounted.destroy();

    expect(document.querySelector("#synopsis-panel")).toBeNull();
  });
});

describe("mountProject revision state", () => {
  const panel = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>("#state-panel");
    if (found === null) throw new Error("no revision-state panel in the page");
    return found;
  };

  test("the menu opens the panel on the row the navigator has selected", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(panel().hidden).toBe(true);
    mounted.menuActions.openRevisionState();

    expect(panel().hidden).toBe(false);
    // The boot selection is the open scene, not row 0.
    expect(document.querySelector("#state-status")?.textContent).toBe("Arrival");
    mounted.destroy();
  });

  test("a choice reaches the store with the selected row's own rev", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openRevisionState();
    document.querySelector<HTMLButtonElement>('[data-state-value="draft"]')?.click();
    await settle();

    expect(h.of("item_set_state").map((c) => c.args)).toEqual([
      { id: "scene-0", state: "draft", baseRev: 1 },
    ]);
    mounted.destroy();
  });

  test("the panel follows the selection while it is open", async () => {
    // Read live at every open, never captured: an arrow key still reaches the
    // navigator with the panel up, and a captured row would mark one the writer
    // is no longer looking at.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openRevisionState();
    expect(document.querySelector("#state-status")?.textContent).toBe("Arrival");
    mounted.navigator.handleKey("ArrowDown");
    mounted.menuActions.openRevisionState();

    expect(document.querySelector("#state-status")?.textContent).toBe("Departure");
    mounted.destroy();
  });

  test("the mark reaches the navigator when the store reports it", async () => {
    // The walk is the only source of tree truth: the page paints what the
    // re-read says and never what it asked for.
    shell();
    const marked = walk().map((i) =>
      i.id === "scene-0" ? { ...i, state: "revising", rev: 2 } : i,
    );
    const h = host({ walks: [walk(), marked] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openRevisionState();
    document.querySelector<HTMLButtonElement>('[data-state-value="revising"]')?.click();
    await settle();

    const row = [...document.querySelectorAll<HTMLElement>("#nav [role='treeitem']")].find(
      (r) => r.querySelector(".nav-title")?.textContent === "Arrival",
    );
    expect(row?.dataset.state).toBe("revising");
    mounted.destroy();
  });

  test("destroy takes the panel out of the page", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.destroy();

    expect(document.querySelector("#state-panel") === null).toBe(true);
  });
});

describe("the Outline menu's one context item", () => {
  /** A manuscript with a bin, and one scene inside it. The Trash root comes
   *  FIRST because liveItemsIn is one forward pass carrying a set of excluded
   *  ids: a row is only dropped once its bin ancestor has gone by. */
  function binnedWalk(): ProjectItem[] {
    return [
      { id: "trash", parent_id: null, type: "trash", title: "Trash", position: "9999", rev: 1, state: null, depth: 0 },
      { id: "scene-9", parent_id: "trash", type: "scene", title: "Binned", position: "0000", rev: 1, state: null, depth: 1 },
      ...walk(),
    ];
  }

  test("it deletes a live row and restores a binned one", async () => {
    shell();
    const h = host({ items: binnedWalk() });
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    mounted.navigator.selectById("scene-1");
    expect(mounted.menuActions.selectedTrashed()).toBe(false);
    mounted.menuActions.removeOrRestore();
    await settle();
    expect(h.of("item_move")).toHaveLength(1);
    expect(h.of("item_move")[0]?.args?.newParentId).toBe("trash");

    mounted.navigator.selectById("scene-9");
    expect(mounted.menuActions.selectedTrashed()).toBe(true);
    mounted.menuActions.removeOrRestore();
    await settle();
    // ONE more move, not two: a restore lands after the last manuscript root
    // and never touches the bin, which was never displaced.
    expect(h.of("item_move")).toHaveLength(2);
    expect(h.of("item_move")[1]?.args).toMatchObject({ id: "scene-9", newParentId: null });
    mounted.destroy();
  });

  test("it takes the action the writer READ, not the one the selection now implies", async () => {
    // The outline bar held this in an `offering` field and the retirement moved
    // it into project.ts. The label is painted from selectedTrashed and the item
    // runs later; deriving the action again at run time lets a selection change
    // in between turn a Restore into a Delete, silently, in the writer's
    // manuscript.
    //
    // Graded BY EFFECT: `remove` is inert on a row already in the bin and
    // `restore` is inert on a live one, so a held Restore fired at a live row
    // reaches no IPC at all - and the re-deriving implementation deletes it.
    shell();
    const h = host({ items: binnedWalk() });
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    // The menu paints its label against the binned row: the writer reads
    // "Restore".
    mounted.navigator.selectById("scene-9");
    expect(mounted.menuActions.selectedTrashed()).toBe(true);
    // ...and the selection moves before they press it.
    mounted.navigator.selectById("scene-1");

    mounted.menuActions.removeOrRestore();
    await settle();

    expect(h.of("item_move")).toHaveLength(0);
    mounted.destroy();
  });
});

describe("mountProject export", () => {
  // File > Export manuscript, which is the ONLY route now that the bar's
  // button is retired. It goes through `menuActions` rather than a captured
  // reference for the reason that field exists: the menu bar outlives a project
  // switch and must reach whichever project is open.
  const runExport = (mounted: MountedProject): void => {
    mounted.menuActions.exportProject();
  };

  test("the export drains pending edits BEFORE asking the host to export", async () => {
    // `project_export` reads the STORE. The flush debounce is a second, so
    // without the drain the file is missing whatever the writer typed last -
    // and `settled()` would not do it either: it awaits only a flush already in
    // flight, and this edit has one merely ARMED.
    shell();
    const h = host({ bodies: { "scene-0": body("a b c") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.editor.caretToParagraph(0);
    mounted.editor.erasePrev();
    expect(h.of("doc_flush")).toHaveLength(0);

    runExport(mounted);
    await settle();

    expect(h.flushed()).toHaveLength(1);
    const order = h.calls.map((c) => c.cmd).filter((c) => c === "doc_flush" || c === "project_export");
    expect(order).toEqual(["doc_flush", "project_export"]);
    mounted.destroy();
  });

  test("the written path is reported to the writer", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    runExport(mounted);
    await settle();

    const el = document.getElementById("open-error");
    expect(el?.textContent).toContain("/exports/test.md");
    // AND THE TONE, because the id alone is what let the defect ship: this
    // message arrived in the same element as a failed open, and was painted and
    // announced as one. Same id, different tone - and a regression that put it
    // back in the failure surface would keep this test green without these two
    // lines.
    expect(el?.dataset.tone).toBe("success");
    expect(el?.getAttribute("role")).toBe("status");
    mounted.destroy();
  });

  test("a failed export is a notice, and does NOT latch the save banner", async () => {
    // raiseFailure latches persistError and returns early on every later call,
    // so one failed export would suppress the banner for a genuine autosave
    // failure afterwards - the only case that surface exists for.
    shell();
    const h = host({ reject: ["project_export"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    runExport(mounted);
    await settle();

    const failed = document.getElementById("open-error");
    expect(failed?.textContent).toContain("project_export refused");
    // A problem, not an emergency: it is polite and dismissible, and it is NOT
    // the info tone - a failed export announced as good news is the mirror of
    // the defect this split fixed.
    expect(failed?.dataset.tone).toBe("problem");
    expect(failed?.getAttribute("role")).toBe("status");
    expect(document.getElementById("persist-error")).toBeNull();
    expect(mounted.persistError()).toBeNull();
    // Retryable. There is no button left to read `disabled` off, and the latch
    // that guard stood in for is the unit's own `running` flag - so the claim
    // is made where it now lives: a second export after a failure still reaches
    // the host. A latch left set would swallow it silently.
    runExport(mounted);
    await settle();
    expect(h.of("project_export")).toHaveLength(2);
    mounted.destroy();
  });

  test("a second export while one is in flight does not reach the host twice", async () => {
    // The failing direction for the retry claim above: without a latch the
    // first assertion would pass for a unit that exports on every call, in
    // flight or not, and two writers' worth of clicking would write two files.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    runExport(mounted);
    runExport(mounted);
    await settle();

    expect(h.of("project_export")).toHaveLength(1);
    mounted.destroy();
  });
});

describe("the project bar's strip after the retirement slice", () => {
  // The bar carries STATE - the project's name, the word count, the saved
  // indicator - and the application menu carries commands. Export, Find and
  // Preferences were each reachable from both, and two routes to one operation
  // is one route too many to keep evidence for.
  //
  // Also a geometry guard. The bar's 39px is a click-geometry constant restated
  // in five rigs; a button put back in the strip changes its line box and every
  // one of them goes on pressing coordinates it computed rather than rows a
  // writer sees, silently, reporting plausible numbers.
  // Comments stripped FIRST. The strip's own comments explain at length why
  // #export-controls is gone and where the buttons went, so a raw search finds
  // every string this test is asserting the absence of - the theme.test.ts
  // parse-the-prose trap, one file over.
  const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8").replace(
    /<!--[\s\S]*?-->/g,
    "",
  );

  test("the panel anchors hold no command buttons, and export has no anchor at all", async () => {
    shell();
    // In the page but not in SHELL_IDS: mountProject does not read it, and this
    // test is about the strip rather than about what mountProject requires.
    const prefs = document.createElement("span");
    prefs.id = "prefs-controls";
    document.body.appendChild(prefs);
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    // A direct child, which is what a re-added toggle would be: #find-panel is
    // a child here too and its Search button is inside it, one level down.
    for (const id of ["find-controls", "prefs-controls"]) {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`no #${id} in the shell`);
      expect(el.querySelectorAll(":scope > button")).toHaveLength(0);
    }
    expect(document.getElementById("export-controls")).toBeNull();

    mounted.destroy();
    prefs.remove();
  });

  test("index.html declares no export anchor and no button in the bar", () => {
    // The DOM half above can only see what mountProject builds; the preferences
    // panel is main.ts's and a toggle re-added to the markup would be invisible
    // to it. #menu-controls is filled at runtime, so a static <button> anywhere
    // in this strip is a bar control by construction.
    const bar = html.slice(html.indexOf('<div id="project-bar">'), html.indexOf('<div id="nav">'));
    expect(bar).toContain('id="find-controls"');
    expect(bar).toContain('id="prefs-controls"');
    expect(bar).not.toContain("export-controls");
    // The one static button is the scene's name, which opens Go to:
    // what the writer is looking at, not a retired toggle come back.
    const scene = '<button id="scene-name" type="button" hidden></button>';
    expect(bar).toContain(scene);
    expect(bar.replace(scene, "")).not.toMatch(/<button\b/);
  });
});

describe("the bubble toolbar", () => {
  test("mounts on the body, hidden, and is gone after destroy()", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    const bubble = document.getElementById("format-bubble");
    expect(bubble).not.toBeNull();
    expect(bubble?.parentElement).toBe(document.body);
    expect((bubble as HTMLElement).hidden).toBe(true);

    mounted.destroy();
    expect(document.getElementById("format-bubble")).toBeNull();
  });
  // A "selection while unfocused never shows it" test lived here and was
  // deleted: it awaited one microtask against a real 250ms debounce and
  // selectionRect() is always null under happy-dom, so it passed for an
  // implementation that ignored `focused` entirely. The focus half of
  // bubbleWanted is pinned by bubble-placement.test.ts's own bubbleWanted
  // test, and by format-bubble.test.ts's null-rect and blur/focusout tests,
  // all of which exercise it without a vacuous timing assumption.
});

describe("a document this build cannot read", () => {
  // THE OTHER HALF OF THE SCHEMA CHANGE. `underline` is a mark this build
  // writes and an older one has no type for, so a file can now be legal here
  // and unreadable there -- and the same shape reaches THIS build the day a
  // newer one adds a mark of its own. `schema.nodeFromJSON` answers with a
  // RangeError, and every load site used to hand a parsed body straight in.
  const FUTURE = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "alpha", marks: [{ type: "highlight" }] }],
      },
    ],
  });

  test("the mount refuses it by name instead of throwing a schema error", async () => {
    shell();
    const h = host({ bodies: { "scene-0": FUTURE } });
    let message = "";
    try {
      await mountProject(deps({ invoke: h.invoke }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The document is NAMED, and the sentence says what is wrong rather than
    // naming a ProseMirror type nobody can act on. A blank window with
    // "There is no mark type highlight in this schema" behind it is what this
    // replaces.
    expect(message).toContain("scene-0");
    expect(message).not.toContain("nodeFromJSON");
    expect(message.length).toBeGreaterThan(0);
  });

  test("an ordinary body still mounts (the control)", async () => {
    // Without this the test above passes for a page that refuses every
    // document, which is a worse application than the one that crashes on one.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.destroy();
  });

  test("every replaceDoc in this file asks before it swaps", () => {
    // A STRUCTURAL GUARD, and it is here because the other two load sites are
    // not reachable from a test: they are called from a snapshot restore and
    // from a manuscript-wide replace, both behind panels this file does not
    // build. `readableBody` is unit-tested in editor-marks.test.ts; what this
    // asserts is that project.ts USES it at every swap, which is the half a
    // mutation would otherwise delete unnoticed.
    //
    // Comments are stripped first: this file's prose names `JSON.parse` and
    // `replaceDoc` repeatedly, and a guard reading raw text would find its
    // target in the sentence explaining the target.
    const source = readFileSync(join(import.meta.dir, "..", "src", "project.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const bare = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const swaps = [...bare.matchAll(/editor\.replaceDoc\(([^;]*)\)/g)].map((m) => m[1] ?? "");
    // VACUITY GUARD: a regex that matched nothing would pass this file while
    // proving the opposite of what it claims.
    expect(swaps.length).toBeGreaterThanOrEqual(2);
    for (const argument of swaps) {
      expect(argument).not.toContain("JSON.parse");
    }
    expect(bare).toContain("readableBody");
  });
});

describe("banner tone", () => {
  // EVERY SUCCESS MESSAGE WAS PAINTED IN THE FAILURE SURFACE until this split.
  // One `banner()` raised a full-width red role="alert" div with no dismiss
  // control and no timeout, and raiseNotice used it for good news as well as
  // problems - so "Exported to /path/book.md" interrupted a screen reader as an
  // alert, was painted the same red as a save failure, and sat across the top of
  // the application for the rest of the session. Three shipped features reported
  // success that way.
  //
  // The three tones are the contract. These tests read the ATTRIBUTES the page
  // and the accessibility tree key on - `role` and `data-tone` - because that is
  // what a screen reader and the stylesheet each act on, and because happy-dom
  // does no layout, so nothing here can honestly assert on colour.

  /** `announce` is exposed on MountedProject for units mounted outside this
   *  function (the switcher, in main.ts), but the export bar's own onDone is
   *  the shipped path a unit mounted BY mountProject actually takes, so it is
   *  the one worth driving here. */
  const announceViaExport = async (mounted: MountedProject): Promise<void> => {
    mounted.menuActions.exportProject();
    await micro();
  };

  afterEach(() => {
    // Banners are prepended to <body>, not into the shell, so tearDownShell
    // does not reach them and one left standing leaks into every later file.
    for (const el of [...document.querySelectorAll(".app-banner")]) el.remove();
    jest.useRealTimers();
  });

  test("a success renders as success and status, never as an alert", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await announceViaExport(mounted);

    const el = document.getElementById("open-error");
    expect(el?.dataset.tone).toBe("success");
    expect(el?.getAttribute("role")).toBe("status");
    // Stated as its own assertion rather than left implicit in the line above:
    // "role is status" and "role is not alert" read the same only while there
    // are exactly two roles in play, and a third would break that quietly.
    expect(el?.getAttribute("role")).not.toBe("alert");
    expect(el?.className).toBe("app-banner");
    mounted.destroy();
  });

  test("a failure renders as failure and alert", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseFailure("disk is full");

    const el = document.getElementById("persist-error");
    expect(el?.dataset.tone).toBe("failure");
    expect(el?.getAttribute("role")).toBe("alert");
    expect(el?.className).toBe("app-banner");
    mounted.destroy();
  });

  test("a problem renders as problem and status", async () => {
    // A failed open is not a failed save. It is polite - it must not interrupt
    // what a screen reader is reading - and it is not good news either.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseNotice("could not open that document");

    const el = document.getElementById("open-error");
    expect(el?.dataset.tone).toBe("problem");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.getAttribute("role")).not.toBe("alert");
    mounted.destroy();
  });

  test("the three tones are the whole set, and each id carries the one it should", async () => {
    // One mount, all three raised, so a page that hard-coded a single tone
    // somewhere central cannot satisfy this by satisfying the tests above one
    // at a time.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    await announceViaExport(mounted);
    expect(document.getElementById("open-error")?.dataset.tone).toBe("success");
    mounted.raiseNotice("could not open that document");
    expect(document.getElementById("open-error")?.dataset.tone).toBe("problem");
    mounted.raiseFailure("disk is full");
    expect(document.getElementById("persist-error")?.dataset.tone).toBe("failure");

    expect(bannerIds().sort()).toEqual(["open-error", "persist-error"]);
    mounted.destroy();
  });

  test("a problem carries a dismiss button, and clicking it removes the banner", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseNotice("could not open that document");

    const close = document
      .getElementById("open-error")
      ?.querySelector<HTMLButtonElement>("button.app-banner-dismiss");
    // A COUNT, never the node: printing a happy-dom element on failure is
    // megabytes of getters and times the runner out, which the harness reads as
    // a passing mutation. Recorded gotcha; every assertion in this block obeys
    // it, including the ones that pass today.
    expect(dismissCount("open-error")).toBe(1);
    // A control with no accessible name is a control a screen-reader user
    // cannot use, and the visible glyph is punctuation.
    expect(close?.getAttribute("aria-label")).toBe("dismiss this message");
    // type=button, or a banner raised inside a form would submit it.
    expect(close?.getAttribute("type")).toBe("button");

    close?.click();
    expect(bannerIds()).not.toContain("open-error");
    mounted.destroy();
  });

  test("an info banner carries a dismiss button, and clicking it removes the banner", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await announceViaExport(mounted);

    const close = document
      .getElementById("open-error")
      ?.querySelector<HTMLButtonElement>("button.app-banner-dismiss");
    expect(dismissCount("open-error")).toBe(1);

    close?.click();
    expect(bannerIds()).not.toContain("open-error");
    mounted.destroy();
  });

  test("a FAILURE carries no dismiss control at all", async () => {
    // A failure means editing is paused. A writer who waves it away has hidden
    // the one thing telling them their work is not being saved, and nothing
    // else in the page says so.
    //
    // WRITTEN SO RE-ADDING ONE FAILS. Not `querySelector(".app-banner-dismiss")
    // is null` alone: that passes the moment someone adds a dismiss control
    // under a different class, or an <a>, or a click handler on the banner
    // itself. The banner must hold NO clickable descendant, and clicking every
    // element in it must leave it standing.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseFailure("disk is full");

    const el = document.getElementById("persist-error");
    expect(bannerIds()).toContain("persist-error");
    expect(el?.querySelectorAll(".app-banner-dismiss")).toHaveLength(0);
    expect(el?.querySelectorAll("button, a, [role='button']")).toHaveLength(0);

    for (const child of [...el!.querySelectorAll<HTMLElement>("*")]) child.click();
    el!.click();
    expect(bannerIds()).toContain("persist-error");
    expect(document.getElementById("persist-error")?.dataset.tone).toBe("failure");
    mounted.destroy();
  });

  test("an info banner takes itself away, and a problem does not", async () => {
    // Good news goes away on its own; a problem is something the writer has to
    // read, and may need in front of them while they work out what happened.
    //
    // FAKE TIMERS, installed only around the raise. `settle()` is a real
    // setTimeout and would never resolve under them - so this block settles by
    // microtask (`micro`) and the mount happens first, on real timers.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    jest.useFakeTimers();
    await announceViaExport(mounted);
    expect(document.getElementById("open-error")?.dataset.tone).toBe("success");
    // Just short of the timeout: still standing. Without this the test would
    // pass against a banner removed synchronously, which is a different
    // behaviour and a worse one.
    jest.advanceTimersByTime(5999);
    expect(bannerIds()).toContain("open-error");
    jest.advanceTimersByTime(2);
    expect(bannerIds()).not.toContain("open-error");

    mounted.raiseNotice("could not open that document");
    jest.advanceTimersByTime(60_000);
    expect(document.getElementById("open-error")?.dataset.tone).toBe("problem");

    jest.useRealTimers();
    mounted.destroy();
  });

  test("a failure does not take itself away either", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    jest.useFakeTimers();
    mounted.raiseFailure("disk is full");
    jest.advanceTimersByTime(60_000);
    expect(document.getElementById("persist-error")?.dataset.tone).toBe("failure");
    jest.useRealTimers();
    mounted.destroy();
  });

  test("a second banner on the same id cannot be removed by the first one's timer", async () => {
    // THE REAL HAZARD. The pending timer closes over the element it was armed
    // for, and `banner()` clears `noticeTimer` before raising anything - so a
    // replacement is safe twice over. Pinned because the obvious wrong
    // implementation (a timer that removes by id) would take the SECOND banner
    // away at the first one's deadline, and the writer would watch a problem
    // they had not read disappear.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    jest.useFakeTimers();
    await announceViaExport(mounted);
    expect(document.getElementById("open-error")?.dataset.tone).toBe("success");

    // Most of the way to the first banner's deadline, then replace it.
    jest.advanceTimersByTime(5000);
    mounted.raiseNotice("could not open that document");
    expect(document.getElementById("open-error")?.dataset.tone).toBe("problem");

    // Past the moment the FIRST banner would have gone.
    jest.advanceTimersByTime(2000);
    expect(document.getElementById("open-error")?.dataset.tone).toBe("problem");
    expect(labelOf("open-error")).toBe("could not open that document");
    // And past the deadline it would have had if raising it re-armed one.
    jest.advanceTimersByTime(60_000);
    expect(document.getElementById("open-error")?.dataset.tone).toBe("problem");
    expect(document.querySelectorAll("#open-error")).toHaveLength(1);

    jest.useRealTimers();
    mounted.destroy();
  });

  test("a failure raised while an info is pending does NOT strand the info banner", async () => {
    // The timers are keyed by banner id. A single shared one was cleared on
    // EVERY raise, including a raise for a different id - so a failure arriving
    // while a piece of good news was counting down took that news's timer away
    // and left it on screen until the project was destroyed. A smaller version
    // of the defect the tones were introduced to fix: a success message that
    // will not go away.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    jest.useFakeTimers();
    await announceViaExport(mounted);
    mounted.raiseFailure("disk is full");
    // The info banner's own timer is untouched by the failure's raise.
    jest.advanceTimersByTime(60_000);

    expect(document.getElementById("open-error")).toBeNull();
    // The failure has no timer and must still be there: it means editing is
    // paused, and it is the one message that does not take itself away.
    expect(document.getElementById("persist-error")?.dataset.tone).toBe("failure");

    jest.useRealTimers();
    mounted.destroy();
    expect(bannerIds()).toEqual([]);
  });

  test("destroy() clears a pending info timer, so it cannot fire into the next project", async () => {
    // The element is prepended to <body>, not to anything this project owns, so
    // a timer left running would fire after the next project mounted and remove
    // whatever IT had raised under the same id. The comment on noticeTimers
    // claimed this was done long before it was.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));

    jest.useFakeTimers();
    await announceViaExport(mounted);
    mounted.destroy();
    // A second project's banner, under the same id, raised after the teardown.
    const survivor = document.createElement("div");
    survivor.id = "open-error";
    document.body.prepend(survivor);
    jest.advanceTimersByTime(60_000);
    expect(document.getElementById("open-error")).not.toBeNull();

    jest.useRealTimers();
    survivor.remove();
  });

  test("destroy removes a banner of every tone", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await announceViaExport(mounted);
    mounted.raiseFailure("disk is full");
    expect(bannerIds()).toHaveLength(2);

    mounted.destroy();

    expect(bannerIds()).toEqual([]);
  });
});

describe("a banner's message survives to the accessibility layer", () => {
  test("the message is the element's accessible name, not only its text", async () => {
    // MEASURED, not assumed: once the text moved into a child span to make room
    // for the dismiss button, an AT-SPI subtree walk of this element yielded
    // only "dismiss this message". WebKitGTK prunes untyped generic containers,
    // so the span carrying the news was dropped and a screen-reader user got a
    // live region announcing the control and not the content. happy-dom cannot
    // see that; what it can see is whether the name is set at all.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseNotice("Could not open that document: gone");
    const el = document.getElementById("open-error");
    expect(el?.getAttribute("aria-label")).toBe("Could not open that document: gone");
    // And the dismiss control's own name is NOT the banner's.
    expect(el?.getAttribute("aria-label")).not.toContain("dismiss");
    mounted.destroy();
  });

  test("a failure's message is its accessible name too", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    mounted.raiseFailure("disk is full");
    expect(document.getElementById("persist-error")?.getAttribute("aria-label")).toContain(
      "disk is full",
    );
    mounted.destroy();
  });
});

describe("navigation history", () => {
  /** Opens a scene the way a writer does: a real click on its navigator row. */
  async function clickRow(itemId: string): Promise<void> {
    const row = document.querySelector(`[data-item-id="${itemId}"]`);
    if (!(row instanceof HTMLElement)) throw new Error(`${itemId} is not mounted`);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  }

  /** The chord, dispatched from wherever focus is. `target` is the element the
   *  keystroke is aimed at, because the whole rule is about where the caret is:
   *  the outline and any text field keep these two keys for themselves. */
  async function chord(key: "ArrowLeft" | "ArrowRight", target?: Element): Promise<void> {
    const event = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
    (target ?? document.body).dispatchEvent(event);
    await settle();
  }

  /** Which scenes were loaded, in order. The store is the only honest witness:
   *  the page's own account of which document is open is what is under test. */
  const loaded = (h: Host): string[] => h.of("doc_load").map((c) => String(c.args?.itemId));

  test("Alt+Left goes back to the scene the writer came from", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await clickRow("scene-1");
    expect(loaded(h)).toEqual(["scene-0", "scene-1"]);

    await chord("ArrowLeft");
    expect(loaded(h)).toEqual(["scene-0", "scene-1", "scene-0"]);
    mounted.destroy();
  });

  test("Alt+Right returns to where Back was pressed from", async () => {
    // The end-to-end shape of the rule the pure module's own test pins: the open
    // that Back causes must not push an entry, or Forward has nowhere to go.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await clickRow("scene-1");
    await chord("ArrowLeft");
    await chord("ArrowRight");
    expect(loaded(h)).toEqual(["scene-0", "scene-1", "scene-0", "scene-1"]);
    mounted.destroy();
  });

  test("Back at the start of the trail says so instead of doing nothing", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await chord("ArrowLeft");
    expect(loaded(h)).toEqual(["scene-0"]);
    expect(labelOf("open-error")).toBe("Nothing earlier to go back to.");
    mounted.destroy();
  });

  test("Forward at the end of the trail says so instead of doing nothing", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await clickRow("scene-1");
    await chord("ArrowRight");
    expect(loaded(h)).toEqual(["scene-0", "scene-1"]);
    expect(labelOf("open-error")).toBe("Nothing further forward.");
    mounted.destroy();
  });

  test("the chord is ignored while the caret is in a text field", async () => {
    // Alt+Left in a rename field or a find query is caret movement. Taking the
    // writer to another scene from under a field they are typing in is not what
    // they asked for, and they cannot undo having left.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await clickRow("scene-1");
    const field = document.createElement("input");
    document.body.append(field);
    try {
      await chord("ArrowLeft", field);
      expect(loaded(h)).toEqual(["scene-0", "scene-1"]);
      // And nothing was said either: a refusal to act is different from a trail
      // with nothing behind it.
      expect(bannerIds()).not.toContain("open-error");
    } finally {
      field.remove();
      mounted.destroy();
    }
  });

  test("the chord is left to the outline while the outline has focus", async () => {
    // The navigator has bound Alt+Left and Alt+Right to outdent and indent since
    // the outline slice. There they reshape a row; everywhere else they walk the
    // trail. Whichever one you get is decided by where the caret is.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await clickRow("scene-1");
    const row = document.querySelector('[data-item-id="scene-1"]');
    if (!(row instanceof HTMLElement)) throw new Error("scene-1 is not mounted");
    await chord("ArrowLeft", row);
    expect(loaded(h)).toEqual(["scene-0", "scene-1"]);

    // AND NOT ONLY BECAUSE THE NAVIGATOR CALLED preventDefault. It only does so
    // when it has a row to act on, and a rule that reads "the outline owns these
    // keys" must not be an accident of whether the outline happened to move
    // something. A non-cancelable press is the one input that tells the two
    // guards apart.
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: false }),
    );
    await settle();
    expect(loaded(h)).toEqual(["scene-0", "scene-1"]);
    mounted.destroy();
  });

  test("the menu is told whether either direction can act", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    // One entry: nowhere to go in either direction.
    expect(mounted.menuActions.canNavBack()).toBe(false);
    expect(mounted.menuActions.canNavForward()).toBe(false);

    await clickRow("scene-1");
    expect(mounted.menuActions.canNavBack()).toBe(true);
    expect(mounted.menuActions.canNavForward()).toBe(false);

    mounted.menuActions.navBack();
    await settle();
    expect(mounted.menuActions.canNavBack()).toBe(false);
    expect(mounted.menuActions.canNavForward()).toBe(true);
    mounted.destroy();
  });

  test("a scene that has left the manuscript is skipped, not a dead end", async () => {
    // The trail names item ids and the walk decides which of them still exist.
    // Here scene-1 goes into the bin while the writer is somewhere else, so Back
    // must step straight over it rather than reporting that there is nothing
    // behind them.
    shell();
    // The Trash root FIRST in the walk, because liveItemsIn is one forward pass
    // carrying a set of excluded ids: a row is only dropped if its bin ancestor
    // has already gone by.
    const binned: ProjectItem[] = [
      { id: "trash", parent_id: null, type: "trash", title: "Trash", position: "9999", rev: 1, state: null, depth: 0 },
      ...walk(),
      { id: "scene-2", parent_id: "chapter-0", type: "scene", title: "Return", position: "0002", rev: 1, state: null, depth: 2 },
    ];
    const h = host({ items: binned });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await clickRow("scene-1");
    await clickRow("scene-2");
    expect(loaded(h)).toEqual(["scene-0", "scene-1", "scene-2"]);

    // scene-1 is now under the Trash root, so liveItemsIn drops it.
    const row = binned.find((item) => item.id === "scene-1");
    if (row === undefined) throw new Error("scene-1 left the fixture");
    row.parent_id = "trash";
    await chord("ArrowLeft");
    expect(loaded(h)).toEqual(["scene-0", "scene-1", "scene-2", "scene-0"]);
    mounted.destroy();
  });

  test("destroy removes the document listener the chord is bound to", async () => {
    // On the document, so it outlives every element this mount owns. A leaked
    // copy answers Alt+Left after a project switch by opening an item id from
    // the manuscript the writer left, in the navigator the next project has
    // mounted - and nothing in the DOM would show it. Counting is what finds it,
    // as it was for the menu bar.
    shell();
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    let live = 0;
    document.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      if (args[0] === "keydown") live += 1;
      return realAdd(...args);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      if (args[0] === "keydown") live -= 1;
      return realRemove(...args);
    }) as typeof document.removeEventListener;
    try {
      const h = host();
      const before = live;
      const mounted = await mountProject(deps({ invoke: h.invoke }));
      expect(live).toBeGreaterThan(before);
      mounted.destroy();
      expect(live).toBe(before);
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });
});

describe("comments reach the editor and the flush", () => {
  const noteRow = {
    id: 7,
    item_id: "scene-0",
    body: "does she know yet?",
    anchor_from: 1,
    anchor_to: 4,
    quote: "alp",
    orphaned: false,
    resolved: false,
    created_at: 0,
    updated_at: 0,
  };

  test("the open scene's notes are read at mount", async () => {
    // The underlines are the surface a writer sees WITHOUT asking, so a scene
    // that opened with none of them would say there are none.
    shell();
    const h = host({ comments: { "scene-0": [noteRow] } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(h.of("comment_list").map((c) => c.args?.itemId)).toContain("scene-0");
    expect(document.getElementById("scene-notes")?.textContent).toBe("1");

    mounted.destroy();
  });

  test("the fixed count opens the existing list and follows a resolved row", async () => {
    shell();
    const h = host({ comments: { "scene-0": [noteRow] } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    const notes = document.querySelector<HTMLButtonElement>("#scene-notes");
    notes?.click();
    await settle();
    expect(document.getElementById("comments-panel")?.hidden).toBe(false);

    document.querySelector<HTMLButtonElement>(".comment-resolve")?.click();
    await settle();
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(true);

    mounted.destroy();
    expect(document.getElementById("scene-notes")).toBeNull();
  });

  test("binning the open scene clears its count without a document activation", async () => {
    shell();
    const trash: ProjectItem = {
      id: "trash",
      parent_id: null,
      type: "trash",
      title: "Trash",
      position: "9999",
      rev: 1,
      state: null,
      depth: 0,
    };
    const initial = [...walk(), trash];
    const binned = [
      ...walk().filter((item) => item.id !== "scene-0"),
      trash,
      { ...walk()[2]!, parent_id: "trash", depth: 1 },
    ];
    const h = host({ items: initial, comments: { "scene-0": [noteRow] } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(false);

    initial.splice(0, initial.length, ...binned);
    await mounted.outline?.remove("scene-0");
    await settle();
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(true);

    mounted.destroy();
  });

  test("a held listing cannot restore the count after its scene is binned", async () => {
    shell();
    const trash: ProjectItem = {
      id: "trash", parent_id: null, type: "trash", title: "Trash", position: "9999", rev: 1, state: null, depth: 0,
    };
    const initial = [...walk(), trash];
    const binned = [...walk().filter((item) => item.id !== "scene-0"), trash, { ...walk()[2]!, parent_id: "trash", depth: 1 }];
    const h = host({ items: initial, comments: { "scene-0": [noteRow] } });
    const release: { fn: (() => void) | null } = { fn: null };
    const held = new Promise<void>((resolve) => { release.fn = resolve; });
    const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (cmd === "comment_list" && args?.itemId === "scene-0") await held;
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();

    initial.splice(0, initial.length, ...binned);
    await mounted.outline?.remove("scene-0");
    release.fn?.();
    await settle();

    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(true);
    mounted.destroy();
  });

  test("opening another scene reads that scene's notes", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const before = h.of("comment_list").length;

    const row = document.querySelector('[data-item-id="scene-1"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    const asked = h.of("comment_list").slice(before).map((c) => c.args?.itemId);
    expect(asked).toContain("scene-1");

    mounted.destroy();
  });

  test("restoring a version reloads the open scene's notes", async () => {
    // `applyRestored` calls replaceDoc, which builds a fresh EditorState and
    // drops the comment plugin's anchors. Without a reload the underlines are
    // gone until the writer switches scenes and back -- and after the store
    // began collapsing anchors on a restore, this is also how the writer is
    // told which notes the restore orphaned.
    shell();
    const h = host({
      comments: { "scene-0": [noteRow] },
      versions: [{ id: 3, created_at: 0, words: 12, snapshot_label: null, snapshot_id: null }],
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.menuActions.openReference();
    await settle();
    mounted.menuActions.openHistory();
    await settle();
    await settle();
    const before = h.of("comment_list").length;

    const restore = document.querySelector<HTMLButtonElement>(".history-restore");
    expect(restore).not.toBeNull();
    restore?.click();
    await settle();
    await settle();

    // THE CALL, not the editor's anchors: the fake holds whatever the last
    // setCommentAnchors left it, which is the mount's, so an end-state
    // assertion passes whether or not the reload ran.
    expect(h.of("doc_restore").length).toBe(1);
    const asked = h.of("comment_list").slice(before).map((c) => c.args?.itemId);
    expect(asked).toContain("scene-0");
    // History is the inspector and shares the column, so opening it
    // closed the reference rail the restore would otherwise have marked stale.
    expect(document.querySelector<HTMLElement>("#reference-rail")?.hidden).toBe(true);

    mounted.destroy();
  });

  test("ACCEPTING A CHANGE FROM THE READABLE FOLDER RELOADS THE OPEN SCENE'S NOTES", async () => {
    // THE FOURTH `replaceDoc` PATH. An earlier plan's write-back ends "THERE ARE NOW
    // THREE `replaceDoc` PATHS. A fourth is where this comes back", and this is
    // it: the host has rewritten a body and collapsed that document's comment
    // anchors in the same transaction, so the underlines the plugin is holding
    // describe prose that no longer exists.
    //
    // THE CALL, NOT AN END STATE, for the reason the two tests above record:
    // the editor fake holds whatever the last setCommentAnchors left it, so an
    // assertion on its anchors passes whether or not the reload ran. And it is
    // driven through the SHIPPED panel and a real click, so a wiring that never
    // reaches the unit fails here rather than passing against a direct call.
    shell();
    const h = host({
      comments: { "scene-0": [noteRow] },
      mirrorRows: [
        {
          id: "scene-0",
          path: "0000-One/0000-Arrival.md",
          was_path: null,
          state: "prose",
          title: "Arrival",
          file_title: null,
          store_body: body("what the book has"),
          file_body: body("what the file has"),
          error: null,
          can_accept: true,
          store_underlined: 0,
        },
      ],
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.menuActions.openReference();
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    await settle();
    const before = h.of("comment_list").length;

    const accept = document.querySelector<HTMLButtonElement>(".mirror-change-accept");
    expect(accept).not.toBeNull();
    accept?.click();
    await settle();
    await settle();

    expect(h.of("mirror_accept").length).toBe(1);
    expect(h.of("mirror_accept")[0]?.args?.ids).toEqual(["scene-0"]);
    // Reloaded through doc_load, which is what reloadOpenDocument does, and the
    // notes with it.
    const asked = h.of("comment_list").slice(before).map((c) => c.args?.itemId);
    expect(asked).toContain("scene-0");
    expect(document.querySelector("#reference-rail .reference-revision")?.textContent).toContain("refresh");

    mounted.destroy();
  });

  test("the accept sends the host IDS and nothing that could decide what is written", async () => {
    // The boundary the host's own refusal rests on. A body, a path or a
    // revision on this call would be the webview naming what gets written into
    // the manuscript; ids alone leave the decision where `accept_plan` is.
    shell();
    const h = host({
      mirrorRows: [
        {
          id: "scene-0",
          path: "0000-One/0000-Arrival.md",
          was_path: null,
          state: "prose",
          title: "Arrival",
          file_title: null,
          store_body: body("what the book has"),
          file_body: body("what the file has"),
          error: null,
          can_accept: true,
          store_underlined: 0,
        },
      ],
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle();
    await settle();
    await settle();
    expect(document.querySelector<HTMLButtonElement>(".mirror-change-undo")).not.toBeNull();

    expect(Object.keys(h.of("mirror_accept")[0]?.args ?? {})).toEqual(["ids"]);
    mounted.destroy();
  });

  test("mirror undo locks the active editor before drain and blocks a new opener", async () => {
    shell();
    let releaseFlush = (): void => undefined;
    const flushing = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const h = host({
      mirrorRows: [{ id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }],
    });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_flush") await flushing;
      if (cmd === "mirror_undo_accept") return h.invoke(cmd, args);
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle();
    await settle();
    await settle();
    expect(document.querySelector<HTMLButtonElement>(".mirror-change-undo")).not.toBeNull();
    mounted.editor.typeChar("x");
    const before = mounted.editor.serialize();
    document.querySelector<HTMLButtonElement>(".mirror-change-undo")?.click();
    await micro();
    mounted.editor.typeChar("y");
    expect(mounted.editor.serialize()).toBe(before);
    const other = document.querySelector<HTMLElement>("[data-item-id='scene-1']");
    expect(other).not.toBeNull();
    other?.click();
    expect(h.of("doc_load").filter((call) => call.args?.itemId === "scene-1")).toHaveLength(0);
    releaseFlush();
    await settle();
    await settle();
    await settle();
    expect(h.of("mirror_undo_accept")).toHaveLength(1);
    expect(h.of("mirror_undo_accept")[0]!.args).toEqual({
      generation: 1, itemId: "scene-0", versionId: 10, snapshotId: 9, acceptedRev: 8,
    });
    expect(mounted.flusher?.revOf("scene-0")).toBe(9);
    const restored = mounted.editor.serialize();
    mounted.editor.typeChar("z");
    expect(mounted.editor.serialize()).not.toBe(restored);
    mounted.destroy();
  });

  test("an opener already in flight refuses mirror undo before drain or IPC", async () => {
    shell();
    let releaseOpen = (): void => undefined;
    let openerEntered = false;
    const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const h = host({ mirrorRows: [{ id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }] });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_load" && args?.itemId === "scene-1") {
        openerEntered = true;
        await opening;
      }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle();
    const other = document.querySelector<HTMLElement>("[data-item-id='scene-1']");
    expect(other).not.toBeNull();
    other?.click();
    await micro();
    expect(openerEntered).toBe(true);
    const flushes = h.of("doc_flush").length;
    document.querySelector<HTMLButtonElement>(".mirror-change-undo")?.click();
    await settle();
    expect(h.of("mirror_undo_accept")).toHaveLength(0);
    expect(h.of("doc_flush")).toHaveLength(flushes);
    releaseOpen();
    await settle();
    mounted.destroy();
  });

  test("a failed drain refuses mirror undo and leaves the unsaved editor body alone", async () => {
    shell();
    const h = host({ mirrorRows: [{ id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }] });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_flush") {
        await h.invoke(cmd, args);
        throw new Error("disk full");
      }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle();
    await settle();
    await settle();
    mounted.editor.typeChar("x");
    const unsaved = mounted.editor.serialize();
    document.querySelector<HTMLButtonElement>(".mirror-change-undo")?.click();
    await settle();
    expect(h.of("mirror_undo_accept")).toHaveLength(0);
    expect(mounted.editor.serialize()).toBe(unsaved);
    mounted.destroy();
  });

  test("a deferred undo reply keeps the active editor locked and unlocks after apply", async () => {
    shell();
    let release = (): void => undefined;
    let entered = false;
    const reply = new Promise<void>((resolve) => { release = resolve; });
    const h = host({ mirrorRows: [{ id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }] });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "mirror_undo_accept") {
        entered = true;
        await reply;
      }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle(); await settle(); await settle();
    const undo = document.querySelector<HTMLButtonElement>(".mirror-change-undo");
    expect(undo).not.toBeNull();
    undo?.click();
    await micro();
    expect(entered).toBe(true);
    const locked = mounted.editor.serialize();
    mounted.editor.typeChar("x");
    expect(mounted.editor.serialize()).toBe(locked);
    const other = document.querySelector<HTMLElement>("[data-item-id='scene-1']");
    expect(other).not.toBeNull();
    other!.click();
    await settle();
    expect(h.of("doc_load").filter((call) => call.args?.itemId === "scene-1")).toHaveLength(0);
    release();
    await settle(); await settle();
    const restored = mounted.editor.serialize();
    mounted.editor.typeChar("y");
    expect(mounted.editor.serialize()).not.toBe(restored);
    mounted.destroy();
  });

  test("a background undo leaves the active editor writable and unchanged", async () => {
    shell();
    let release = (): void => undefined;
    let entered = false;
    const reply = new Promise<void>((resolve) => { release = resolve; });
    const h = host({ mirrorRows: [{ id: "scene-1", path: "b.md", was_path: null, state: "prose", title: "Departure", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }] });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "mirror_undo_accept") { entered = true; await reply; }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle(); await settle(); await settle();
    const undo = document.querySelector<HTMLButtonElement>(".mirror-change-undo");
    expect(undo).not.toBeNull();
    const before = mounted.editor.serialize();
    undo?.click();
    await micro();
    expect(entered).toBe(true);
    mounted.editor.typeChar("x");
    const typed = mounted.editor.serialize();
    expect(typed).not.toBe(before);
    release();
    await settle(); await settle();
    expect(mounted.editor.serialize()).toBe(typed);
    mounted.destroy();
  });

  test("a host undo refusal unlocks the editor and keeps its handle", async () => {
    shell();
    const h = host({ mirrorRows: [{ id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }] });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "mirror_undo_accept") throw new Error("conflict");
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle(); await settle(); await settle();
    const undo = document.querySelector<HTMLButtonElement>(".mirror-change-undo");
    expect(undo).not.toBeNull();
    undo?.click();
    await settle();
    expect(document.querySelector<HTMLButtonElement>(".mirror-change-undo")).not.toBeNull();
    const before = mounted.editor.serialize();
    mounted.editor.typeChar("x");
    expect(mounted.editor.serialize()).not.toBe(before);
    mounted.destroy();
  });

  test("destroy during a deferred undo reply does not apply its late body", async () => {
    shell();
    let release = (): void => undefined;
    let entered = false;
    const reply = new Promise<void>((resolve) => { release = resolve; });
    const h = host({ mirrorRows: [{ id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 }] });
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "mirror_undo_accept") { entered = true; await reply; }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle(); await settle(); await settle();
    const undo = document.querySelector<HTMLButtonElement>(".mirror-change-undo");
    expect(undo).not.toBeNull();
    undo?.click();
    await micro();
    expect(entered).toBe(true);
    const scheduler = mounted.flusher!;
    const revision = scheduler.revOf("scene-0");
    const editor = mounted.editor;
    const before = editor.serialize();
    mounted.destroy();
    release();
    await settle(); await settle();
    expect(mounted.flusher).toBeNull();
    expect(scheduler.revOf("scene-0")).toBe(revision);
    expect(editor.serialize()).toBe(before);
  });

  test("restoring a snapshot reloads the open scene's notes", async () => {
    // The other replaceDoc path: a snapshot restore goes through
    // reloadOpenDocument rather than applyRestored, and had the same omission.
    shell();
    const h = host({
      comments: { "scene-0": [noteRow] },
      snapshots: [{ id: 5, label: "act one", created_at: 0, documents: 2 }],
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.menuActions.openReference();
    await settle();
    mounted.menuActions.openHistory();
    await settle();
    await settle();
    const before = h.of("comment_list").length;

    // Armed, then confirmed: a snapshot restore rewrites the whole manuscript
    // and takes two presses.
    const row = document.querySelector<HTMLButtonElement>(".snapshot-row");
    expect(row).not.toBeNull();
    row?.click();
    await settle();
    row?.click();
    await settle();
    await settle();

    expect(h.of("snapshot_restore").length).toBe(1);
    const asked = h.of("comment_list").slice(before).map((c) => c.args?.itemId);
    expect(asked).toContain("scene-0");
    // History is the inspector and shares the column, so opening it
    // closed the reference rail the restore would otherwise have marked stale.
    expect(document.querySelector<HTMLElement>("#reference-rail")?.hidden).toBe(true);

    mounted.destroy();
  });

  test("a flush carries the open scene's anchors", async () => {
    shell();
    const h = host({ comments: { "scene-0": [noteRow] } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.editor.typeChar("x");
    await mounted.flusher?.drain();

    const entries = h.flushed();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.comments?.map((c) => c.id)).toEqual([7]);

    mounted.destroy();
  });

  test("a scene with no notes sends nothing about them", async () => {
    // Not an empty list: "there are none" and "I am not tracking these" are
    // different claims, and the host acts on the second by leaving what it holds
    // alone.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.editor.typeChar("x");
    await mounted.flusher?.drain();

    expect(h.flushed()[0]?.comments).toBeUndefined();

    mounted.destroy();
  });

  test("a listing that fails says so and does not fail the document open", async () => {
    // A scene whose notes could not be read is still a scene the writer can
    // write in - turning a comment listing into a failed open would be the
    // larger loss.
    shell();
    const h = host({ reject: ["comment_list"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(bannerIds()).toContain("open-error");
    // And the editor is live: the prose mounted whatever the listing did.
    expect(mounted.editor.serialize().length).toBeGreaterThan(0);

    mounted.destroy();
  });

  test("a listing that lands after the writer moved on is DISCARDED", async () => {
    // Anchors for the wrong scene would underline whatever prose happens to sit
    // at those positions in the one that is open - the one failure this feature
    // must not have. A mutation deleting the guard survived every other test in
    // this file, because nothing else makes the two answers race.
    shell();
    const h = host({
      comments: {
        "scene-0": [noteRow],
        "scene-1": [],
      },
    });
    // A mutable RECORD, not a bare `let`: a local assigned only inside a closure
    // is narrowed to its initializer for the rest of the file, so `release.fn`
    // is the recorded way round the vacuity that produces.
    const release: { fn: (() => void) | null } = { fn: null };
    const held = new Promise<void>((resolve) => {
      release.fn = resolve;
    });
    const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (cmd === "comment_list" && args?.itemId === "scene-0") {
        await held;
      }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(true);

    // The writer opens another scene while scene-0's listing is still in flight.
    const row = document.querySelector('[data-item-id="scene-1"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    release.fn?.();
    await settle();

    expect(mounted.editor.commentAnchors()).toEqual([]);
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(true);

    mounted.destroy();
  });
});

describe("mountProject recovery", () => {
  // The second copy on this device. The bar says how old it is; File > Back up
  // now takes one on demand. Neither may ever reach the latched save banner:
  // a backup failure leaves the manuscript the writer is looking at untouched.
  const MINUTE = 60_000;

  test("the bar says how old the point on this device is, as the host reports it", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    const node = document.getElementById("recovery-indicator");
    expect(node?.textContent).toBe("Recovery point on this device 5 minutes ago");
    expect(node?.getAttribute("role")).toBe("group");
    // Its OWN container. #save-controls is cleared wholesale by
    // createSaveIndicator on every mount, so sharing it would wipe this span.
    expect(document.getElementById("recovery-controls")?.contains(node ?? null)).toBe(true);
    expect(document.getElementById("save-indicator")).not.toBeNull();
    mounted.destroy();
  });

  test("Back up now asks the host and reports it as news, not as an emergency", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.menuActions.backupNow();
    await settle();

    expect(h.of("project_backup_now")).toHaveLength(1);
    const el = document.getElementById("open-error");
    // The accessible name, which banner() sets to the message alone: textContent
    // also carries the dismiss button's glyph.
    expect(el?.getAttribute("aria-label")).toBe("Recovery point taken on this device.");
    expect(el?.dataset.tone).toBe("success");
    expect(el?.getAttribute("role")).toBe("status");
    mounted.destroy();
  });

  test("a refused backup is a notice and does NOT latch the save banner", async () => {
    // A backup failure is not a save failure. raiseFailure latches
    // persistError, so routing one through it would suppress the banner for a
    // genuine autosave failure afterwards - the only case that surface exists
    // for - while nothing about the manuscript is at risk.
    shell();
    const h = host({ reject: ["project_backup_now"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    mounted.menuActions.backupNow();
    await settle();

    const el = document.getElementById("open-error");
    expect(el?.getAttribute("aria-label")).toBe(
      "Could not take a recovery point: project_backup_now refused",
    );
    expect(el?.dataset.tone).toBe("problem");
    expect(el?.getAttribute("role")).not.toBe("alert");
    expect(document.getElementById("persist-error")).toBeNull();
    expect(mounted.persistError()).toBeNull();
    mounted.destroy();
  });

  test("the host's event makes the page re-read the files", async () => {
    // No payload: the files are the source of truth, and a payload can
    // disagree with them.
    shell();
    const h = host();
    // A LIST PER EVENT, not one slot. Two units subscribe to this event now --
    // the same-device indicator and the device-loss one -- and a fixture that
    // kept only the last registration would silently drop the first, which is
    // the fixture lying rather than the page failing. Tauri's own `listen`
    // takes any number of listeners per event.
    const listeners: Record<string, Array<() => void>> = {};
    const mounted = await mountProject(
      deps({
        invoke: h.invoke,
        listen: (event: string, cb: () => void) => {
          (listeners[event] ??= []).push(cb);
          return Promise.resolve(() => undefined);
        },
      }),
    );
    await settle();
    const before = h.of("recovery_status").length;
    const beforeArchive = h.of("archive_status").length;
    expect(before).toBeGreaterThan(0);
    expect(beforeArchive).toBeGreaterThan(0);
    expect(listeners["app://recovery-changed"]?.length).toBe(2);
    for (const cb of listeners["app://recovery-changed"] ?? []) cb();
    await settle();

    expect(h.of("recovery_status").length).toBeGreaterThan(before);
    // The archive area sits INSIDE the directory this event describes, so it
    // re-reads on the same signal.
    expect(h.of("archive_status").length).toBeGreaterThan(beforeArchive);
    mounted.destroy();
  });

  test("the status dot is mounted before the popover and reports the indicators' states", async () => {
    // Three content answers: a verified recovery point (the fixture's default),
    // a verified archive and a current mirror. Quiet is the conjunction, so a
    // dot that ignored any one indicator's onState would still be amber here.
    shell();
    const now = Date.now();
    const h = host({
      archive: { slug: "project", dir: "/archives", newest_verified_ms: now - 60_000, archives: 1 },
      mirror: {
        enabled: true,
        dir: "/mirror",
        files: 4,
        generated_at: now - 60_000,
        last_ok: true,
        last_error: null,
        paused: 0,
        updating: false,
        finding: null,
      },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    const controls = document.getElementById("status-controls");
    expect(controls?.firstElementChild?.querySelector("#status-dot")).not.toBeNull();
    expect(controls?.lastElementChild?.id).toBe("status-popover");
    expect(controls?.children.length).toBe(2);
    await settle();
    expect(document.getElementById("status-dot")?.dataset.state).toBe("quiet");

    mounted.destroy();
    expect(document.getElementById("status-dot")).toBeNull();
    expect(controls?.children.length).toBe(1);
  });

  test("the copies shortcut closes its popover and opens the folder changes", async () => {
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    (document.getElementById("status-dot") as HTMLButtonElement).click();
    const before = h.of("mirror_changes").length;
    const action = document.getElementById("status-open-changes") as HTMLButtonElement;
    action.click();
    await settle();
    expect(document.getElementById("status-popover")?.hidden).toBe(true);
    expect(h.of("mirror_changes").length).toBeGreaterThan(before);
    expect(document.getElementById("mirror-changes")?.hidden).toBe(false);
    mounted.destroy();
    expect(document.getElementById("status-open-changes") === null).toBe(true);
    const after = h.of("mirror_changes").length;
    action.click();
    await settle();
    expect(h.of("mirror_changes").length).toBe(after);
  });

  test("the status dot is neutral, not amber, while copies are only not set up", async () => {
    // The fixture's default: recovery answers protected, and archive_status and
    // mirror_status both reject, which each indicator paints as its negative
    // ("none", "off"). Not set up is neutral, amber is failed,
    // stale or paused.
    shell();
    const h = host();
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.getElementById("status-dot")?.dataset.state).toBe("neutral");
    mounted.destroy();
  });

  test("a host that cannot answer leaves the surface alone rather than erroring the mount", async () => {
    shell();
    const h = host({ reject: ["recovery_status"] });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    expect(document.getElementById("recovery-indicator")?.textContent).toBe(
      "No recovery point on this device",
    );
    expect(document.getElementById("persist-error")).toBeNull();
    mounted.destroy();
  });
});

describe("cast marks in the prose", () => {
  const CAST = [{ id: "m1", kind: "character", name: "Arrival", summary: "", fields: [], aliases: [] }];

  test("MUTATION TARGET: an alias marks the prose too, not only the name", async () => {
    // A `namesForCast` that dropped `m.aliases` passes every other test in
    // this file, because none of the other fixtures carry one.
    shell();
    const withAlias = [
      { id: "m2", kind: "character", name: "Marisol Quillfeather", summary: "", fields: [], aliases: ["Quill"] },
    ];
    const h = host({
      cast: withAlias,
      bodies: { "scene-0": body("Quill arrived at dusk.") },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const mark = document.querySelector<HTMLElement>(".cast-mark");
    expect(mark).not.toBeNull();
    expect(mark?.dataset.memberId).toBe("m2");
    mounted.destroy();
  });

  test("feeds the plugin the cast list at mount, and a mark is drawn", async () => {
    shell();
    const h = host({ cast: CAST, bodies: { "scene-0": body("Arrival happened at dusk.") } });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.querySelectorAll(".cast-mark").length).toBeGreaterThan(0);
    mounted.destroy();
  });

  test("MUTATION TARGET: the preference off leaves no marks in the open scene", async () => {
    shell();
    const h = host({ cast: CAST, bodies: { "scene-0": body("Arrival happened at dusk.") } });
    const mounted = await mountProject(
      deps({ invoke: h.invoke, markCastNames: () => false }),
    );
    await settle();
    expect(document.querySelectorAll(".cast-mark").length).toBe(0);
    mounted.destroy();
  });

  test("BLOCKER: switching scenes keeps the marks, since replaceDoc's fresh EditorState loses the names otherwise", async () => {
    shell();
    const h = host({
      cast: CAST,
      bodies: {
        "scene-0": body("Nothing to mark here."),
        "scene-1": body("Arrival happened at dusk."),
      },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.querySelectorAll(".cast-mark").length).toBe(0);

    const row = document.querySelector('[data-item-id="scene-1"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(document.querySelectorAll(".cast-mark").length).toBeGreaterThan(0);
    mounted.destroy();
  });

  test("feeds full, first, and last cast names to the plugin, and the preference toggles them at once", async () => {
    shell();
    const h = host({
      cast: [{ id: "m1", kind: "character", name: "Marisol Quillfeather", summary: "", fields: [], aliases: [] }],
      bodies: { "scene-0": body("Marisol Quillfeather met Marisol and Quillfeather.") },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    expect(document.querySelectorAll(".cast-mark").length).toBe(3);
    mounted.setMarkCastNames(false);
    expect(document.querySelectorAll(".cast-mark").length).toBe(0);
    mounted.setMarkCastNames(true);
    expect(document.querySelectorAll(".cast-mark").length).toBeGreaterThan(0);
    mounted.destroy();
  });
});

describe("mountProject: a timeline opens in the editor pane", () => {
  // ITS OWN ITEMS, not `walk()` widened: a bible root and a timeline appended
  // after the manuscript so the boot document is still the first scene, per
  // `walk()`'s own comment.
  function withTimeline(): ProjectItem[] {
    return [
      ...walk(),
      {
        id: "bible-0",
        parent_id: null,
        type: "bible",
        title: "Bible",
        position: "0002",
        rev: 1,
        state: null,
        depth: 0,
      },
      {
        id: "timeline-0",
        parent_id: "bible-0",
        type: "timeline",
        title: "Timeline",
        position: "0000",
        rev: 1,
        state: null,
        depth: 1,
      },
    ];
  }

  const TIMELINE_BODY = JSON.stringify({
    kind: "timeline",
    version: 1,
    scale: { unit: "day", zero: "", calendar: null, eras: [] },
    tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }],
    branches: [],
    events: [],
  });

  test("clicking the timeline switches to it, hides the prose view, and mounts the lanes", async () => {
    shell();
    const h = host({
      items: withTimeline(),
      bodies: { "scene-0": body("Arrival happened at dusk."), "timeline-0": TIMELINE_BODY },
      comments: {
        "scene-0": [{
          id: 7,
          item_id: "scene-0",
          body: "does she know yet?",
          anchor_from: 1,
          anchor_to: 4,
          quote: "alp",
          orphaned: false,
          resolved: false,
          created_at: 0,
          updated_at: 0,
        }],
      },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    await settle();
    expect(mounted.session?.activeDocId()).toBe("scene-0");
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(false);

    const row = document.querySelector('[data-item-id="timeline-0"]');
    if (!(row instanceof HTMLElement)) throw new Error("timeline-0 is not mounted");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    // THE SWITCH REALLY HAPPENED (unlike an earlier placeholder-only arm): the
    // session names the timeline, the header names it, and its one lane is
    // in the DOM.
    expect(mounted.session?.activeDocId()).toBe("timeline-0");
    expect(document.getElementById("scene-heading")?.textContent).toBe("Timeline");
    expect(document.querySelector("#timeline-view")).not.toBeNull();
    expect(document.querySelectorAll(".timeline-lane")).toHaveLength(1);

    // THE PROSE VIEW IS HIDDEN, NOT DESTROYED: its DOM node is still in
    // #editor, carrying whatever the scene left in it, just not shown.
    const prose = document.querySelector("#editor .ProseMirror");
    expect(prose).not.toBeNull();
    expect((prose as HTMLElement).hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#scene-notes")?.hidden).toBe(true);
    expect(h.of("comment_list").map((call) => call.args?.itemId)).not.toContain("timeline-0");

    mounted.destroy();
  });

  test("a mutation on the timeline flushes under the timeline's own id, not the scene's", async () => {
    shell();
    const h = host({
      items: withTimeline(),
      bodies: { "scene-0": body("Arrival happened at dusk."), "timeline-0": TIMELINE_BODY },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const row = document.querySelector('[data-item-id="timeline-0"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    const addTrack = [...document.querySelectorAll("#timeline-toolbar button")].find(
      (b) => b.textContent === "+ Track",
    );
    if (!(addTrack instanceof HTMLElement)) throw new Error("+ Track is not mounted");
    addTrack.click();
    (document.getElementById("timeline-track-kind-thread") as HTMLButtonElement).click();
    await mounted.flusher?.drain();

    const flushed = h.flushed();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.item_id).toBe("timeline-0");
    const parsed = JSON.parse(String(flushed[0]?.body));
    expect(parsed.tracks).toHaveLength(2);
    // MUTATION TARGET 7: the flush must carry no comment position list.
    expect(flushed[0]?.comments).toBeUndefined();

    mounted.destroy();
  });

  test("switching back to the scene leaves the lanes in #editor for nobody (mutation target 6)", async () => {
    shell();
    const h = host({
      items: withTimeline(),
      bodies: { "scene-0": body("Arrival happened at dusk."), "timeline-0": TIMELINE_BODY },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const timelineRow = document.querySelector('[data-item-id="timeline-0"]');
    (timelineRow as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector("#timeline-view")).not.toBeNull();

    const sceneRow = document.querySelector('[data-item-id="scene-0"]');
    (sceneRow as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(mounted.session?.activeDocId()).toBe("scene-0");
    // A BOOLEAN, NOT THE RAW NODE (a mutant hang, chased and fixed
    // here): with the mount-teardown lines removed from project.ts's wrapped
    // replaceDoc, this assertion genuinely FAILS -- `#timeline-view` is still
    // in the DOM -- and asserting `toBeNull()` against the live element (a
    // mounted timeline with its lanes, toolbar and listeners) sent bun's
    // failure-diff printer into a walk so slow it never returned within any
    // timeout this suite used (measured: a bare div's failure prints in
    // 80ms; a freshly mounted, otherwise-empty timeline's failure took 3.3s;
    // the real fixture's fuller DOM never finished). Not an infinite loop --
    // catastrophically slow synchronous pretty-printing of a large DOM
    // subtree, indistinguishable from a hang to a per-test timeout, a pty
    // run, or a heartbeat timer, because none of them ever get the thread
    // back. Comparing a boolean keeps a genuine failure here a FAILURE, not
    // a hang, whatever the pretty-printer would have made of the node.
    expect(document.querySelector("#timeline-view") !== null).toBe(false);
    const prose = document.querySelector("#editor .ProseMirror");
    expect(prose).not.toBeNull();
    expect((prose as HTMLElement).hidden).toBe(false);

    mounted.destroy();
  });

  test("Add comment while a timeline is open raises timeline.no-comments instead of opening the panel", async () => {
    shell();
    const h = host({
      items: withTimeline(),
      bodies: { "scene-0": body("Arrival happened at dusk."), "timeline-0": TIMELINE_BODY },
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const row = document.querySelector('[data-item-id="timeline-0"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    mounted.menuActions.addComment();

    expect(bannerIds()).toContain("open-error");
    expect(labelOf("open-error")).toBe("A timeline cannot carry a comment.");
    expect(document.getElementById("comments-panel")?.hidden).not.toBe(false);

    mounted.destroy();
  });

  // BLOCKER (review): applyRestored and reloadOpenDocument both called
  // readableBody() on the new body regardless of type, which is always
  // null for a timeline -- so a restore over an open timeline raised a
  // false "could not be read" AND skipped flusher.register, leaving the
  // scheduler holding the PRE-restore rev. The writer's very next edit to
  // the very body the host had just restored would have been refused as a
  // Conflict.
  test("restoring a version over an open timeline repaints it and registers the new rev", async () => {
    shell();
    const RESTORED = JSON.stringify({
      kind: "timeline",
      version: 1,
      scale: { unit: "day", zero: "", calendar: null, eras: [] },
      tracks: [{ id: "t1", name: "Ines", kind: "thread", colour: 1 }, { id: "t2", name: "Restored track", kind: "thread", colour: 2 }],
      branches: [],
      events: [],
    });
    const h = host({
      items: withTimeline(),
      bodies: { "scene-0": body("Arrival happened at dusk."), "timeline-0": TIMELINE_BODY },
      versions: [{ id: 3, created_at: 0, words: 0, snapshot_label: null, snapshot_id: null }],
      restoreBody: RESTORED,
      docRev: 7,
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const row = document.querySelector('[data-item-id="timeline-0"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(bannerIds()).not.toContain("open-error");

    mounted.menuActions.openHistory();
    await settle();
    await settle();
    const restore = document.querySelector<HTMLButtonElement>(".history-restore");
    expect(restore).not.toBeNull();
    restore?.click();
    await settle();
    await settle();

    expect(h.of("doc_restore").length).toBe(1);
    // NO FALSE NOTICE: "open-error" is the one banner id both a failure
    // notice and a plain announcement share (banner.ts's own dual use), so
    // the check is the TONE, not mere presence -- a healthy restored
    // timeline must not raise project.error.unreadable-body's "problem"
    // tone.
    expect(document.getElementById("open-error")?.dataset.tone).not.toBe("problem");
    // REGISTERED: the scheduler holds the RESTORED rev, not the stale one --
    // this is what a Conflict on the writer's next edit would otherwise
    // come from.
    expect(mounted.flusher?.revOf("timeline-0")).toBe(8);
    // REPAINTED: the restored track is on screen.
    expect(document.querySelectorAll(".timeline-lane")).toHaveLength(2);

    mounted.destroy();
  });

  test("accepting a mirror change over an open timeline repaints it and registers the new rev", async () => {
    shell();
    const ACCEPTED = JSON.stringify({
      kind: "timeline",
      version: 1,
      scale: { unit: "day", zero: "", calendar: null, eras: [] },
      tracks: [
        { id: "t1", name: "Ines", kind: "thread", colour: 1 },
        { id: "t2", name: "Taken in", kind: "thread", colour: 2 },
        { id: "t3", name: "A third", kind: "thread", colour: 3 },
      ],
      branches: [],
      events: [],
    });
    const h = host({
      items: withTimeline(),
      // reloadOpenDocument re-reads through doc_load, not through
      // mirror_accept's own answer, so this fixture's `bodies` entry is
      // what the accepted content actually comes back as.
      bodies: { "scene-0": body("Arrival happened at dusk."), "timeline-0": ACCEPTED },
      mirrorRows: [
        {
          id: "timeline-0",
          path: "bible/timeline.json",
          was_path: null,
          state: "prose",
          title: "Timeline",
          file_title: null,
          store_body: TIMELINE_BODY,
          file_body: ACCEPTED,
          error: null,
          can_accept: true,
          store_underlined: 0,
        },
      ],
      mirrorAcceptBody: ACCEPTED,
      docRev: 7,
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();
    const row = document.querySelector('[data-item-id="timeline-0"]');
    (row as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    mounted.menuActions.openMirrorChanges();
    await settle();
    await settle();
    const accept = document.querySelector<HTMLButtonElement>(".mirror-change-accept");
    expect(accept).not.toBeNull();
    accept?.click();
    await settle();
    await settle();
    await settle();

    expect(h.of("mirror_accept").length).toBe(1);
    expect(document.getElementById("open-error")?.dataset.tone).not.toBe("problem");
    // reloadOpenDocument re-reads through doc_load (docRev unchanged by
    // mirror_accept's own fixture answer here), and registers it.
    expect(mounted.flusher?.revOf("timeline-0")).toBe(7);
    expect(document.querySelectorAll(".timeline-lane")).toHaveLength(3);

    mounted.destroy();
  });

  test("a prose restore is unchanged: readableBody still runs and the scene still repaints", async () => {
    shell();
    const h = host({
      bodies: { "scene-0": body("Arrival happened at dusk.") },
      versions: [{ id: 3, created_at: 0, words: 12, snapshot_label: null, snapshot_id: null }],
      docRev: 7,
    });
    const mounted = await mountProject(deps({ invoke: h.invoke }));
    await settle();

    mounted.menuActions.openHistory();
    await settle();
    await settle();
    const restore = document.querySelector<HTMLButtonElement>(".history-restore");
    expect(restore).not.toBeNull();
    restore?.click();
    await settle();
    await settle();

    expect(h.of("doc_restore").length).toBe(1);
    expect(document.getElementById("open-error")?.dataset.tone).not.toBe("problem");
    expect(mounted.flusher?.revOf("scene-0")).toBe(8);
    expect(mounted.editor.serialize()).toContain("restored");

    mounted.destroy();
  });
});

describe("saved-word statistics commands", () => {
  const mirrorRow = { id: "scene-0", path: "a.md", was_path: null, state: "prose", title: "Arrival", file_title: null, store_body: body("book"), file_body: body("file"), error: null, can_accept: true, store_underlined: 0 };
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement | null;

  test("pause locks the editor, drains, then tells the host; scene opening waits it out", async () => {
    shell();
    let releaseFlush = (): void => undefined;
    const flushing = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const order: string[] = [];
    const h = host();
    let hold = false;
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_flush" || cmd === "project_source_words_collecting") order.push(cmd);
      if (cmd === "doc_flush" && hold) await flushing;
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openStatistics();
    await settle(); await settle();
    expect(button("stats-sources-collect")?.textContent).toBe("Pause counting saved words");
    mounted.editor.typeChar("x");
    hold = true;
    button("stats-sources-collect")?.click();
    await micro();
    const locked = mounted.editor.serialize();
    mounted.editor.typeChar("y");
    expect(mounted.editor.serialize()).toBe(locked);
    document.querySelector<HTMLElement>("[data-item-id='scene-1']")?.click();
    await micro();
    expect(h.of("doc_load").filter((call) => call.args?.itemId === "scene-1")).toHaveLength(0);
    expect(h.of("project_source_words_collecting")).toHaveLength(0);
    releaseFlush();
    await settle(); await settle(); await settle();
    expect(order).toEqual(["doc_flush", "project_source_words_collecting"]);
    expect(h.of("project_source_words_collecting")[0]!.args).toEqual({ generation: 1, collecting: false });
    expect(button("stats-sources-collect")?.textContent).toBe("Resume counting saved words");
    const after = mounted.editor.serialize();
    mounted.editor.typeChar("z");
    expect(mounted.editor.serialize()).not.toBe(after);
    mounted.destroy();
  });

  test("mirror undo is refused while a statistics command is running", async () => {
    shell();
    let release = (): void => undefined;
    const reply = new Promise<void>((resolve) => { release = resolve; });
    const h = host({ mirrorRows: [mirrorRow] });
    let entered = false;
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "project_source_words_reset") { entered = true; await reply; }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openMirrorChanges();
    await settle();
    document.querySelector<HTMLButtonElement>(".mirror-change-accept")?.click();
    await settle(); await settle(); await settle();
    expect(document.querySelector<HTMLButtonElement>(".mirror-change-undo")).not.toBeNull();
    mounted.menuActions.openStatistics();
    await settle(); await settle();
    button("stats-sources-reset")?.click();
    button("stats-sources-reset-confirm")?.click();
    await settle();
    expect(entered).toBe(true);
    document.querySelector<HTMLButtonElement>(".mirror-change-undo")?.click();
    await settle();
    expect(h.of("mirror_undo_accept")).toHaveLength(0);
    release();
    await settle(); await settle();
    expect(h.of("project_source_words_reset")[0]!.args).toEqual({ generation: 1 });
    mounted.destroy();
  });

  test("a failed save refuses the command, says so, and gives the editor back", async () => {
    shell();
    const h = host();
    let failFlush = false;
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_flush" && failFlush) {
        await h.invoke(cmd, args);
        throw new Error("disk full");
      }
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openStatistics();
    await settle(); await settle();
    failFlush = true;
    mounted.editor.typeChar("x");
    button("stats-sources-collect")?.click();
    await settle(); await settle(); await settle();
    expect(h.of("project_source_words_collecting")).toHaveLength(0);
    expect(document.getElementById("stats-sources-error")?.textContent).toContain("could not be saved");
    const before = mounted.editor.serialize();
    mounted.editor.typeChar("y");
    expect(mounted.editor.serialize()).not.toBe(before);
    mounted.destroy();
  });

  test("a host refusal gives the editor back", async () => {
    shell();
    const h = host();
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "project_source_words_collecting") throw new Error("stale generation");
      return h.invoke(cmd, args);
    };
    const mounted = await mountProject(deps({ invoke }));
    await settle();
    mounted.menuActions.openStatistics();
    await settle(); await settle();
    button("stats-sources-collect")?.click();
    await settle(); await settle(); await settle();
    expect(document.getElementById("stats-sources-error")?.textContent).toContain("stale generation");
    const before = mounted.editor.serialize();
    mounted.editor.typeChar("y");
    expect(mounted.editor.serialize()).not.toBe(before);
    mounted.destroy();
  });

  const watchRejections = (): { seen: unknown[]; stop(): void } => {
    const seen: unknown[] = [];
    const on = (reason: unknown): void => { seen.push(reason); };
    process.on("unhandledRejection", on);
    return { seen, stop: () => process.off("unhandledRejection", on) };
  };

  test("destroying the book while saves drain skips the host call and throws nothing", async () => {
    shell();
    let releaseFlush = (): void => undefined;
    const flushing = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const h = host();
    let hold = false;
    let flushEntered = false;
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "doc_flush" && hold) { flushEntered = true; await flushing; }
      return h.invoke(cmd, args);
    };
    const rejections = watchRejections();
    try {
      const mounted = await mountProject(deps({ invoke }));
      await settle();
      mounted.menuActions.openStatistics();
      await settle(); await settle();
      mounted.editor.typeChar("x");
      hold = true;
      button("stats-sources-collect")?.click();
      await settle();
      expect(flushEntered).toBe(true);
      mounted.destroy();
      releaseFlush();
      await settle(); await settle(); await settle();
      expect(h.of("project_source_words_collecting")).toHaveLength(0);
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  test("destroying the book while the host call is pending ignores its answer and throws nothing", async () => {
    shell();
    let release = (): void => undefined;
    const reply = new Promise<void>((resolve) => { release = resolve; });
    const h = host();
    let entered = false;
    const invoke: Host["invoke"] = async (cmd, args) => {
      if (cmd === "project_source_words_collecting") { entered = true; await reply; }
      return h.invoke(cmd, args);
    };
    const rejections = watchRejections();
    try {
      const mounted = await mountProject(deps({ invoke }));
      await settle();
      mounted.menuActions.openStatistics();
      await settle(); await settle();
      button("stats-sources-collect")?.click();
      await settle();
      expect(entered).toBe(true);
      const editor = mounted.editor;
      mounted.destroy();
      const asked = h.of("project_progress").length;
      release();
      await settle(); await settle(); await settle();
      expect(h.of("project_source_words_collecting")).toHaveLength(1);
      expect(h.of("project_progress")).toHaveLength(asked);
      expect(document.getElementById("stats-panel")).toBeNull();
      const before = editor.serialize();
      editor.typeChar("y");
      expect(editor.serialize()).toBe(before);
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  test("another book's panel starts from its own state, with nothing armed", async () => {
    shell();
    const first = host({ collecting: false });
    const a = await mountProject(deps({ invoke: first.invoke }));
    await settle();
    a.menuActions.openStatistics();
    await settle(); await settle();
    expect(button("stats-sources-collect")?.textContent).toBe("Resume counting saved words");
    button("stats-sources-reset")?.click();
    a.destroy();
    expect(document.getElementById("stats-sources-controls")).toBeNull();

    const second = host();
    const b = await mountProject(deps({ invoke: second.invoke, generation: 2 }));
    await settle();
    b.menuActions.openStatistics();
    await settle(); await settle();
    expect(button("stats-sources-collect")?.textContent).toBe("Pause counting saved words");
    expect(document.getElementById("stats-sources-reset-confirm-group")?.hidden).toBe(true);
    button("stats-sources-collect")?.click();
    await settle(); await settle();
    expect(first.of("project_source_words_collecting")).toHaveLength(0);
    expect(second.of("project_source_words_collecting")[0]!.args).toEqual({ generation: 2, collecting: false });
    b.destroy();
  });
});
