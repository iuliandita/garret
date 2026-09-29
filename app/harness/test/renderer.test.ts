import { describe, expect, test } from "bun:test";
import { parseRendererFacts, probeRenderer, rendererPath, type RendererFacts } from "../src/renderer";

describe("rendererPath", () => {
  // The four measured launches (2026-09-07) are the four rows that are not
  // contradictions; named here so a reader can match them to the table in
  // the renderer-path design plan.
  const cases: Array<[RendererFacts, ReturnType<typeof rendererPath>, string]> = [
    [
      { glesMapped: false, dmabufDisabledByEnv: false, llvmpipe: false, gdkBackend: null },
      "shm",
      "no gles, not disabled, not llvmpipe",
    ],
    [
      { glesMapped: false, dmabufDisabledByEnv: false, llvmpipe: true, gdkBackend: null },
      "shm",
      "no gles, not disabled, llvmpipe -- Xvfb disabled launch",
    ],
    [
      { glesMapped: false, dmabufDisabledByEnv: true, llvmpipe: false, gdkBackend: null },
      "shm",
      "no gles, disabled, not llvmpipe -- live Wayland disabled launch",
    ],
    [
      { glesMapped: false, dmabufDisabledByEnv: true, llvmpipe: true, gdkBackend: null },
      "shm",
      "no gles, disabled, llvmpipe",
    ],
    [
      { glesMapped: true, dmabufDisabledByEnv: true, llvmpipe: false, gdkBackend: null },
      "unknown",
      "gles under the variable -- WebKit ignored its own switch",
    ],
    [
      { glesMapped: true, dmabufDisabledByEnv: true, llvmpipe: true, gdkBackend: null },
      "unknown",
      "gles under the variable, llvmpipe -- also a contradiction",
    ],
    [
      { glesMapped: true, dmabufDisabledByEnv: false, llvmpipe: true, gdkBackend: null },
      "dmabuf-llvmpipe",
      "gles, not disabled, llvmpipe -- Xvfb default launch",
    ],
    [
      { glesMapped: true, dmabufDisabledByEnv: false, llvmpipe: false, gdkBackend: null },
      "dmabuf-gpu",
      "gles, not disabled, not llvmpipe -- live Wayland default launch",
    ],
  ];

  test.each(cases)("%j -> %s (%s)", (facts, expected) => {
    expect(rendererPath(facts)).toBe(expected);
  });
});

const GLES_MAPS_LINE = "7f0a12345000-7f0a1239a000 r--p 00000000 fd:00 1234 /usr/lib/libGLESv2.so.2.1.0";
const GLES_LIB64_LINE = "7f0a12345000-7f0a1239a000 r--p 00000000 fd:00 1234 /usr/lib64/libGLESv2.so.2";
const GL_MAPS_LINE = "7f0a12345000-7f0a1239a000 r--p 00000000 fd:00 1234 /usr/lib/libGL.so.1.7.0";
const GLX_MAPS_LINE = "7f0a12345000-7f0a1239a000 r--p 00000000 fd:00 1234 /usr/lib/libGLX.so.0.0.0";
const LLVMPIPE_FD = "/memfd:lp_dma_buf (deleted)";
const RENDER_NODE_FD = "/dev/dri/renderD128";
const SOCKET_FD = "socket:[12345]";

describe("parseRendererFacts", () => {
  test("Xvfb default: gles, llvmpipe, not disabled, x11", () => {
    const environ = ["GDK_BACKEND=x11", "HOME=/home/x"].join("\0");
    const facts = parseRendererFacts(GLES_MAPS_LINE, [LLVMPIPE_FD, RENDER_NODE_FD, SOCKET_FD], environ);
    expect(facts).toEqual({
      dmabufDisabledByEnv: false,
      glesMapped: true,
      llvmpipe: true,
      gdkBackend: "x11",
    });
  });

  test("Xvfb disabled: no gles, llvmpipe, disabled", () => {
    const environ = ["WEBKIT_DISABLE_DMABUF_RENDERER=1", "GDK_BACKEND=x11"].join("\0");
    const facts = parseRendererFacts("", [LLVMPIPE_FD, RENDER_NODE_FD], environ);
    expect(facts.glesMapped).toBe(false);
    expect(facts.llvmpipe).toBe(true);
    expect(facts.dmabufDisabledByEnv).toBe(true);
  });

  test("Wayland default: gles, no llvmpipe, wayland,x11,*", () => {
    const environ = ["GDK_BACKEND=wayland,x11,*"].join("\0");
    const facts = parseRendererFacts(GLES_MAPS_LINE, [RENDER_NODE_FD, RENDER_NODE_FD, SOCKET_FD, SOCKET_FD], environ);
    expect(facts.glesMapped).toBe(true);
    expect(facts.llvmpipe).toBe(false);
    expect(facts.gdkBackend).toBe("wayland,x11,*");
  });

  test("Wayland disabled: no gles, no llvmpipe, disabled", () => {
    const environ = ["WEBKIT_DISABLE_DMABUF_RENDERER=1"].join("\0");
    const facts = parseRendererFacts("", [RENDER_NODE_FD, SOCKET_FD, SOCKET_FD], environ);
    expect(facts.glesMapped).toBe(false);
    expect(facts.llvmpipe).toBe(false);
    expect(facts.dmabufDisabledByEnv).toBe(true);
  });

  test("WEBKIT_DISABLE_DMABUF_RENDERER= (empty value) counts as disabled", () => {
    const facts = parseRendererFacts("", [], "WEBKIT_DISABLE_DMABUF_RENDERER=");
    expect(facts.dmabufDisabledByEnv).toBe(true);
  });

  test("libGL.so and libGLX do NOT set glesMapped", () => {
    const facts = parseRendererFacts([GL_MAPS_LINE, GLX_MAPS_LINE].join("\n"), [], "");
    expect(facts.glesMapped).toBe(false);
  });

  test("libGLESv2 in a path other than /usr/lib DOES set glesMapped", () => {
    const facts = parseRendererFacts(GLES_LIB64_LINE, [], "");
    expect(facts.glesMapped).toBe(true);
  });

  test("an environ entry without = is ignored; a value containing = keeps the remainder", () => {
    const environ = ["GARBAGE", "A=b=c"].join("\0");
    const facts = parseRendererFacts("", [], environ);
    expect(facts.gdkBackend).toBeNull();
    // Confirm the split-at-first-= behaviour through a variable this module
    // does read: reuse GDK_BACKEND with an embedded '='.
    const environ2 = ["GDK_BACKEND=a=b=c"].join("\0");
    expect(parseRendererFacts("", [], environ2).gdkBackend).toBe("a=b=c");
  });

  test("empty inputs -> every fact false / null", () => {
    expect(parseRendererFacts("", [], "")).toEqual({
      dmabufDisabledByEnv: false,
      glesMapped: false,
      llvmpipe: false,
      gdkBackend: null,
    });
  });
});

describe("probeRenderer", () => {
  test("probeRenderer([]) is null, not a record of falses", () => {
    expect(probeRenderer([])).toBeNull();
  });

  test("a pid that does not exist yields null, not a record of falses", () => {
    expect(probeRenderer([0x7ffffff0])).toBeNull();
  });

  test("a pid that exists is not null", () => {
    expect(probeRenderer([process.pid])).not.toBeNull();
  });

  test("reads the spawned process's own environment, not this process's", async () => {
    const child = Bun.spawn(["sleep", "5"], {
      env: { ...process.env, GDK_BACKEND: "probe-test-backend", WEBKIT_DISABLE_DMABUF_RENDERER: "" },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // /proc/<pid>/environ is not guaranteed populated the instant
      // Bun.spawn returns; poll until the probe sees it or time out.
      const start = Date.now();
      let rec = probeRenderer([child.pid]);
      while (rec?.gdkBackend !== "probe-test-backend" && Date.now() - start < 2000) {
        await Bun.sleep(20);
        rec = probeRenderer([child.pid]);
      }
      expect(rec).not.toBeNull();
      expect(rec!.gdkBackend).toBe("probe-test-backend");
      expect(rec!.dmabufDisabledByEnv).toBe(true);
      expect(rec!.path).toBe("shm");
      expect(rec!.webProcesses).toBe(1);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("webProcesses is the list's length, not a count of distinct pids read", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const rec = probeRenderer([child.pid, child.pid]);
      expect(rec).not.toBeNull();
      expect(rec!.webProcesses).toBe(2);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
