import type { ProjectItem } from "./store/source";

export function storyIds(items: readonly ProjectItem[]): Set<string> {
  const ids = new Set<string>();
  let depth: number | undefined;
  for (const item of items) {
    if (depth !== undefined && item.depth <= depth) depth = undefined;
    if (depth === undefined && item.type === "chapter") {
      depth = item.depth;
      ids.add(item.id);
    }
  }
  return ids;
}
