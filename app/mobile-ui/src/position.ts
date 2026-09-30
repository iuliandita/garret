export interface WritingPosition {
  sceneId: string;
  from: number;
  to: number;
  scrollTop: number;
}

const keyFor = (bookId: string) => `garret.mobile.position.v1.${bookId}`;

export function readWritingPosition(storage: Pick<Storage, "getItem">, bookId: string): WritingPosition | undefined {
  const value = storage.getItem(keyFor(bookId));
  if (!value) return;
  try {
    const position: unknown = JSON.parse(value);
    if (!position || typeof position !== "object") return;
    const p = position as Partial<WritingPosition>;
    if (typeof p.sceneId !== "string" || !p.sceneId
      || typeof p.from !== "number" || !Number.isSafeInteger(p.from) || p.from < 0
      || typeof p.to !== "number" || !Number.isSafeInteger(p.to) || p.to < 0 || p.from > p.to
      || typeof p.scrollTop !== "number" || !Number.isFinite(p.scrollTop) || p.scrollTop < 0) return;
    return { sceneId: p.sceneId, from: p.from, to: p.to, scrollTop: p.scrollTop };
  } catch { return; }
}

export function writeWritingPosition(storage: Pick<Storage, "setItem">, bookId: string, position: WritingPosition): void {
  storage.setItem(keyFor(bookId), JSON.stringify(position));
}

export function openingScene<T extends { id: string }>(scenes: readonly T[], position?: WritingPosition): T | undefined {
  return scenes.find(scene => scene.id === position?.sceneId) ?? scenes[0];
}
