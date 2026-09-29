import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_ARGS } from "../src/shell";
import {
  MAX_WINDOW,
  MIN_WINDOW,
  SHARED_SCREEN,
  parseGeometry,
  parseSize,
  screenOf,
  serverArgsFor,
} from "../src/window-size";

describe("parseSize", () => {
  test("accepts WIDTHxHEIGHT", () => {
    expect(parseSize("800x600")).toEqual({ width: 800, height: 600 });
  });

  test("the floor is inclusive", () => {
    expect(parseSize("640x480")).toEqual({ width: 640, height: 480 });
  });

  test("under the floor throws naming it", () => {
    expect(() => parseSize("639x480")).toThrow(/640x480/);
    expect(() => parseSize("640x479")).toThrow(/640x480/);
  });

  for (const bad of ["800", "800x", "x600", "800x600x24", "800X600", " 800x600"]) {
    test(`rejects malformed "${bad}"`, () => {
      expect(() => parseSize(bad)).toThrow(/WIDTHxHEIGHT/);
    });
  }

  test("the ceiling is inclusive", () => {
    expect(parseSize("8192x8192")).toEqual({ width: 8192, height: 8192 });
  });

  test("over the ceiling throws naming it", () => {
    expect(() => parseSize("8193x480")).toThrow(/8192/);
    expect(() => parseSize("640x8193")).toThrow(new RegExp(String(MAX_WINDOW)));
  });
});

describe("screenOf", () => {
  test("parses SERVER_ARGS", () => {
    expect(screenOf(SERVER_ARGS)).toEqual(SHARED_SCREEN);
  });

  test("parses a made-up server-args string", () => {
    expect(screenOf("-screen 0 640x480x16 -s 0 -noreset")).toEqual({ width: 640, height: 480 });
  });

  test("throws when no screen geometry is present", () => {
    expect(() => screenOf("-s 0 -noreset")).toThrow(/-screen/);
  });
});

describe("parseGeometry", () => {
  const sample = "WINDOW=12345\nX=0\nY=0\nWIDTH=1200\nHEIGHT=800\nSCREEN=0\n";

  test("reads WIDTH and HEIGHT out of getwindowgeometry --shell output", () => {
    expect(parseGeometry(sample)).toEqual({ width: 1200, height: 800 });
  });

  test("throws when a field is missing", () => {
    const missingHeight = "WINDOW=12345\nX=0\nY=0\nWIDTH=1200\nSCREEN=0\n";
    expect(() => parseGeometry(missingHeight)).toThrow(/WIDTH=\/HEIGHT=/);
  });
});

describe("serverArgsFor", () => {
  test("null keeps the shared server", () => {
    expect(serverArgsFor(null)).toBe(SERVER_ARGS);
  });

  test("a size well within the shared screen keeps it", () => {
    expect(serverArgsFor({ width: 1200, height: 800 })).toBe(SERVER_ARGS);
  });

  test("exactly fits with margin keeps it", () => {
    expect(serverArgsFor({ width: 1200, height: 944 })).toBe(SERVER_ARGS);
  });

  test("one pixel over width widens the server", () => {
    const args = serverArgsFor({ width: 1201, height: 944 });
    const m = /^-screen 0 (\d+)x(\d+)x24 -s 0 -noreset$/.exec(args);
    expect(m).not.toBeNull();
    const [, w, h] = m as RegExpExecArray;
    expect(Number(w)).toBeGreaterThanOrEqual(1201 + 80);
    expect(Number(h)).toBeGreaterThanOrEqual(SHARED_SCREEN.height);
  });

  test("one pixel over height widens the server", () => {
    const args = serverArgsFor({ width: 1200, height: 945 });
    const m = /^-screen 0 (\d+)x(\d+)x24 -s 0 -noreset$/.exec(args);
    expect(m).not.toBeNull();
    const [, w, h] = m as RegExpExecArray;
    expect(Number(w)).toBeGreaterThanOrEqual(SHARED_SCREEN.width);
    expect(Number(h)).toBeGreaterThanOrEqual(945 + 80);
  });

  test("a size that only pushes width widens height only to the floor of 1024", () => {
    const args = serverArgsFor({ width: 2000, height: 480 });
    expect(args).toBe("-screen 0 2080x1024x24 -s 0 -noreset");
  });

  test("the widened string changes only the geometry token, nothing else in SERVER_ARGS", () => {
    const widened = serverArgsFor({ width: 2000, height: 480 });
    const stripToken = (s: string): string => s.replace(/\d+x\d+x\d+/, "<geometry>");
    expect(stripToken(widened)).toBe(stripToken(SERVER_ARGS));
    expect(widened).not.toBe(SERVER_ARGS);
  });
});

describe("MIN_WINDOW drift", () => {
  test("matches the host's own floor in projects.rs", () => {
    const path = join(import.meta.dir, "..", "..", "shell-tauri", "src-tauri", "src", "projects.rs");
    const src = readFileSync(path, "utf8");
    const m = /MIN_WINDOW: WindowSize = WindowSize \{\s*width: (\d+),\s*height: (\d+)/.exec(src);
    expect(m).not.toBeNull();
    const [, width, height] = m as RegExpExecArray;
    expect(MIN_WINDOW).toEqual({ width: Number(width), height: Number(height) });
  });
});
