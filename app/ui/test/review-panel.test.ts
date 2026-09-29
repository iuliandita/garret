import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof document === "undefined") GlobalRegistrator.register();
import { createReviewPanel, proposalSummary, type ReviewPanelDeps } from "../src/review-panel";
import type { ReviewGroup, ReviewState } from "../src/review-types";
import { t } from "../src/i18n";

const body = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] });
const summary = { id: 7, author_name: "Mara", rev: 2, created_at: 1, pending: 1, conflicted: 1, accepted: 0, rejected: 0, messages: 1 };
function group(id = 7, item = "scene"): ReviewGroup {
  return { id, item_id: item, author_id: 3, author_name: "Mara", rev: 2, created_at: 1,
    hunks: ["pending", "conflicted"].map((state, index) => ({ id: 10 + index, state,
      original: { from: 1, to: 2, before: [{ kind: "text", text: "o" }], after: [{ kind: "text", text: "<img src=x>", marks: ["strong", "underline"] }] },
      mapped_from: 1, mapped_to: 2, conflicted_at: state === "conflicted" ? 2 : null,
      decided_at: null, decision_author_id: null, decision_author_name: null })) };
}
const mounted: ReturnType<typeof createReviewPanel>[] = [];
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function rig(overrides: Partial<ReviewPanelDeps> = {}) {
  const calls = { decisions: [] as unknown[][], proposals: [] as unknown[][], messages: [] as unknown[][], notices: [] as string[], done: 0, dismissed: 0 };
  const state = (item: string): ReviewState => ({ document: { item_id: item, body, rev: 4 },
    authors: [{ id: 3, display_name: "Mara", created_at: 1 }], page: { groups: [summary], before_id: null } });
  const panel = createReviewPanel({ load: async (item) => state(item), group: async (id) => group(id),
    messages: async (id) => [{ id: 1, group_id: id, author_id: 3, author_name: "Mara", body: "<script>note</script>", created_at: 1 }],
    createAuthor: async (name) => ({ id: 4, display_name: name, created_at: 2 }),
    createGroup: async (...args) => { calls.proposals.push(args); },
    addMessage: async (...args) => { calls.messages.push(args); }, decide: async (...args) => { calls.decisions.push(args); },
    onDone: () => { calls.done++; }, onNotice: (value) => calls.notices.push(value), onDismiss: () => { calls.dismissed++; }, ...overrides });
  mounted.push(panel);
  const el = document.querySelector<HTMLElement>("#review-panel")!;
  const get = <T extends HTMLElement>(selector: string): T => el.querySelector<T>(selector)!;
  const click = (text: string) => { [...el.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === t(text))!.click(); };
  const author = () => { const field = get<HTMLSelectElement>("#review-author"); field.value = "3"; field.dispatchEvent(new Event("change")); };
  const select = async (id = 7) => { get<HTMLButtonElement>(`[data-group="${id}"]`).click(); await tick(); };
  const writeMessage = (text: string) => { const field = get<HTMLTextAreaElement>("#review-message"); field.value = text; field.dispatchEvent(new Event("input")); };
  return { panel, calls, state, el, get, click, author, select, writeMessage };
}
afterEach(async () => {
  for (const panel of mounted.splice(0)) {
    if (panel.hasUnsaved() && !panel.busy()) {
      const answer = panel.confirmLeave();
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("#review-leave button")];
      buttons.find((entry) => entry.textContent === t("review.discard"))?.click();
      await answer;
    }
    panel.destroy();
  }
  document.body.replaceChildren();
});

test("explicit author, safe rich DOM and partial acceptance preserve exact authority", async () => {
  const r = rig(); await r.panel.open("scene", "Captured title"); await r.select();
  expect(r.get<HTMLSelectElement>("#review-author").value).toBe("");
  r.get<HTMLInputElement>('[data-hunk="10"]').click();
  expect(r.get<HTMLButtonElement>('[data-decision="accept"]').disabled).toBe(true);
  r.author(); expect(r.get<HTMLButtonElement>('[data-decision="accept"]').disabled).toBe(false);
  expect(r.el.querySelectorAll("img,script").length).toBe(0);
  expect(r.get<HTMLElement>(".review-rich strong").textContent).toBe("<img src=x>");
  r.get<HTMLButtonElement>('[data-decision="accept"]').click(); await tick();
  expect(r.calls.decisions).toEqual([["scene", 7, 2, 4, [10], "accept", 3]]);
  expect(r.calls.done).toBe(1);
});

test("conflicted selection disables acceptance but permits rejection", async () => {
  const r = rig(); await r.panel.open("scene", "One"); await r.select(); r.author();
  r.get<HTMLInputElement>('[data-hunk="11"]').click();
  expect(r.get<HTMLButtonElement>('[data-decision="accept"]').disabled).toBe(true);
  r.get<HTMLButtonElement>('[data-decision="reject"]').click(); await tick();
  expect(r.calls.decisions[0]).toEqual(["scene", 7, 2, 4, [11], "reject", 3]);
});

test("stale snapshot replies cannot retarget the panel", async () => {
  const old = deferred<ReviewState>();
  const r = rig({ load: async (id) => id === "old" ? old.promise : r.state(id) });
  const opening = r.panel.open("old", "Old"); await r.panel.open("new", "New");
  old.resolve(r.state("old")); await opening;
  expect(r.get<HTMLElement>(".review-target").textContent).toBe("New");
  expect(r.calls.notices).toEqual([]);
});

test("failed message and explicit refresh preserve the draft and captured group", async () => {
  const r = rig({ addMessage: async () => { throw new Error("stale revision"); } });
  await r.panel.open("scene", "One"); await r.select(); r.author(); r.writeMessage("my note");
  r.click("review.post"); await tick();
  expect(r.get<HTMLTextAreaElement>("#review-message").value).toBe("my note");
  r.click("review.refresh"); await tick();
  expect(r.get<HTMLTextAreaElement>("#review-message").value).toBe("my note");
  expect(r.panel.hasUnsaved()).toBe(true);
  expect(await r.panel.open("other", "Other")).toBe(false);
  expect(r.get<HTMLElement>(".review-target").textContent).toBe("One");
});

test("close defaults to keep; discard is explicit; lock during prompt retains work", async () => {
  let locked = false; const r = rig({ isLocked: () => locked });
  await r.panel.open("scene", "One"); await r.select(); r.writeMessage("unsent");
  const keeping = r.panel.requestClose();
  expect(document.activeElement?.textContent).toBe(t("review.keep"));
  r.click("review.keep"); expect(await keeping).toBe(false); expect(r.panel.hasUnsaved()).toBe(true);
  const leaving = r.panel.confirmLeave(); locked = true; r.click("review.discard");
  expect(r.panel.hasUnsaved()).toBe(true);
  r.click("review.keep"); expect(await leaving).toBe(false);
  expect(await r.panel.requestClose()).toBe(false);
  locked = false; const discard = r.panel.requestClose(); r.click("review.discard");
  expect(await discard).toBe(true); expect(r.el.hidden).toBe(true); expect(r.panel.hasUnsaved()).toBe(false);
});

test("pending decision cannot be abandoned, and failure preserves selection", async () => {
  const pending = deferred<void>(); const r = rig({ decide: () => pending.promise });
  await r.panel.open("scene", "One"); await r.select(); r.author(); r.get<HTMLInputElement>('[data-hunk="10"]').click();
  r.click("review.accept"); expect(r.panel.busy()).toBe(true); expect(await r.panel.confirmLeave()).toBe(false);
  r.panel.destroy(); expect(document.querySelector("#review-panel") !== null).toBe(true);
  pending.reject(new Error("refused")); await tick();
  expect(r.panel.busy()).toBe(false); expect(r.get<HTMLInputElement>('[data-hunk="10"]').checked).toBe(true);
});

test("history and cursor paging replace the bounded list", async () => {
  const calls: unknown[][] = [];
  const r = rig({ load: async (id, cursor, pending) => { calls.push([id, cursor, pending]);
    const state = r.state(id); state.page = { groups: [{ ...summary, id: cursor ? 6 : 7 }], before_id: cursor ? null : 7 }; return state; } });
  await r.panel.open("scene", "One"); r.click("review.next"); await tick();
  expect(r.el.querySelectorAll("[data-group]").length).toBe(1);
  expect(calls[1]).toEqual(["scene", 7, true]);
  r.get<HTMLInputElement>("#review-history").click(); await tick();
  expect(calls[2]).toEqual(["scene", null, false]);
});

test("isolated rich draft submits one hunk and survives a failed submission", async () => {
  let fail = true;
  const r = rig({ createGroup: async (...args) => { r.calls.proposals.push(args); if (fail) throw new Error("stale"); } });
  await r.panel.open("scene", "One"); r.author(); r.click("review.new");
  const prose = r.get<HTMLElement>("#review-draft-editor .ProseMirror");
  prose.querySelector("p")!.textContent = "one two"; await tick(); await tick();
  expect(r.panel.hasUnsaved()).toBe(true);
  r.click("review.submit"); await tick();
  expect(r.calls.proposals[0]).toEqual(["scene", 4, 3, [{ from: 4, to: 4, before: [], after: [{ kind: "text", text: " two" }] }]]);
  expect(prose.textContent).toBe("one two"); expect(r.panel.hasUnsaved()).toBe(true);
  fail = false; r.click("review.submit"); await tick();
  expect(r.panel.hasUnsaved()).toBe(false); expect(r.get<HTMLElement>("#review-draft").hidden).toBe(true);
});

test("an explicitly created author is selected after the authoritative reload", async () => {
  let created = false;
  const r = rig({ createAuthor: async (name) => { created = true; return { id: 4, display_name: name, created_at: 2 }; },
    load: async (id) => { const state = r.state(id); if (created) state.authors.push({ id: 4, display_name: "Sam", created_at: 2 }); return state; } });
  await r.panel.open("scene", "One");
  r.get<HTMLInputElement>("#review-author-name").value = "Sam"; r.click("review.author-create"); await tick();
  expect(r.get<HTMLSelectElement>("#review-author").value).toBe("4");
});

test("a lock between discard click and promise continuation retains drafts", async () => {
  let locked = false; const r = rig({ isLocked: () => locked });
  await r.panel.open("scene", "One"); await r.select(); r.writeMessage("unsent");
  const leaving = r.panel.confirmLeave(); r.click("review.discard"); locked = true;
  expect(await leaving).toBe(false); expect(r.panel.hasUnsaved()).toBe(true);
  locked = false;
});

test("strict draft initialization refuses properties that an editor would discard", async () => {
  const r = rig({ load: async (id) => { const state = r.state(id);
    state.document.body = JSON.stringify({ ...JSON.parse(body), unknown: "retained in store" }); return state; } });
  await r.panel.open("scene", "One"); r.click("review.new");
  expect(r.el.querySelector(".ProseMirror") === null).toBe(true);
  expect(r.calls.notices).toEqual([t("review.invalid-draft")]);
});

test("a late group reply cannot replace a newer selection or its message draft", async () => {
  const late = deferred<ReviewGroup>();
  const r = rig({ load: async (id) => { const state = r.state(id); state.page.groups.push({ ...summary, id: 8 }); return state; },
    group: async (id) => id === 7 ? late.promise : group(id) });
  await r.panel.open("scene", "One"); r.get<HTMLButtonElement>('[data-group="7"]').click(); await r.select(8);
  r.writeMessage("for group eight"); late.resolve(group(7)); await tick();
  r.author(); r.click("review.post"); await tick();
  expect(r.calls.messages[0]).toEqual([8, 2, 3, "for group eight"]);
});

test("departure freezes draft, author, message and decision actions until canceled", async () => {
  let authors = 0;
  const r = rig({ createAuthor: async () => { authors++; return { id: 3, display_name: "Mara", created_at: 1 }; } });
  await r.panel.open("scene", "One"); await r.select(); r.author();
  r.get<HTMLInputElement>('[data-hunk="10"]').click(); r.writeMessage("unsent");
  r.get<HTMLInputElement>("#review-author-name").value = "Mara";
  r.panel.setLeaving(true);
  for (const key of ["review.new", "review.author-create", "review.post", "review.accept"]) {
    const control = [...r.el.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === t(key))!;
    expect(control.disabled).toBe(true);
    control.dispatchEvent(new Event("click"));
  }
  await tick();
  expect(authors).toBe(0); expect(r.calls.messages.length).toBe(0); expect(r.calls.decisions.length).toBe(0);
  expect(r.el.querySelector(".ProseMirror") === null).toBe(true);
  expect(await r.panel.open("other", "Other")).toBe(false);
  r.panel.setLeaving(false); r.click("review.new");
  const prose = r.get<HTMLElement>(".ProseMirror"); expect(prose.getAttribute("contenteditable")).toBe("true");
  r.panel.setLeaving(true); expect(prose.getAttribute("contenteditable")).toBe("false");
  r.panel.setLeaving(false); expect(prose.getAttribute("contenteditable")).toBe("true");
  r.click("review.proposals"); r.click("review.post"); await tick();
  expect(r.calls.messages).toEqual([[7, 2, 3, "unsent"]]);
});

test("a proposal reads as a sentence: author, short date, the non-zero counts only", async () => {
  // 239: the selector used to read "Mara · 9/25/2026, 10:15:37 PM · 1 pending,
  // 0 conflicted, 0 accepted, 0 rejected", a log line.
  const at = new Date(new Date().getFullYear(), 8, 25, 22, 15, 37).getTime();
  expect(proposalSummary({ ...summary, created_at: at, conflicted: 0 })).toBe("Mara, Sep 25, 10:15 PM: 1 pending");
  expect(proposalSummary({ ...summary, created_at: at, accepted: 2 })).toBe("Mara, Sep 25, 10:15 PM: 1 pending, 1 in conflict, and 2 accepted");
  expect(proposalSummary({ ...summary, created_at: at, pending: 0, conflicted: 0 })).toBe("Mara, Sep 25, 10:15 PM");
});

test("the decided-proposals checkbox comes before its words", async () => {
  const { panel } = rig();
  await panel.open("scene", "Scene");
  const box = document.getElementById("review-history")!;
  expect(box.parentElement?.tagName).toBe("LABEL");
  expect(box.parentElement?.firstChild).toBe(box);
  expect(box.parentElement?.textContent).toBe(t("review.history"));
});

test("the proposals lead: creating a reviewer waits behind Add reviewer (240)", async () => {
  const r = rig(); await r.panel.open("scene", "Captured title"); await tick();
  const form = r.get<HTMLElement>("#review-author-form");
  const toggle = r.get<HTMLButtonElement>("#review-author-add");
  expect(form.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // Paging follows the list rather than standing before it.
  const order = [...r.get<HTMLElement>("#review-proposals").children].map((c) => c.id || c.className);
  expect(order.indexOf("review-list")).toBeLessThan(order.indexOf("review-paging"));
  toggle.click();
  expect(form.hidden).toBe(false);
  expect(document.activeElement?.id).toBe("review-author-name");
  r.get<HTMLInputElement>("#review-author-name").value = "Jonas";
  r.click("review.author-create"); await tick(); await tick();
  expect(form.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
