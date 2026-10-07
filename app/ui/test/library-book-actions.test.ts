import { describe, expect, test } from "bun:test";
import { createLibraryBookActions } from "../src/library-book-actions";
import type { ProjectSwitchOutcome } from "../src/project-switch";

function rig(outcome: ProjectSwitchOutcome = "switched", pinFails = false) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const notices: string[] = [];
  const switched: string[] = [];
  const names: Array<string | undefined> = [];
  const actions = createLibraryBookActions({
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "project_create") return { path: "/books/new.db", name: "New" };
      if (command === "identity_pin_preview") return { token: "book-specific-preview" };
      if (command === "identity_pin") {
        if (args?.token !== "book-specific-preview") throw new Error("missing preview token");
        if (pinFails) throw new Error("identity changed");
        return {};
      }
      throw new Error(`unexpected command ${command}`);
    },
    switchProject: async (path, name) => { switched.push(path); names.push(name); return outcome; },
    refresh: () => {},
    onNotice: (message) => notices.push(message),
  });
  return { actions, calls, notices, switched, names };
}

describe("Library book command contract", () => {
  test("pins the selected identity with the new book's preview token", async () => {
    const r = rig();
    expect(await r.actions.createBook("New", "identity-1")).toBe("opened");
    expect(r.switched).toEqual(["/books/new.db"]);
    expect(r.names).toEqual(["New"]);
    expect(r.calls).toEqual([
      { command: "project_create", args: { name: "New" } },
      { command: "identity_pin_preview", args: { id: "identity-1" } },
      { command: "identity_pin", args: { id: "identity-1", token: "book-specific-preview" } },
    ]);
  });
  for (const outcome of ["failed", "cancelled", "busy"] as const) {
    test(`${outcome} leaves attribution untouched and reports the unopened created book`, async () => {
      const r = rig(outcome);
      expect(await r.actions.createBook("New", "identity-1")).toBe("unopened");
      expect(r.calls.map((call) => call.command)).toEqual(["project_create"]);
      expect(r.notices.join(" ")).toContain("created");
      expect(await r.actions.openBook("/books/other.db")).toBe(false);
    });
  }
  test("a pin failure preserves its problem rather than reporting complete success", async () => {
    const r = rig("switched", true);
    expect(await r.actions.createBook("New", "identity-1")).toBe("unattributed");
    expect(r.notices.join(" ")).toContain("identity changed");
  });
  test("a book already active is a successful open", async () => {
    expect(await rig("same").actions.openBook("/books/new.db")).toBe(true);
  });
});

test("Library open forwards the known title without another host read", async () => {
  const r = rig();
  await r.actions.openBook("/books/other.db", "Pride and Prejudice");
  expect(r.names).toEqual(["Pride and Prejudice"]);
  expect(r.calls).toEqual([]);
});
