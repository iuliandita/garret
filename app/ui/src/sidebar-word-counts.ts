export interface SidebarWordCounts {
  scene: boolean;
  chapter: boolean;
  part: boolean;
}

export const DEFAULT_SIDEBAR_WORD_COUNTS: Readonly<SidebarWordCounts> = {
  scene: true, chapter: false, part: false,
};

export function sidebarWordCountsFrom(value: unknown): SidebarWordCounts {
  const fields = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    scene: typeof fields.scene === "boolean" ? fields.scene : true,
    chapter: typeof fields.chapter === "boolean" ? fields.chapter : false,
    part: typeof fields.part === "boolean" ? fields.part : false,
  };
}
