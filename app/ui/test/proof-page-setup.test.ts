import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, test } from "bun:test";
import { createProofPageSetup } from "../src/proof-page-setup";
import type { BookDesign, BookDesignView } from "../src/book-design";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

const design: BookDesign = { font: "EB Garamond", page: { width_um: 152400, height_um: 228600, name: "trade" }, margins: { inner_um: 19050, outer_um: 15875, top_um: 15875, bottom_um: 19050 } };
const view: BookDesignView = { design, fonts: ["EB Garamond"], page_sizes: [{ name: "trade", width_um: 152400, height_um: 228600 }, { name: "a4", width_um: 210000, height_um: 297000 }], presets: [] };
let container: HTMLElement | null = null;
afterEach(() => container?.remove());

test("writes only the changed page setup and preserves the font", async () => {
  container = document.createElement("div"); document.body.append(container);
  const writes: BookDesign[] = [];
  const setup = createProofPageSetup(container, { readDesign: async () => view, writeDesign: async (next) => { writes.push(next); return next; }, refresh: async () => {}, onNotice: () => {} });
  await setup.show();
  const select = container.querySelector<HTMLSelectElement>("#proof-page-select")!;
  select.value = "a4"; select.dispatchEvent(new Event("change"));
  await Promise.resolve(); await Promise.resolve();
  expect(writes).toEqual([{ ...design, page: { width_um: 210000, height_um: 297000, name: "a4" } }]);
  setup.destroy();
});

test("offers only available sizes and reports the rejected value", async () => {
  container = document.createElement("div"); document.body.append(container);
  const notices: string[] = [];
  const setup = createProofPageSetup(container, { readDesign: async () => view, writeDesign: async (next) => next, refresh: async () => {}, onNotice: (message) => notices.push(message) });
  await setup.show();
  expect(container.querySelector<HTMLSelectElement>("#proof-page-select")?.options.length).toBe(2);
  const field = container.querySelector<HTMLInputElement>("#proof-page-margins input")!;
  field.value = "wide-ish"; field.dispatchEvent(new Event("change"));
  expect(notices.at(-1)).toContain("wide-ish");
  setup.destroy();
});

test("Enter commits a margin without waiting for blur", async () => {
  container = document.createElement("div"); document.body.append(container);
  const writes: BookDesign[] = [];
  const setup = createProofPageSetup(container, { readDesign: async () => view, writeDesign: async (next) => { writes.push(next); return next; }, refresh: async () => {}, onNotice: () => {} });
  await setup.show();
  const field = container.querySelector<HTMLInputElement>("#proof-page-margins input")!;
  field.value = "20"; field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await Promise.resolve(); await Promise.resolve();
  expect(writes.at(-1)?.margins.inner_um).toBe(20_000);
  setup.destroy();
});

test("reopening waits for the pending save before reading its landed state", async () => {
  container = document.createElement("div"); document.body.append(container);
  const held: { release: ((value: BookDesign) => void) | null } = { release: null };
  let answer = view;
  const setup = createProofPageSetup(container, { readDesign: async () => answer, writeDesign: () => new Promise<BookDesign>((resolve) => { held.release = resolve; }), refresh: async () => {}, onNotice: () => {} });
  await setup.show();
  const select = container.querySelector<HTMLSelectElement>("#proof-page-select")!;
  select.value = "a4"; select.dispatchEvent(new Event("change"));
  await Promise.resolve(); await Promise.resolve();
  setup.hide();
  const reopening = setup.show();
  expect(select.disabled).toBe(true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(select.disabled).toBe(true);
  if (held.release === null) throw new Error("save did not start");
  answer = { ...view, design: { ...design, page: { width_um: 210000, height_um: 297000, name: "a4" } } };
  held.release(answer.design);
  await reopening;
  expect(select.disabled).toBe(false);
  expect(select.value).toBe("a4");
  setup.destroy();
});

test("a failed or stale load leaves no active controls", async () => {
  container = document.createElement("div"); document.body.append(container);
  const held: { reject: ((reason: Error) => void) | null } = { reject: null };
  const notices: string[] = [];
  const setup = createProofPageSetup(container, { readDesign: () => new Promise<BookDesignView>((_, fail) => { held.reject = fail; }), writeDesign: async (next) => next, refresh: async () => {}, onNotice: (message) => notices.push(message) });
  const opening = setup.show();
  await Promise.resolve();
  const select = container.querySelector<HTMLSelectElement>("#proof-page-select")!;
  expect(select.disabled).toBe(true);
  if (held.reject === null) throw new Error("read did not start");
  held.reject(new Error("offline")); await opening;
  expect(select.disabled).toBe(true);
  expect(notices.at(-1)).toContain("offline");
  setup.destroy();
});


test("refused margins roll back even while focused, without refreshing", async () => {
  container = document.createElement("div");
  document.body.append(container);
  const notices: string[] = [];
  let refreshes = 0;
  const setup = createProofPageSetup(container, {
    readDesign: async () => view,
    writeDesign: async () => { throw new Error("margins do not fit"); },
    refresh: async () => { refreshes += 1; },
    onNotice: (message) => notices.push(message),
  });
  await setup.show();
  const field = container.querySelector<HTMLInputElement>("input")!;
  field.focus();
  const before = field.value;
  field.value = "900";
  field.dispatchEvent(new Event("change"));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(field.value).toBe(before);
  expect(field.disabled).toBe(false);
  expect(notices.at(-1)).toContain("margins do not fit");
  expect(refreshes).toBe(0);
  setup.destroy();
});

test("a save rereads other margins, serializes changes, and refreshes once", async () => {
  container = document.createElement("div");
  document.body.append(container);
  let answer = view;
  const writes: BookDesign[] = [];
  let refreshes = 0;
  const setup = createProofPageSetup(container, {
    readDesign: async () => answer,
    writeDesign: async (next) => { writes.push(next); return next; },
    refresh: async () => { refreshes += 1; },
    onNotice: () => {},
  });
  await setup.show();
  answer = { ...view, design: { ...design, margins: { ...design.margins, outer_um: 22_000 } } };
  const field = container.querySelector<HTMLInputElement>("input")!;
  field.value = "20";
  field.dispatchEvent(new Event("change"));
  field.dispatchEvent(new Event("change"));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.margins).toEqual({ ...design.margins, inner_um: 20_000, outer_um: 22_000 });
  expect(refreshes).toBe(1);
  setup.destroy();
});

test("custom dimensions are named and cannot be selected as a fake preset", async () => {
  container = document.createElement("div");
  document.body.append(container);
  const setup = createProofPageSetup(container, {
    readDesign: async () => ({ ...view, design: { ...design, page: { width_um: 180_000, height_um: 240_000, name: null } } }),
    writeDesign: async (next) => next,
    refresh: async () => {},
    onNotice: () => {},
  });
  await setup.show();
  const option = container.querySelector<HTMLSelectElement>("select")!.selectedOptions[0]!;
  expect(option.textContent).toContain("Custom size");
  expect(option.textContent).toContain("180");
  expect(option.textContent).toContain("240");
  expect(option.disabled).toBe(true);
  setup.destroy();
});
