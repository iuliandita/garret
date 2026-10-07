import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { createCreationChooser } from "../src/creation-chooser";
import { t } from "../src/i18n";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function rig() {
  const origin = document.createElement("button");
  document.body.append(origin);
  let selected = "Folder A";
  const actions: string[] = [];
  const chooser = createCreationChooser({
    create: (type) => actions.push(type), matter: (kind) => actions.push(kind),
    returnFocus: () => origin.focus(),
    bible: () => {
      const destination = selected;
      return { destination, entry: () => {
        expect(panel().hidden).toBe(true);
        expect(document.activeElement === origin).toBe(true);
        actions.push(destination);
      }, folder: () => actions.push("folder"), timeline: () => actions.push("timeline") };
    },
  });
  const panel = (): HTMLElement => document.getElementById("creation-chooser")!;
  const click = (id: string): void => document.getElementById(id)?.click();
  return { chooser, panel, actions, origin, click, select: (name: string) => { selected = name; },
    destroy: () => { chooser.destroy(); origin.remove(); } };
}

test("manuscript actions lead; More contains Bible and book pages", () => {
  const r = rig();
  try {
    r.chooser.open();
    const body = r.panel().querySelector(".panel-body")!;
    expect([...body.children].map((child) => child.id)).toEqual(["create-scene", "create-chapter", "create-part", "creation-more"]);
    const more = document.getElementById("creation-more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    more.open = true;
    expect(more.querySelectorAll("section")).toHaveLength(2);
    expect(more.querySelector("h3")?.textContent).toBe(t("creation.bible"));
    expect(more.querySelector("#create-bible-entry")).not.toBeNull();
    expect(more.querySelector("#create-dedication")).not.toBeNull();
    r.click("create-chapter");
    expect(r.actions).toEqual(["chapter"]);
    expect(r.panel().hidden).toBe(true);
  } finally { r.destroy(); }
});

test("Bible destination and action stay captured while the selected folder changes", () => {
  const r = rig();
  try {
    r.chooser.open(true);
    expect(r.panel().querySelector(".panel-close")?.getAttribute("aria-label")).toBe(t("panel.close", { title: t("creation.bible") }));
    expect(r.panel().querySelector(".creation-destination")?.textContent).toBe(t("creation.destination", { name: "Folder A" }));
    expect(r.panel().querySelector("h3") === null).toBe(true);
    r.select("Folder B");
    r.click("create-bible-entry");
    expect(r.actions).toEqual(["Folder A"]);
  } finally { r.destroy(); }
});

for (const dismissal of ["Escape", "Close", "outside"]) test(`${dismissal} dismisses without creating`, () => {
  const r = rig();
  try {
    r.chooser.open();
    if (dismissal === "Escape") r.panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    else if (dismissal === "Close") (r.panel().querySelector(".panel-close") as HTMLElement).click();
    else r.origin.click();
    expect(r.panel().hidden).toBe(true);
    expect(r.actions).toEqual([]);
    if (dismissal !== "outside") expect(document.activeElement === r.origin).toBe(true);
  } finally { r.destroy(); }
});

test("destroyed chooser cannot reopen or run a retained action", () => {
  const r = rig();
  r.chooser.open(true);
  const retained = document.getElementById("create-bible-entry")!;
  r.destroy();
  retained.click();
  r.chooser.open();
  expect(document.getElementById("creation-chooser")).toBeNull();
  expect(r.actions).toEqual([]);
});
