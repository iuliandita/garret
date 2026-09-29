import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { descendantsByComm, readRssKb, sumTreeRssKb, treePids, treeRssByCommKb } from "../src/rss";

describe("rss", () => {
  test("reads this process's own RSS as a positive number", () => {
    expect(readRssKb(process.pid)).toBeGreaterThan(0);
  });

  test("a dead pid reads as 0 rather than throwing", () => {
    expect(readRssKb(0x7ffffff0)).toBe(0);
  });

  test("tree sum is at least the root's own RSS", () => {
    // BRACKETED, because the two readings are taken at different instants and
    // this process's RSS moves in BOTH directions between them.
    //
    // The previous version read self first and the sum second, on the argument
    // that sumTreeRssKb's first call warms /proc scanning and only ever grows
    // the process. That is true of the warm-up and false in general: the kernel
    // can reclaim pages in the same window, and then the sum is smaller than a
    // figure the process no longer has. Caught at roughly 1 run in 12 — an
    // intermittent failure in a suite otherwise green, which is the kind
    // nobody looks for the second time.
    //
    // The claim being made is that the tree sum INCLUDES the root, so the
    // honest comparison is against the smallest the root actually was while the
    // sum was being taken.
    const before = readRssKb(process.pid);
    const sum = sumTreeRssKb(process.pid);
    const after = readRssKb(process.pid);
    expect(before).toBeGreaterThan(0);
    expect(sum).toBeGreaterThanOrEqual(Math.min(before, after));
  });

  test("the split names this process by its comm and carries at least its RSS under that name", () => {
    const before = readRssKb(process.pid);
    const split = treeRssByCommKb(process.pid);
    const after = readRssKb(process.pid);
    const own = readFileSync(`/proc/${process.pid}/comm`, "utf8").trim();
    expect(own).not.toBe("");
    expect(Object.keys(split)).toContain(own);
    // Bracketed for the same reason as the tree sum above.
    expect(split[own]!).toBeGreaterThanOrEqual(Math.min(before, after));
    // Every value is a whole process's reading, so none is zero or negative,
    // and no process that vanished mid-walk leaves an unnamed key.
    for (const [comm, kb] of Object.entries(split)) {
      expect(comm).not.toBe("");
      expect(kb).toBeGreaterThan(0);
    }
  });

  test("two processes with one name are SUMMED under it, not overwritten", async () => {
    // A child of this process running the same binary shares its comm. With
    // it alive, the figure under that name must exceed anything this process
    // alone could read -- which is what separates a sum from a last-writer.
    const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 20000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      // Let the child map its runtime; a just-forked process reads a few MB.
      const childStart = Date.now();
      while (readRssKb(child.pid) < 10_000 && Date.now() - childStart < 5000) await Bun.sleep(50);
      const own = readFileSync(`/proc/${process.pid}/comm`, "utf8").trim();
      const ownKb = readRssKb(process.pid);
      const childKb = readRssKb(child.pid);
      expect(childKb).toBeGreaterThan(0);
      const split = treeRssByCommKb(process.pid);
      const childComm = readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
      expect(childComm).toBe(own);
      // Above the parent alone by at least half of what the child reads: the
      // two readings are not simultaneous, hence the slack.
      expect(split[own]!).toBeGreaterThan(ownKb + childKb / 2);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("the split of a dead pid is empty rather than a zero under an empty name", () => {
    expect(treeRssByCommKb(0x7ffffff0)).toEqual({});
  });

  test("descendantsByComm excludes the root even when the root's own comm matches", () => {
    const own = readFileSync(`/proc/${process.pid}/comm`, "utf8").trim();
    expect(descendantsByComm(process.pid, own)).not.toContain(process.pid);
  });

  test("descendantsByComm finds a matching descendant by name", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const start = Date.now();
      let found: number[] = [];
      while (Date.now() - start < 5000) {
        found = descendantsByComm(process.pid, "sleep");
        if (found.includes(child.pid)) break;
        await Bun.sleep(50);
      }
      expect(found).toContain(child.pid);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("descendantsByComm returns only the comm asked for, not every descendant", async () => {
    // The filter is the function. Without it "find the web process" returns
    // xvfb-run, Xvfb and the shell too, and the first of THOSE is what would
    // be read as the renderer.
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const start = Date.now();
      while (Date.now() - start < 5000 && !descendantsByComm(process.pid, "sleep").includes(child.pid)) {
        await Bun.sleep(50);
      }
      expect(descendantsByComm(process.pid, "sleep")).toContain(child.pid);
      expect(descendantsByComm(process.pid, "no-such-comm")).toEqual([]);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("descendantsByComm of a dead pid is empty", () => {
    expect(descendantsByComm(0x7ffffff0, "x")).toEqual([]);
  });

  test("treePids starts with the root pid", () => {
    expect(treePids(process.pid)[0]).toBe(process.pid);
  });

  test("treePids contains a spawned child", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const start = Date.now();
      let pids: number[] = [];
      while (Date.now() - start < 5000) {
        pids = treePids(process.pid);
        if (pids.includes(child.pid)) break;
        await Bun.sleep(50);
      }
      expect(pids).toContain(child.pid);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("treePids of a dead pid is empty", () => {
    expect(treePids(0x7ffffff0)).toEqual([]);
  });

  test("descendantsByComm returns matches sorted ascending by pid", async () => {
    const a = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const start = Date.now();
      let found: number[] = [];
      while (Date.now() - start < 5000) {
        found = descendantsByComm(process.pid, "sleep");
        if (found.includes(a.pid) && found.includes(b.pid)) break;
        await Bun.sleep(50);
      }
      expect(found).toContain(a.pid);
      expect(found).toContain(b.pid);
      expect(found).toEqual([...found].sort((x, y) => x - y));
    } finally {
      a.kill();
      b.kill();
      await a.exited;
      await b.exited;
    }
  });
});
