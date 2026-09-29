// app/harness/src/renderer.ts
// Which WebKitGTK renderer drew the page, read from the web process's /proc.
// The one variable that separated a memory PASS from a FAIL on the same
// build was in neither result until this file existed. Facts first, the
// name derived from them, and the derivation is a pure function so the
// matrix it answers over is enumerable in a test.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

export interface RendererFacts {
  /** `WEBKIT_DISABLE_DMABUF_RENDERER` present (any value) in the web process's environment. */
  dmabufDisabledByEnv: boolean;
  /** `libGLESv2` mapped in the web process. WebKit's DMA-BUF renderer draws
   *  through GLES; its shared-memory fallback never loads it (measured on
   *  four launches, 2026-09-07). */
  glesMapped: boolean;
  /** A `memfd:lp_dma_buf` fd in the web process: Mesa's llvmpipe is the
   *  rasterizer, i.e. software GL. Every Xvfb run; never the GPU desktop. */
  llvmpipe: boolean;
  /** `GDK_BACKEND` from the web process's environment, null when unset. */
  gdkBackend: string | null;
}

export type RendererPath = "dmabuf-gpu" | "dmabuf-llvmpipe" | "shm" | "unknown";

export interface RendererRecord extends RendererFacts {
  path: RendererPath;
  /** How many `WebKitWebProces` descendants the shell had; the facts are the first's. */
  webProcesses: number;
}

/** The name, from the facts. "shm" is what WebKit calls its fallback, and
 *  the absence of GLES is the observation that names it, whatever the
 *  cause; `dmabufDisabledByEnv` records the cause when it was the
 *  variable. GLES mapped UNDER the variable is a contradiction (WebKit
 *  ignored its own switch) and is named unknown rather than guessed. */
export function rendererPath(f: RendererFacts): RendererPath {
  if (!f.glesMapped) return "shm";
  if (f.dmabufDisabledByEnv) return "unknown";
  return f.llvmpipe ? "dmabuf-llvmpipe" : "dmabuf-gpu";
}

/** Pure over the three files' contents. `fdLinks` are readlink targets. */
export function parseRendererFacts(maps: string, fdLinks: readonly string[], environ: string): RendererFacts {
  const vars = new Map<string, string>();
  for (const entry of environ.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) vars.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return {
    dmabufDisabledByEnv: vars.has("WEBKIT_DISABLE_DMABUF_RENDERER"),
    glesMapped: /\/libGLESv2\.so/.test(maps),
    llvmpipe: fdLinks.some((l) => l.startsWith("/memfd:lp_dma_buf")),
    gdkBackend: vars.get("GDK_BACKEND") ?? null,
  };
}

/** Null, not "", when the file cannot be read: a pid that existed during the
 *  tree walk but died before the read must not be reported as a genuine
 *  all-false ("shm") reading. */
function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Null when the fd directory itself cannot be read (process gone); an
 *  individual fd that raced a close is just dropped, same as before. */
function fdLinksOf(pid: number): string[] | null {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((n) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${n}`)];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
}

/** The record for a shell whose web processes are `webPids` (ascending pid;
 *  the first is the oldest web process in the usual case). Null when there
 *  is none, or when the pid died before it could be read: a record with
 *  every fact false would read as a measured "shm". */
export function probeRenderer(webPids: readonly number[]): RendererRecord | null {
  const [first] = webPids;
  if (first === undefined) return null;
  const maps = read(`/proc/${first}/maps`);
  const environ = read(`/proc/${first}/environ`);
  const fdLinks = fdLinksOf(first);
  if (maps === null || environ === null || fdLinks === null) return null;
  const facts = parseRendererFacts(maps, fdLinks, environ);
  return { ...facts, path: rendererPath(facts), webProcesses: webPids.length };
}
