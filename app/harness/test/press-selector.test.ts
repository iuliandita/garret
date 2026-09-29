import { describe, expect, test } from "bun:test";
import type { Node } from "../src/nodes";
import { nodeToPress, parsePressSelector, pressPoint, pressSlug } from "../src/press-selector";
import type { Size } from "../src/window-size";

describe("parsePressSelector", () => {
  test("id:x", () => {
    expect(parsePressSelector("id:project-archive-now")).toEqual({ by: "id", value: "project-archive-now" });
  });

  test("name:x", () => {
    expect(parsePressSelector("name:Make an archive")).toEqual({ by: "name", value: "Make an archive" });
  });

  test("a bare token is an id", () => {
    expect(parsePressSelector("status-dot")).toEqual({ by: "id", value: "status-dot" });
  });

  test("trims a bare token", () => {
    expect(parsePressSelector("  status-dot  ")).toEqual({ by: "id", value: "status-dot" });
  });

  test("trims the value half of a typed form", () => {
    expect(parsePressSelector("id: foo ")).toEqual({ by: "id", value: "foo" });
  });

  for (const bad of ["id:", "name:", "", "id:   ", "   "]) {
    test(`empty (or blank) value "${bad}" throws naming the format`, () => {
      expect(() => parsePressSelector(bad)).toThrow(/id:<dom-id>|name:<accessible name>/);
    });
  }
});

describe("nodeToPress", () => {
  const nodes: Node[] = [
    { role: "push button", id: "add-a", name: "Add", x: 10, y: 10, w: 20, h: 20 },
    { role: "push button", id: "add-b", name: "Add", x: 50, y: 10, w: 20, h: 20 },
    { role: "push button", id: "project-archive-now", name: "Make an archive", x: 0, y: 0, w: 10, h: 10 },
    { role: "entry", id: "", name: "", x: 0, y: 0, w: 0, h: 0 },
    { role: "list item", id: "", name: "Scene A", x: 0, y: 40, w: 100, h: 20 },
    { role: "toggle button", id: "format-bold", name: "Bold", x: 0, y: 0, w: 10, h: 10 },
  ];

  test("by id finds one", () => {
    expect(nodeToPress(nodes, { by: "id", value: "format-bold" })).toBe(nodes[5]!);
  });

  test("by name finds one", () => {
    expect(nodeToPress(nodes, { by: "name", value: "Make an archive" })).toBe(nodes[2]!);
  });

  test("by name Add throws naming both positions and both ids", () => {
    let message = "";
    try {
      nodeToPress(nodes, { by: "name", value: "Add" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(
      /push button at 10,10.*push button at 50,10|push button at 50,10.*push button at 10,10/s,
    );
    expect(message).toContain('id "add-a"');
    expect(message).toContain('id "add-b"');
  });

  test("by name throws naming a candidate with no id as such", () => {
    const withUnidentifiedMatch: Node[] = [
      { role: "push button", id: "", name: "Save", x: 0, y: 0, w: 10, h: 10 },
      { role: "push button", id: "", name: "Save", x: 20, y: 0, w: 10, h: 10 },
    ];
    expect(() => nodeToPress(withUnidentifiedMatch, { by: "name", value: "Save" })).toThrow(/no id/);
  });

  test("by id nope throws and lists the ids present, not the empty one", () => {
    let message = "";
    try {
      nodeToPress(nodes, { by: "id", value: "nope" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("add-a");
    expect(message).toContain("add-b");
    expect(message).toContain("project-archive-now");
    expect(message).toContain("format-bold");
    // The empty id sits in the MIDDLE of the fixture, so a leading-comma check
    // alone passes with the filter deleted: no empty entry anywhere.
    expect(message).not.toMatch(/present:\s*,/);
    expect(message).not.toMatch(/,\s*,/);
    expect(message).not.toMatch(/,\s*$/);
    expect(message.split("present: ")[1]!.split(", ")).toHaveLength(4);
  });

  test("by name that matches nothing lists the named roles, not the unnamed entry", () => {
    let message = "";
    try {
      nodeToPress(nodes, { by: "name", value: "Nonexistent" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('push button "Add"');
    expect(message).toContain('push button "Make an archive"');
    expect(message).toContain('list item "Scene A"');
    expect(message).toContain('toggle button "Bold"');
    expect(message).not.toContain('entry ""');
    expect(message).not.toMatch(/,\s*,/);
  });
});

describe("pressSlug", () => {
  test("a name selector", () => {
    expect(pressSlug({ by: "name", value: "Make an archive" })).toBe("name-make-an-archive");
  });

  test("an id selector", () => {
    expect(pressSlug({ by: "id", value: "status-dot" })).toBe("id-status-dot");
  });

  test("strips a trailing hyphen run rather than leaving it dangling", () => {
    expect(pressSlug({ by: "name", value: "Who's on first?" })).toBe("name-who-s-on-first");
  });

  test("strips a leading hyphen run too", () => {
    expect(pressSlug({ by: "name", value: "!!!Add" })).toBe("name-add");
  });

  test("an all-punctuation value slugs to just the selector kind", () => {
    expect(pressSlug({ by: "name", value: "???" })).toBe("name");
  });
});

describe("pressPoint", () => {
  const window: Size = { width: 800, height: 600 };
  const good: Node = { role: "push button", id: "x", name: "X", x: 10, y: 20, w: 30, h: 40 };

  test("a good node returns its centre", () => {
    expect(pressPoint(good, window)).toEqual({ x: 25, y: 40 });
  });

  test("zero width refuses: the control has no extent", () => {
    expect(() => pressPoint({ ...good, w: 0 }, window)).toThrow(/no extent/);
  });

  test("zero height refuses: the control has no extent", () => {
    expect(() => pressPoint({ ...good, h: 0 }, window)).toThrow(/no extent/);
  });

  test("a centre past the right edge refuses naming the window and the point", () => {
    const node = { ...good, x: 790, w: 40 };
    expect(() => pressPoint(node, window)).toThrow(/800x600/);
  });

  test("a centre past the bottom refuses naming the window and the point", () => {
    const node = { ...good, y: 590, h: 40 };
    expect(() => pressPoint(node, window)).toThrow(/800x600/);
  });

  test("negative x refuses", () => {
    const node = { ...good, x: -100, w: 10 };
    expect(() => pressPoint(node, window)).toThrow(/800x600/);
  });
});
