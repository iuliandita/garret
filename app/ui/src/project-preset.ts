import { CATALOGS, t } from "./i18n";

export type ProjectPreset = "novel" | "short" | "nonfiction" | "collection";

export function projectPreset(value: unknown): ProjectPreset {
  return value === "short" || value === "nonfiction" || value === "collection" ? value : "novel";
}

export function referenceTitle(preset: ProjectPreset, storedTitle?: string): string {
  if (storedTitle !== undefined && (preset !== "nonfiction" || !Object.values(CATALOGS).some((catalog) => catalog["outline.bible-title"] === storedTitle))) return storedTitle;
  return t(preset === "nonfiction" ? "preset.reference-notes" : "outline.bible-title");
}

export function addReferenceLabel(name: string): string {
  return name === t("preset.reference-notes") ? t("preset.add-reference") : t("preset.add-reference-to", { name });
}

export const PROJECT_PRESETS = ["novel", "short", "nonfiction", "collection"] as const;

/** The project type as pills, the pen-name strip's own control: one pressed
 *  at a time, Novel first. */
export function createPresetChoice(id: string): { field: HTMLElement; value: () => ProjectPreset } {
  const field = document.createElement("div");
  field.className = "field-with-label";
  const label = document.createElement("span");
  label.id = `${id}-label`;
  label.className = "field-label";
  label.textContent = t("preset.label");
  const group = document.createElement("div");
  group.id = id;
  group.className = "pill-row";
  group.setAttribute("role", "group");
  group.setAttribute("aria-labelledby", label.id);
  let selected: ProjectPreset = "novel";
  for (const preset of PROJECT_PRESETS) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.dataset.preset = preset;
    pill.textContent = t(`preset.${preset}`);
    pill.setAttribute("aria-pressed", String(preset === selected));
    pill.addEventListener("click", () => {
      selected = preset;
      for (const other of group.querySelectorAll<HTMLButtonElement>("button")) {
        other.setAttribute("aria-pressed", String(other === pill));
      }
    });
    group.append(pill);
  }
  field.append(label, group);
  return { field, value: () => selected };
}
