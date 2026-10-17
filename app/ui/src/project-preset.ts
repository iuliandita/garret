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

export function createPresetChoice(id: string): { field: HTMLElement; select: HTMLSelectElement } {
  const field = document.createElement("div");
  field.className = "field-with-label";
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = t("preset.label");
  const select = document.createElement("select");
  select.id = id;
  for (const preset of ["novel", "short", "nonfiction", "collection"] as const) {
    const option = document.createElement("option");
    option.value = preset;
    option.textContent = t(`preset.${preset}`);
    select.append(option);
  }
  field.append(label, select);
  return { field, select };
}
