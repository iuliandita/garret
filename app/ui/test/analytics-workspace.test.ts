import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, test } from "bun:test";
import { createAnalyticsWorkspace } from "../src/analytics-workspace";
import type { AnalyticsView } from "../src/analytics-metrics";
import type { LibraryOverview } from "../src/library";
import type { BookStats } from "../src/library-summary";
import { HostCommandError } from "../src/command-error";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function view(): AnalyticsView {
  return { generation: 7, session_id: null, selected_category: null, custom_categories: [], tracking_on: true,
    structure: { parts: 0, chapters: 1, scenes: 1, revision_states: {}, revision_passes: 0, tasks_open: 0, tasks_done: 0, comments_open: 0, comments_resolved: 0 }, report: {
    recording_enabled: false, metric_version: 1, motivation_since_ms: null, motivation_visible: false,
    forecast_goal_words: null, sessions: [], more_sessions: 0, source_definition: "", coverage_definition: "",
  } };
}

afterEach(() => { document.body.replaceChildren(); });

test("recording starts only after the writer chooses it and carries the generation boundary", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  let current = view();
  const workspace = createAnalyticsWorkspace({
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "analytics_get") return current;
      if (command === "analytics_set_recording") { current = { ...current, session_id: "session", report: { ...current.report, recording_enabled: true } }; return null; }
      throw new Error(command);
    },
    drain: async () => {}, bookWords: async () => 12, openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  expect(calls.some(([command]) => command === "analytics_set_recording")).toBe(false);
  expect(document.getElementById("analytics-workspace")?.textContent).toContain("No sessions recorded here yet.");
  // The method moved off the page into help marks (239), still the marks'
  // accessible descriptions: a session's span is not writing time.
  const span = document.getElementById("analytics-help-history")!;
  expect(span.getAttribute("aria-label")).toBe("About Sessions and corrections");
  expect(document.getElementById(span.getAttribute("aria-describedby")!)?.textContent).toContain("not time spent writing");
  expect(document.querySelector(".analytics-content > p")).toBeNull();
  const from = document.getElementById("analytics-from") as HTMLInputElement;
  from.focus();
  from.value = "2026-09-25";
  from.dispatchEvent(new Event("change"));
  expect((document.activeElement as HTMLElement).id).toBe("analytics-from");
  document.getElementById("analytics-record-toggle")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.find(([command]) => command === "analytics_set_recording")?.[1]).toEqual({
    generation: 7, sessionId: null, enabled: true, category: { id: "drafting", name: "" },
  });
  workspace.destroy();
});

test("recording discloses disabled global time tracking", async () => {
  const current = view();
  current.tracking_on = false;
  current.report.recording_enabled = true;
  const workspace = createAnalyticsWorkspace({
    invoke: async () => current, drain: async () => {}, bookWords: async () => 0,
    openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  expect(document.getElementById("analytics-workspace")?.textContent).toContain("Time tracking is off in Preferences");
  workspace.destroy();
});

test("a late read cannot repaint after the workspace closes", async () => {
  let finish!: (value: AnalyticsView) => void;
  const pending = new Promise<AnalyticsView>((resolve) => { finish = resolve; });
  const workspace = createAnalyticsWorkspace({
    invoke: async () => pending, drain: async () => {}, bookWords: async () => 0, openStatistics: () => {}, onDismiss: () => {},
  });
  const opening = workspace.open();
  workspace.close();
  finish(view());
  await opening;
  expect(document.getElementById("analytics-workspace")?.hidden).toBe(true);
  expect(document.getElementById("analytics-workspace")?.textContent).not.toContain("No sessions recorded here yet");
  workspace.destroy();
});

test("a delayed action cannot run on a reopened Analytics view", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let block = false;
  const calls: string[] = [];
  const workspace = createAnalyticsWorkspace({
    invoke: async (command) => { calls.push(command); return command === "analytics_get" ? view() : "exported.json"; },
    drain: async () => { if (block) await pending; }, bookWords: async () => 0,
    openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  block = true;
  document.getElementById("analytics-record-toggle")!.click();
  document.getElementById("analytics-export")!.click();
  workspace.close();
  block = false;
  await workspace.open();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).not.toContain("analytics_set_recording");
  expect(calls).not.toContain("analytics_raw_export");
  workspace.destroy();
});

test("a dismissed export cannot publish a late success status", async () => {
  let finish!: (path: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const workspace = createAnalyticsWorkspace({
    invoke: async (command) => command === "analytics_get" ? view() : pending,
    drain: async () => {}, bookWords: async () => 0,
    openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  document.getElementById("analytics-export")!.click();
  workspace.close();
  finish("exported.json");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.getElementById("analytics-status")?.textContent).not.toContain("exported.json");
  workspace.destroy();
});

test("library scope rejects a report whose pin changed after the overview", async () => {
  const book = { path: "book.db", name: "Book", modified_at: 0, opened_at: null,
    identity_id: "original", identity_name: "Name", book_id: "book-id", series: null, universe: null,
    membership_error: null, cover: { state: "none" as const, data_uri: null }, error: null, missing: false };
  const overview: LibraryOverview = { identities: [], selected_identity: null, vault_error: null, books: [book], more: 0, took_ms: 0 };
  const stats: BookStats = { book_id: "book-id", identity_id: "original", membership: { version: 1, series: null, universe: null },
    words: 400, unreadable_documents: 0, documents: 1, activity: null, activity_interrupted: false,
    activity_warning: null, read_at_ms: 1, took_ms: 0 };
  const workspace = createAnalyticsWorkspace({
    invoke: async (command) => {
      if (command === "analytics_get") return view();
      if (command === "library_overview") return overview;
      if (command === "library_book_stats") return stats;
      if (command === "analytics_book_report") return { book_id: "book-id", identity_id: "changed",
        membership: stats.membership, report: view().report };
      throw new Error(command);
    },
    drain: async () => {}, bookWords: async () => 0, openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  const scope = document.getElementById("analytics-scope") as HTMLSelectElement;
  scope.value = "library";
  scope.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const figures = [...document.querySelectorAll(".analytics-figure strong")].map((element) => element.textContent);
  expect(figures[2]).toBe("0");
  expect(document.getElementById("analytics-workspace")?.textContent).toContain("Sessions for 1 book were unavailable.");
  // Non-zero reasons only: nothing was left out for copies.
  expect(document.getElementById("analytics-workspace")?.textContent).not.toContain("have copies");
  workspace.destroy();
});

test("legacy custom names stay distinguishable and active duplicates get a localized refusal", async () => {
  const current = view();
  current.custom_categories = [
    { category: { id: "a", name: "Harbour" }, retired: false },
    { category: { id: "b", name: "harbour" }, retired: false },
    { category: { id: "c", name: "Harbour" }, retired: true },
  ];
  const calls: string[] = [];
  const workspace = createAnalyticsWorkspace({
    invoke: async (command) => { calls.push(command); return current; },
    drain: async () => {}, bookWords: async () => 0, openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  const chosen = document.getElementById("analytics-category-select") as HTMLSelectElement;
  expect([...chosen.options].map((option) => option.textContent)).toContain("Harbour (custom 1)");
  expect([...chosen.options].map((option) => option.textContent)).toContain("harbour (custom 2)");
  const filter = document.getElementById("analytics-category-filter") as HTMLSelectElement;
  expect([...filter.options].map((option) => option.textContent)).toContain("Harbour (retired custom 3)");
  const input = document.getElementById("analytics-custom-name") as HTMLInputElement;
  input.value = "  HARBOUR  ";
  document.getElementById("analytics-custom-add")!.click();
  expect(calls).not.toContain("analytics_custom_add");
  expect(document.getElementById("analytics-status")?.textContent).toContain("already has that name");
  workspace.destroy();
});

test("a concurrent duplicate refusal uses the localized category message", async () => {
  const workspace = createAnalyticsWorkspace({
    invoke: async (command) => {
      if (command === "analytics_get") return view();
      throw new HostCommandError(command, { version: 1, code: "operation_failed", operation: command,
        detail: "analytics_category_name_taken" });
    },
    drain: async () => {}, bookWords: async () => 0, openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  (document.getElementById("analytics-custom-name") as HTMLInputElement).value = "New name";
  document.getElementById("analytics-custom-add")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.getElementById("analytics-status")?.textContent).toBe("An active activity already has that name. Choose a different name.");
  workspace.destroy();
});

test("Escape during IME composition does not dismiss Analytics", async () => {
  const workspace = createAnalyticsWorkspace({
    invoke: async () => view(), drain: async () => {}, bookWords: async () => 0,
    openStatistics: () => {}, onDismiss: () => {},
  });
  await workspace.open();
  const element = document.getElementById("analytics-workspace")!;
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
  expect(element.hidden).toBe(false);
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(element.hidden).toBe(true);
  workspace.destroy();
});
