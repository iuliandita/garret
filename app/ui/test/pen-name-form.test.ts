import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPenNameForm, type PenNameFields, type PenNameForm } from "../src/pen-name-form";

interface Rig {
  form: PenNameForm;
  container: HTMLElement;
  saved: PenNameFields[];
  answer: string | "fail";
  notices: string[];
  created: string[];
  /** A count kept as an array's length rather than a bare number, so a caller
   *  reading `rig.cancelled` after the fact sees live state instead of a
   *  value copied out at construction time. */
  cancelled: number[];
}

function rig(answer: string | "fail" = "i2"): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const saved: PenNameFields[] = [];
  const notices: string[] = [];
  const created: string[] = [];
  const cancelled: number[] = [];
  const form = createPenNameForm({
    container,
    save: async (fields) => {
      saved.push(fields);
      if (answer === "fail") throw new Error("could not save");
      return answer;
    },
    onNotice: (message) => notices.push(message),
    onCreated: (id) => created.push(id),
    onCancel: () => cancelled.push(1),
  });
  return { form, container, saved, answer, notices, created, cancelled };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("createPenNameForm", () => {
  test("open builds the three public fields and Save/Cancel", () => {
    const { form, container } = rig();
    form.open();
    expect(container.querySelector("#library-pen-name-name")).not.toBeNull();
    expect(container.querySelector("#library-pen-name-sort-name")).not.toBeNull();
    expect(container.querySelector("#library-pen-name-bio")).not.toBeNull();
    expect(container.querySelector("#library-pen-name-save")).not.toBeNull();
    expect(container.querySelector("#library-pen-name-cancel")).not.toBeNull();
    expect(form.isOpen()).toBe(true);
  });

  test("close removes the form", () => {
    const { form, container } = rig();
    form.open();
    form.close();
    expect(form.isOpen()).toBe(false);
    expect(container.querySelector("#library-pen-name-name")).toBeNull();
  });

  test("Save with a blank name does not call save at all", async () => {
    const { form, container, saved } = rig();
    form.open();
    const save = container.querySelector<HTMLButtonElement>("#library-pen-name-save")!;
    save.click();
    await Promise.resolve();
    expect(saved).toEqual([]);
  });

  test("Save sends the trimmed public fields and reports the minted id", async () => {
    const { form, container, saved, created } = rig("i7");
    form.open();
    const name = container.querySelector<HTMLInputElement>("#library-pen-name-name")!;
    const sortName = container.querySelector<HTMLInputElement>("#library-pen-name-sort-name")!;
    const bio = container.querySelector<HTMLTextAreaElement>("#library-pen-name-bio")!;
    name.value = "  Ada Vane  ";
    sortName.value = " Vane, Ada ";
    bio.value = " A quiet writer. ";
    const save = container.querySelector<HTMLButtonElement>("#library-pen-name-save")!;
    save.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([{ name: "Ada Vane", sort_name: "Vane, Ada", bio: "A quiet writer." }]);
    expect(created).toEqual(["i7"]);
  });

  test("a failed save raises a notice and does not report a created id", async () => {
    const { form, container, notices, created } = rig("fail");
    form.open();
    const name = container.querySelector<HTMLInputElement>("#library-pen-name-name")!;
    name.value = "Ada Vane";
    const save = container.querySelector<HTMLButtonElement>("#library-pen-name-save")!;
    save.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(notices).toEqual(["could not save"]);
    expect(created).toEqual([]);
  });

  test("Cancel calls onCancel and does not save", () => {
    const { form, container, saved, cancelled } = rig();
    form.open();
    const cancel = container.querySelector<HTMLButtonElement>("#library-pen-name-cancel")!;
    cancel.click();
    expect(saved).toEqual([]);
    expect(cancelled.length).toBe(1);
  });

  test("destroy removes the form even while open", () => {
    const { form, container } = rig();
    form.open();
    form.destroy();
    expect(form.isOpen()).toBe(false);
    expect(container.querySelector("#library-pen-name-name")).toBeNull();
  });
});
