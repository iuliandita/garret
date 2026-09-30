import { BIBLE_FOLDER_TYPE } from "./item-types";
import { isOpenableType } from "./open";
import type { ProjectItem } from "./store/source";

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
