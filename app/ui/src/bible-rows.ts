import { BIBLE_FOLDER_TYPE, BIBLE_TYPE } from "./item-types";
import { isOpenableType } from "./open";
import type { ProjectItem } from "./store/source";

export const DEFAULT_BIBLE_ROWS = 5;
export const MIN_BIBLE_ROWS = 1;
export const MAX_BIBLE_ROWS = 20;

export function bibleRowsFrom(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_BIBLE_ROWS && value <= MAX_BIBLE_ROWS
    ? value
    : DEFAULT_BIBLE_ROWS;
}

export interface BibleEntry {
  item: ProjectItem;
  level: number;
  folder: boolean;
}

/** The first root-level bible's visible items, in canonical walk order. */
export function bibleEntriesIn(items: readonly ProjectItem[]): BibleEntry[] {
  const root = items.find((item) => item.type === BIBLE_TYPE && item.parent_id === null);
  if (root === undefined) return [];
  const entries: BibleEntry[] = [];
  for (const item of items.slice(items.indexOf(root) + 1)) {
    if (item.depth <= root.depth) break;
    if (item.type === BIBLE_FOLDER_TYPE || isOpenableType(item.type)) {
      entries.push({ item, level: Math.max(0, item.depth - root.depth - 1), folder: item.type === BIBLE_FOLDER_TYPE });
    }
  }
  return entries;
}

/** New bible rows follow the selected folder or selected document's parent.
 *  A selection outside the first bible subtree falls back to its root. */
export function bibleParentFor(items: readonly ProjectItem[], selectedId: string | null, rootId: string): string {
  if (selectedId === null || selectedId === rootId) return rootId;
  const byId = new Map(items.map((item) => [item.id, item]));
  const selected = byId.get(selectedId);
  if (selected === undefined) return rootId;
  let cursor: ProjectItem | undefined = selected;
  let inside = false;
  for (let step = 0; step <= items.length && cursor !== undefined; step++) {
    if (cursor.id === rootId) { inside = true; break; }
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
  }
  if (!inside) return rootId;
  if (selected.type === BIBLE_FOLDER_TYPE) return selected.id;
  return isOpenableType(selected.type) ? selected.parent_id ?? rootId : rootId;
}

/** Filter descendants of collapsed folders without changing canonical order. */
export function visibleBibleEntries(entries: readonly BibleEntry[], collapsed: ReadonlySet<string>): BibleEntry[] {
  const visible: BibleEntry[] = [];
  let hiddenBelow: number | null = null;
  for (const entry of entries) {
    if (hiddenBelow !== null && entry.level > hiddenBelow) continue;
    hiddenBelow = null;
    visible.push(entry);
    if (entry.folder && collapsed.has(entry.item.id)) hiddenBelow = entry.level;
  }
  return visible;
}
