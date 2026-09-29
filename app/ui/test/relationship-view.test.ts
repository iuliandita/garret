import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
import { createRelationshipView, relationshipKey, relationshipPoints, type RelationshipLink } from "../src/relationship-view";
const focus = { kind: "item", id: "same", caption: "Twin", available: true };
const link = (id: string, target = { kind: "cast", id: "same" }): RelationshipLink => ({
  id, source: focus, target, source_caption: "Twin", target_caption: "Twin", source_available: true,
  target_available: true, label: "knows", note: "a private note", citation: "Chapter 2", anchor: null, anchor_stale: false,
});

test("projection preserves kind and ID identity and unavailable canonical endpoints", () => {
  const missing = { ...link("a"), target_available: false };
  const points = relationshipPoints([focus], [missing]);
  expect(points.map(relationshipKey)).toEqual(['["cast","same"]', '["item","same"]']);
  expect(points[0]?.available).toBe(false);
  expect(relationshipPoints([focus], [missing, link("b")])[0]?.available).toBe(false);
});

test("semantic list retains incoming, outgoing, notes, citations, missing references and stale quotes", () => {
  const container = document.createElement("div"); document.body.append(container);
  try {
    const incoming = { ...link("b"), source: { kind: "resource", id: "r" }, target: focus,
      source_available: false, anchor: { quote: "old passage" }, anchor_stale: true };
    const view = createRelationshipView(container); view.update([focus], [incoming, link("a")], focus);
    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Outgoing");
    expect(rows[1]?.textContent).toContain("Incoming");
    expect(rows[1]?.textContent).toContain("Missing reference");
    expect(rows[1]?.textContent).toContain("old passage");
    expect(rows[1]?.textContent).toContain("passage changed");
    expect(rows[0]?.textContent).toContain("a private note");
    expect(rows[0]?.textContent).toContain("Chapter 2");
    rows[0]!.querySelector<HTMLButtonElement>("button")!.click();
    expect(container.querySelector("h3")?.textContent).toContain("Twin (Cast entry)");
    expect(document.activeElement === container.querySelector("h3")).toBe(true);
    expect(container.querySelector("li")?.textContent).toContain("Incoming");
  } finally { container.remove(); }
});

test("diagram bounds do not hide later relationships and native selection reaches every endpoint", () => {
  const container = document.createElement("div"); document.body.append(container);
  try {
    const links = Array.from({ length: 23 }, (_, n) => link(String(n).padStart(2, "0"), { kind: "cast", id: `cast-${n}` }));
    const view = createRelationshipView(container); view.update([focus], links, focus);
    expect(container.querySelectorAll("svg .relationship-edge")).toHaveLength(20);
    expect(container.textContent).toContain("23 relationships with 23 entries.");
    expect(container.textContent).toContain("3 entries are left out of the diagram");
    expect(container.querySelectorAll("li")).toHaveLength(20);
    const next = [...container.querySelectorAll("button")].find((button) => button.textContent === "Next relationships")!;
    next.click();
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("ol")?.start).toBe(21);
    expect(container.querySelectorAll("li")[2]?.textContent).toContain("t-22");
    const search = container.querySelector<HTMLInputElement>("input")!;
    search.value = "cast-22"; search.dispatchEvent(new Event("input"));
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe(relationshipKey(focus));
    select.value = relationshipKey(links[22]!.target); select.dispatchEvent(new Event("change"));
    expect(select.value).toBe(relationshipKey(links[22]!.target));
    expect(container.querySelectorAll("li")).toHaveLength(1);
    view.update([], []);
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  } finally { container.remove(); }
});


test("human captions add unique short suffixes only within same-name same-kind collisions", () => {
  const container = document.createElement("div");
  const view = createRelationshipView(container);
  const points = [
    { ...focus, id: "unique-document-id" },
    { ...focus, kind: "cast", id: "first-aaaa" },
    { ...focus, kind: "cast", id: "second-aaaa" },
    { ...focus, kind: "resource", id: "unique-resource-id", available: false },
  ];
  view.update(points, [], points[0]);
  const options = [...container.querySelectorAll("option")];
  const label = (point: typeof focus) => options.find((option) => option.value === relationshipKey(point))!.textContent;
  expect(label(points[0]!)).toBe("Twin (Document) ");
  expect(label(points[3]!)).toBe("Twin (Research copy) Missing reference");
  expect(label(points[1]!)).toBe("Twin (Cast entry) [t-aaaa] ");
  expect(label(points[2]!)).toBe("Twin (Cast entry) [d-aaaa] ");
  const search = container.querySelector<HTMLInputElement>("input")!;
  const select = container.querySelector<HTMLSelectElement>("select")!;
  search.value = "no matching endpoint"; search.dispatchEvent(new Event("input"));
  expect(select.options).toHaveLength(1);
  expect(select.value).toBe(relationshipKey(points[0]!));
  expect(select.selectedOptions[0]?.textContent).toBe(container.querySelector("h3")!.textContent);
  search.value = "second-aaaa"; search.dispatchEvent(new Event("input"));
  expect(select.options).toHaveLength(2);
  expect(select.value).toBe(relationshipKey(points[0]!));
  select.value = relationshipKey(points[2]!); select.dispatchEvent(new Event("change"));
  expect(container.querySelector("h3")?.textContent).toBe(label(points[2]!));
});

test("the diagram draws direction as arrowheads and names each neighbour with its label", () => {
  const container = document.createElement("div"); document.body.append(container);
  try {
    const incoming = { ...link("b"), source: { kind: "resource", id: "r" }, source_caption: "Field notes", target: focus, label: "cites" };
    const view = createRelationshipView(container); view.update([focus], [incoming, link("a")], focus);
    const edges = [...container.querySelectorAll("svg .relationship-edge")];
    expect(edges).toHaveLength(2);
    // One arrow per direction present: the cast twin is outgoing, the notes incoming.
    expect(container.querySelectorAll("svg .relationship-arrow")).toHaveLength(2);
    const text = [...container.querySelectorAll("svg text")].map((node) => node.firstChild?.textContent ?? "");
    expect(text).toContain("Field notes");
    expect(text).toContain("cites (Research copy)");
    expect(text).toContain("knows (Cast entry)");
    for (const node of container.querySelectorAll("svg text")) {
      expect(node.getAttribute("dominant-baseline")).toBe("middle");
    }
    // Every connector ends before the caption it leads to.
    const captionX = Number(container.querySelectorAll("svg text")[1]!.getAttribute("x"));
    for (const edge of edges) {
      const end = Number(/H (\d+)/.exec(edge.getAttribute("d") ?? "")?.[1]);
      expect(end).toBeLessThan(captionX);
    }
  } finally { container.remove(); }
});
