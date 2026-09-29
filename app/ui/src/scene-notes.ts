// A fixed, scene-level route back to the existing comments list. It holds no
// rows of its own: the comments read that updates the editor is its only feed.
import type { CommentRow } from "./comments";
import { createIcon } from "./icons";
import { formatNumber, plural } from "./i18n";

export interface SceneNotes {
  setRows(rows: readonly CommentRow[]): void;
  clear(): void;
  destroy(): void;
}

export function createSceneNotes(container: HTMLElement, openComments: () => void): SceneNotes {
  let destroyed = false;
  const button = document.createElement("button");
  button.id = "scene-notes";
  button.type = "button";
  button.hidden = true;
  button.append(createIcon("message-square"));
  const count = document.createElement("span");
  count.id = "scene-notes-count";
  button.append(count);
  const onClick = (): void => openComments();
  button.addEventListener("click", onClick);
  container.append(button);

  function setRows(rows: readonly CommentRow[]): void {
    if (destroyed) return;
    const open = rows.filter((row) => !row.resolved).length;
    button.hidden = open === 0;
    count.textContent = formatNumber(open);
    button.setAttribute(
      "aria-label",
      plural("scene-notes.label", open, { count: formatNumber(open) }),
    );
  }

  return {
    setRows,
    clear(): void {
      button.hidden = true;
      count.textContent = "";
    },
    destroy(): void {
      destroyed = true;
      button.removeEventListener("click", onClick);
      button.remove();
    },
  };
}
