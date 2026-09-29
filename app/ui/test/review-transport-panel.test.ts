import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof document === "undefined") GlobalRegistrator.register();
import { createReviewTransportPanel, ReviewAppliedViewError, ReviewBusyError, type ReviewReturnRequest, type ReviewTransportDeps } from "../src/review-transport-panel";
import { t } from "../src/i18n";

const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const before = [{ kind: "text" as const, text: "one" }];
const after = [{ kind: "text" as const, text: "two" }];
const exported = { token: "secret-1", item_id: "scene", scene_title: "Arrival", doc_rev: 7,
  authors: ["Mara", "Ari"], messages: [{ author_name: "Mara", body: "A private note" }] };
const returned = { token: "secret-2", item_id: "scene", scene_title: "Arrival", doc_rev: 7,
  decisions: [{ hunk_id: 10, decision: "accept" as const, proposal_author: "Mara", before, after }],
  new_hunks: [{ author_name: "Word Writer", hunk: { from: 1, to: 4, before, after } }],
  new_messages: [{ group_id: 7, author_name: "Word Writer", body: "<script>keep</script>" }],
  source_authors: ["Word Writer"] };
const mounted: ReturnType<typeof createReviewTransportPanel>[] = [];
function rig(overrides: Partial<ReviewTransportDeps> = {}) {
  const calls = { previews: [] as string[], saves: [] as string[], applies: [] as ReviewReturnRequest[],
    cancels: [] as string[], notices: [] as string[], successes: [] as string[], done: 0 };
  const panel = createReviewTransportPanel({ container: document.body,
    exportPreview: async (itemId) => { calls.previews.push(`export:${itemId}`); return exported; },
    exportSave: async (token) => { calls.saves.push(token); return true; },
    returnPreview: async (itemId) => { calls.previews.push(`return:${itemId}`); return returned; },
    returnApply: async (request) => { calls.applies.push(request); },
    cancel: async (token) => { calls.cancels.push(token); },
    onNotice: (message) => calls.notices.push(message), onSuccess: (message) => calls.successes.push(message),
    onStateChange: () => undefined,
    onDone: () => { calls.done++; }, ...overrides });
  mounted.push(panel);
  const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  const get = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
  return { panel, calls, click, get };
}
afterEach(() => { for (const panel of mounted.splice(0)) panel.destroy(); document.body.replaceChildren(); });

test("export discloses names and immutable discussion before native save and never receives a path", async () => {
  const r = rig(); await r.panel.setTarget("scene", "Arrival", []);
  r.click("#review-transport button:first-of-type"); await tick();
  expect(r.calls.previews).toEqual(["export:scene"]);
  expect(r.get<HTMLElement>("#review-transport-preview").textContent).toContain("Mara, Ari");
  expect(r.get<HTMLElement>("#review-transport-preview").textContent).toContain("A private note");
  expect(r.panel.hasPendingReturn()).toBe(false);
  r.click("#review-transport-save"); await tick();
  expect(r.calls.saves).toEqual(["secret-1"]);
  expect(r.calls.done).toBe(1);
  expect(r.panel.hasPreview()).toBe(false);
});

test("return needs a deliberate actor and Word-name mapping, then submits token and choices only", async () => {
  const r = rig(); await r.panel.setTarget("scene", "Arrival", [{ id: 3, display_name: "Mara", created_at: 1 }]);
  r.click("#review-transport button:nth-of-type(2)"); await tick();
  const apply = r.get<HTMLButtonElement>("#review-transport-apply");
  expect(apply.disabled).toBe(true);
  expect(r.get<HTMLElement>("#review-transport-preview").querySelectorAll("script")).toHaveLength(0);
  expect(r.get<HTMLElement>("#review-transport-preview").textContent).toContain("<script>keep</script>");
  const actor = r.get<HTMLSelectElement>("[data-actor] select"); actor.value = "existing:3"; actor.dispatchEvent(new Event("change"));
  expect(apply.disabled).toBe(true);
  const mapped = r.get<HTMLSelectElement>('[data-source="Word Writer"] select');
  mapped.value = "create"; mapped.dispatchEvent(new Event("change"));
  const name = r.get<HTMLInputElement>('[data-source="Word Writer"] input'); name.value = "Bob"; name.dispatchEvent(new Event("input"));
  expect(apply.disabled).toBe(false);
  r.click("#review-transport-apply"); await tick();
  expect(r.calls.applies).toEqual([{ token: "secret-2", deciding_actor: { kind: "existing", id: 3 },
    sources: [{ source_name: "Word Writer", choice: { kind: "create", display_name: "Bob" } }] }]);
  expect(r.panel.hasPendingReturn()).toBe(false);
});

test("a refused apply keeps attribution visible but requires a fresh preview", async () => {
  const r = rig({ returnApply: async () => { throw new Error("stale source"); } });
  await r.panel.setTarget("scene", "Arrival", [{ id: 3, display_name: "Mara", created_at: 1 }]);
  r.click("#review-transport button:nth-of-type(2)"); await tick();
  const actor = r.get<HTMLSelectElement>("[data-actor] select"); actor.value = "existing:3"; actor.dispatchEvent(new Event("change"));
  const mapped = r.get<HTMLSelectElement>('[data-source="Word Writer"] select'); mapped.value = "existing:3"; mapped.dispatchEvent(new Event("change"));
  r.click("#review-transport-apply"); await tick();
  expect(r.get<HTMLButtonElement>("#review-transport-apply").disabled).toBe(true);
  expect(mapped.value).toBe("existing:3");
  expect(r.panel.hasPendingReturn()).toBe(true);
  expect(r.get<HTMLElement>("#review-transport-status").textContent).toContain("stale source");
  r.click("#review-transport button:nth-of-type(2)"); await tick();
  expect(r.calls.cancels).toEqual(["secret-2"]);
  expect(r.get<HTMLButtonElement>("#review-transport-apply").disabled).toBe(true);
});

test("a page-busy apply keeps the token and author mappings for a retry", async () => {
  const attempts: ReviewReturnRequest[] = [];
  const r = rig({ returnApply: async (request) => {
    attempts.push(request);
    if (attempts.length === 1) throw new ReviewBusyError("another review is running");
  } });
  await r.panel.setTarget("scene", "Arrival", [{ id: 3, display_name: "Mara", created_at: 1 }]);
  r.click("#review-transport button:nth-of-type(2)"); await tick();
  const actor = r.get<HTMLSelectElement>("[data-actor] select"); actor.value = "existing:3"; actor.dispatchEvent(new Event("change"));
  const mapped = r.get<HTMLSelectElement>('[data-source="Word Writer"] select'); mapped.value = "create"; mapped.dispatchEvent(new Event("change"));
  const name = r.get<HTMLInputElement>('[data-source="Word Writer"] input'); name.value = "Bob"; name.dispatchEvent(new Event("input"));
  r.click("#review-transport-apply"); await tick();
  expect(r.panel.hasPendingReturn()).toBe(true);
  expect(r.get<HTMLButtonElement>("#review-transport-apply").disabled).toBe(false);
  expect(actor.value).toBe("existing:3"); expect(mapped.value).toBe("create"); expect(name.value).toBe("Bob");
  expect(r.calls.cancels).toEqual([]);
  r.click("#review-transport-apply"); await tick();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]?.sources).toEqual([{ source_name: "Word Writer", choice: { kind: "create", display_name: "Bob" } }]);
  expect(r.panel.hasPendingReturn()).toBe(false);
  expect(r.calls.done).toBe(1);
});

test("a committed return with a failed page reconcile is no longer pending", async () => {
  const r = rig({ returnApply: async () => { throw new ReviewAppliedViewError("view could not reload"); } });
  await r.panel.setTarget("scene", "Arrival", [{ id: 3, display_name: "Mara", created_at: 1 }]);
  r.click("#review-transport button:nth-of-type(2)"); await tick();
  const actor = r.get<HTMLSelectElement>("[data-actor] select"); actor.value = "existing:3"; actor.dispatchEvent(new Event("change"));
  const mapped = r.get<HTMLSelectElement>('[data-source="Word Writer"] select'); mapped.value = "existing:3"; mapped.dispatchEvent(new Event("change"));
  r.click("#review-transport-apply"); await tick();
  expect(r.panel.hasPendingReturn()).toBe(false);
  expect(r.panel.hasPreview()).toBe(false);
  expect(r.get<HTMLElement>("#review-transport-status").textContent).toContain("view could not reload");
  expect(r.calls.done).toBe(1);
  expect(r.calls.cancels).toEqual([]);
});

test("pending picker freezes departure and cancellation clears only its token", async () => {
  const pending = deferred<typeof returned>();
  const r = rig({ returnPreview: () => pending.promise });
  await r.panel.setTarget("scene", "Arrival", []);
  r.click("#review-transport button:nth-of-type(2)");
  expect(r.panel.busy()).toBe(true);
  expect(r.get<HTMLButtonElement>("#review-transport button:first-of-type").disabled).toBe(true);
  pending.resolve(returned); await tick();
  expect(r.panel.hasPendingReturn()).toBe(true);
  await r.panel.discard();
  expect(r.calls.cancels).toEqual(["secret-2"]);
  expect(r.panel.hasPreview()).toBe(false);
  expect(r.get<HTMLElement>("#review-transport-preview").hidden).toBe(true);
});

test("invalidating a locked in-flight picker ignores its late answer and stays busy until it settles", async () => {
  const pending = deferred<typeof returned>();
  const r = rig({ returnPreview: () => pending.promise });
  await r.panel.setTarget("scene", "Arrival", []);
  r.click("#review-transport button:nth-of-type(2)");
  expect(r.panel.busy()).toBe(true);
  const invalidating = r.panel.discard(); await invalidating;
  expect(r.panel.busy()).toBe(true);
  pending.resolve(returned); await tick();
  expect(r.panel.busy()).toBe(false);
  expect(r.panel.hasPreview()).toBe(false);
  expect(r.calls.cancels).toEqual(["secret-2"]);
});

test("save failure invalidates the prepared export; picker cancel keeps it", async () => {
  let fail = false;
  const r = rig({ exportSave: async () => { if (fail) throw new Error("write failed"); return false; } });
  await r.panel.setTarget("scene", "Arrival", []);
  r.click("#review-transport button:first-of-type"); await tick();
  r.click("#review-transport-save"); await tick();
  expect(r.get<HTMLButtonElement>("#review-transport-save").disabled).toBe(false);
  fail = true; r.click("#review-transport-save"); await tick();
  expect(r.get<HTMLButtonElement>("#review-transport-save").disabled).toBe(true);
  expect(r.get<HTMLElement>("#review-transport-status").textContent).toContain("write failed");
  expect(t("review.transport.save")).toContain("Save");
});

test("a page-busy save keeps the prepared export for retry", async () => {
  let attempts = 0;
  const r = rig({ exportSave: async () => {
    if (++attempts === 1) throw new ReviewBusyError("another review is running");
    return true;
  } });
  await r.panel.setTarget("scene", "Arrival", []);
  r.click("#review-transport button:first-of-type"); await tick();
  r.click("#review-transport-save"); await tick();
  expect(r.panel.hasPreview()).toBe(true);
  expect(r.get<HTMLButtonElement>("#review-transport-save").disabled).toBe(false);
  r.click("#review-transport-save"); await tick();
  expect(attempts).toBe(2);
  expect(r.panel.hasPreview()).toBe(false);
  expect(r.calls.done).toBe(1);
});

test("a completed save or apply is success news, never the problem channel", async () => {
  // A capture showed "Returned review applied." painted red: both outcomes
  // went through onNotice, which the page raises in the problem tone.
  const r = rig(); await r.panel.setTarget("scene", "Arrival", []);
  r.click("#review-transport button:first-of-type"); await tick();
  r.click("#review-transport-save"); await tick();
  expect(r.calls.successes).toEqual([t("review.transport.saved")]);
  expect(r.calls.notices).toEqual([]);
});
