// lab/fixtures/gen/src/structure.ts
import type { Prng } from "./prng";
import type { Item } from "./model";

const TITLE_WORDS = [
  "Winter", "Harbor", "Letter", "Storm", "Garden", "Lantern", "River",
  "Straße", "CAFÉ", "café", "Ombré", "Ausência", "Nocturne",
];

function pad(n: number): string {
  return n.toString().padStart(6, "0");
}

// Deterministic hierarchy: parts -> chapters -> scenes, plus ~5% freeform docs.
export function buildStructure(
  rng: Prng,
  itemCount: number,
  totalWords: number,
): Item[] {
  const items: Item[] = [];
  const docCount = Math.max(1, Math.floor(itemCount * 0.05));
  const remaining = itemCount - docCount;

  // Split `remaining` into part/chapter/scene tiers that always sum to
  // `remaining` exactly, so items.length === itemCount for any itemCount.
  // For all presets (remaining >= 3) the tiers match the plain 0.8/0.17 split;
  // the reclaim branch only engages for tiny corpora where floors starve parts.
  let sceneCount: number;
  let chapterCount: number;
  let partCount: number;
  if (remaining >= 3) {
    sceneCount = Math.max(1, Math.floor(remaining * 0.8));
    chapterCount = Math.max(1, Math.floor(remaining * 0.17));
    partCount = remaining - sceneCount - chapterCount;
    if (partCount < 1) {
      let overflow = 1 - partCount;
      partCount = 1;
      const fromScene = Math.min(overflow, sceneCount - 1);
      sceneCount -= fromScene;
      overflow -= fromScene;
      chapterCount -= overflow;
    }
  } else {
    partCount = 0;
    chapterCount = 0;
    sceneCount = remaining;
  }

  let idx = 0;
  const mkTitle = () =>
    `${rng.pick(TITLE_WORDS)} ${rng.pick(TITLE_WORDS)} ${rng.int(999)}`;

  const parts: Item[] = [];
  for (let i = 0; i < partCount; i++) {
    const it: Item = {
      id: `it-${pad(idx++)}`, type: "part", title: mkTitle(),
      parentId: null, order: i,
    };
    parts.push(it); items.push(it);
  }
  const chapters: Item[] = [];
  for (let i = 0; i < chapterCount; i++) {
    const it: Item = {
      id: `it-${pad(idx++)}`, type: "chapter", title: mkTitle(),
      parentId: parts.length ? rng.pick(parts).id : null, order: i,
    };
    chapters.push(it); items.push(it);
  }

  // Scene word targets: random weights normalized to totalWords exactly.
  const weights: number[] = [];
  for (let i = 0; i < sceneCount; i++) weights.push(1 + rng.next());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let assigned = 0;
  for (let i = 0; i < sceneCount; i++) {
    const target = i === sceneCount - 1
      ? totalWords - assigned
      : Math.floor((weights[i]! / weightSum) * totalWords);
    assigned += target;
    items.push({
      id: `it-${pad(idx++)}`, type: "scene", title: mkTitle(),
      parentId: chapters.length ? rng.pick(chapters).id : null,
      order: i, sceneWordTarget: target,
    });
  }
  for (let i = 0; i < docCount; i++) {
    items.push({
      id: `it-${pad(idx++)}`, type: "doc", title: mkTitle(),
      parentId: null, order: i,
    });
  }
  return items;
}
