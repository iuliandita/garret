import { expect, test } from "bun:test";
import { createPrivacyStartupInvoke, waitForPrivacyUnlock } from "../src/privacy";

test("startup waits behind recovery and lock, then releases without reloading", async () => {
  let changed: () => void | Promise<void> = () => {};
  let status = { enabled: true, locked: true, recovery: false };
  let initialized = false;
  let removed = false;
  const pending = waitForPrivacyUnlock(async () => status, async (_, callback) => {
    changed = callback;
    return () => { removed = true; };
  }).then(() => { initialized = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(initialized).toBe(false);
  status = { enabled: true, locked: false, recovery: true };
  await changed();
  expect(initialized).toBe(false);
  status = { enabled: true, locked: false, recovery: false };
  await changed(); await pending;
  expect(initialized).toBe(true);
  expect(removed).toBe(true);
});

test("an unlock during listener installation is read after subscribing", async () => {
  let locked = true;
  await waitForPrivacyUnlock(async () => ({ locked, recovery: false }), async () => {
    locked = false;
    return () => {};
  });
  expect(locked).toBe(false);
});


test("a lock during bootstrap pauses the read and resumes without replaying setup", async () => {
  let locked = true;
  let reads = 0;
  let listener: () => void | Promise<void> = () => {};
  let subscriptions = 0;
  const bridge = createPrivacyStartupInvoke(async (command) => {
    if (command === "privacy_status") return { locked, recovery: false };
    reads++;
    if (locked) throw "application locked";
    return "the document";
  }, async (_, callback) => { subscriptions++; listener = callback; return () => { subscriptions--; }; });
  let resolved = false;
  const loading = bridge.invoke("doc_load", { itemId: "scene" }).then((value) => { resolved = true; return value; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(resolved).toBe(false);
  expect(reads).toBe(1);
  locked = false;
  await listener();
  expect(await loading).toBe("the document");
  expect(reads).toBe(2);
  expect(subscriptions).toBe(0);
  bridge.complete();
  locked = true;
  await expect(bridge.invoke("doc_load")).rejects.toBe("application locked");
});

test("bootstrap does not retry mutations or genuine storage failures", async () => {
  let calls = 0;
  const bridge = createPrivacyStartupInvoke(async (command) => {
    calls++;
    throw command === "doc_load" ? "database is damaged" : "application locked";
  }, async () => { throw new Error("must not subscribe"); });
  await expect(bridge.invoke("item_create")).rejects.toBe("application locked");
  await expect(bridge.invoke("doc_load")).rejects.toBe("database is damaged");
  expect(calls).toBe(2);
});

test("bootstrap retries the on-demand statistics projection after unlock", async () => {
  let locked = true;
  let listener: () => void | Promise<void> = () => {};
  let calls = 0;
  const bridge = createPrivacyStartupInvoke(async (command) => {
    if (command === "privacy_status") return { locked, recovery: false };
    calls++;
    if (locked) throw "application locked";
    return { scene: { words: 1, sentences: 1, paragraphs: 1 } };
  }, async (_, callback) => {
    listener = callback;
    return () => {};
  });
  const loading = bridge.invoke("project_document_counts");
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  locked = false;
  await listener();
  await expect(loading).resolves.toEqual({ scene: { words: 1, sentences: 1, paragraphs: 1 } });
  expect(calls).toBe(2);
});
