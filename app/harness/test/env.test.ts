import { afterEach, describe, expect, test } from "bun:test";
import { captureEnv, noteRenderer, parseCpuModel, parseLoadAvg1m } from "../src/env";
import type { RendererRecord } from "../src/renderer";

describe("parseCpuModel", () => {
  test("extracts the first model name line", () => {
    const cpuinfo = [
      "processor\t: 0",
      "model name\t: AMD Ryzen 7 PRO 7735U with Radeon Graphics",
      "processor\t: 1",
      "model name\t: AMD Ryzen 7 PRO 7735U with Radeon Graphics",
    ].join("\n");
    expect(parseCpuModel(cpuinfo)).toBe("AMD Ryzen 7 PRO 7735U with Radeon Graphics");
  });

  test("unknown rather than empty when the field is absent", () => {
    expect(parseCpuModel("processor\t: 0\n")).toBe("unknown");
  });
});

describe("parseLoadAvg1m", () => {
  test("reads the first field", () => {
    expect(parseLoadAvg1m("9.33 10.60 6.45 3/1842 41211\n")).toBe(9.33);
  });

  test("null, not zero, when the file is unreadable", () => {
    expect(parseLoadAvg1m("")).toBeNull();
  });
});

describe("captureEnv", () => {
  afterEach(() => {
    noteRenderer(null);
  });

  test("renderer is null before any launch was noted", () => {
    expect(captureEnv().renderer).toBeNull();
  });

  test("renderer is the noted record, the same object, after noteRenderer", () => {
    const rec: RendererRecord = {
      dmabufDisabledByEnv: false,
      glesMapped: true,
      llvmpipe: true,
      gdkBackend: "x11",
      path: "dmabuf-llvmpipe",
      webProcesses: 1,
    };
    noteRenderer(rec);
    expect(captureEnv().renderer).toBe(rec);
  });

  test("renderer is null again after noteRenderer(null)", () => {
    noteRenderer({
      dmabufDisabledByEnv: false,
      glesMapped: true,
      llvmpipe: false,
      gdkBackend: "wayland,x11,*",
      path: "dmabuf-gpu",
      webProcesses: 1,
    });
    noteRenderer(null);
    expect(captureEnv().renderer).toBeNull();
  });

  test("records the start load as a number", () => {
    expect(typeof captureEnv().loadAvg1m).toBe("number");
  });

  test("records kernel and cpu and carries the bias note", () => {
    const env = captureEnv();
    expect(env.kernel.length).toBeGreaterThan(0);
    expect(env.cpu.length).toBeGreaterThan(0);
    expect(env.biasNotes).toContain("Linux");
  });

  test("carries no home directory path", () => {
    noteRenderer({
      dmabufDisabledByEnv: false,
      glesMapped: true,
      llvmpipe: true,
      gdkBackend: "x11",
      path: "dmabuf-llvmpipe",
      webProcesses: 1,
    });
    const env = captureEnv();
    expect(JSON.stringify(env)).not.toContain("/home/");
  });

  test("renderer record shape is exactly the documented fields", () => {
    noteRenderer({
      dmabufDisabledByEnv: false,
      glesMapped: true,
      llvmpipe: true,
      gdkBackend: "x11",
      path: "dmabuf-llvmpipe",
      webProcesses: 1,
    });
    const env = captureEnv();
    expect(Object.keys(env.renderer!).sort()).toEqual(
      ["dmabufDisabledByEnv", "gdkBackend", "glesMapped", "llvmpipe", "path", "webProcesses"].sort(),
    );
  });
});
