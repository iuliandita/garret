import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { REVISION_STATES, STATE_LABELS, NO_STATE_LABEL } from "./revision-states";
import { EXPORT_FORMATS, exportFormatName, type ExportFormat } from "./export-formats";

export interface StoryFields {
  id: string;
  title: string;
  author: string | null;
  state: string | null;
  rev: number;
}

export function createStoryPanel(deps: {
  read(id: string): Promise<StoryFields>;
  save(story: StoryFields): Promise<void>;
  export(id: string, format: ExportFormat): void;
  notice(message: string): void;
  returnFocus(id: string): void;
}): { open(id: string): Promise<void>; destroy(): void } {
  const panel = document.createElement("div");
  panel.id = "story-panel";
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("collection.fields"));
  let story: StoryFields | null = null;
  let originId: string | null = null;
  let busy = false;
  let epoch = 0;
  let destroyed = false;
  const close = (): void => {
    if (busy) return;
    epoch++;
    panel.hidden = true;
    story = null;
  };
  const shell = createPanelShell({ panel, title: t("collection.fields"), footer: true,
    close, returnFocus: () => { if (!busy && originId !== null) deps.returnFocus(originId); }, outsideClick: false });
  document.body.append(panel);
  const title = document.createElement("input");
  const author = document.createElement("input");
  const status = document.createElement("select");
  title.maxLength = author.maxLength = 1000;
  for (const [id, key, input] of [
    ["story-title", "collection.title", title],
    ["story-author", "collection.author", author],
    ["story-status", "collection.status", status],
  ] as const) {
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = t(key);
    input.id = id;
    shell.body.append(label, input);
  }
  for (const value of [null, ...REVISION_STATES]) {
    const option = document.createElement("option");
    option.value = value ?? "";
    option.textContent = value === null ? NO_STATE_LABEL : STATE_LABELS[value];
    status.append(option);
  }
  const hint = document.createElement("p");
  hint.id = "story-inheritance";
  hint.textContent = t("collection.inheritance");
  panel.setAttribute("aria-describedby", hint.id);
  author.setAttribute("aria-describedby", hint.id);
  const error = document.createElement("p");
  error.id = "story-title-error";
  error.setAttribute("role", "status");
  error.setAttribute("aria-live", "polite");
  title.setAttribute("aria-describedby", error.id);
  title.addEventListener("input", () => {
    title.removeAttribute("aria-invalid");
    error.textContent = "";
  });
  shell.body.insertBefore(error, author.previousSibling);
  shell.body.append(hint);
  const button = (id: string, text: string, run: () => void): HTMLButtonElement => {
    const control = document.createElement("button");
    control.type = "button";
    control.id = id;
    control.textContent = text;
    control.addEventListener("click", run);
    return control;
  };
  const save = async (format?: ExportFormat): Promise<void> => {
    if (busy || story === null || destroyed) return;
    const captured = story;
    if (!title.value.trim()) {
      title.setAttribute("aria-invalid", "true");
      error.textContent = t("collection.title-required");
      title.focus();
      return;
    }
    busy = true;
    const controls = panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button");
    controls.forEach((control) => { control.disabled = true; });
    try {
      await deps.save({ ...captured, title: title.value, author: author.value, state: status.value || null });
      if (destroyed) return;
      busy = false;
      close();
      deps.returnFocus(captured.id);
      if (format !== undefined) deps.export(captured.id, format);
    } catch (error) {
      if (!destroyed) deps.notice(t("collection.error", { error: String(error) }));
    } finally {
      busy = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  };
  const saveButton = button("story-save", t("collection.save"), () => { void save(); });
  saveButton.dataset.weight = "primary";
  shell.footer?.append(saveButton);
  const exports = document.createElement("div");
  exports.className = "story-exports";
  const exportLabel = document.createElement("h3");
  exportLabel.id = "story-export-label";
  exportLabel.textContent = t("collection.export");
  exports.setAttribute("role", "group");
  exports.setAttribute("aria-labelledby", exportLabel.id);
  shell.body.append(exportLabel, exports);
  for (const format of EXPORT_FORMATS) {
    exports.append(button(`story-export-${format}`, exportFormatName(format), () => { void save(format); }));
  }
  return {
    async open(id): Promise<void> {
      if (busy || destroyed) return;
      const request = ++epoch;
      try {
        const read = await deps.read(id);
        if (destroyed || request !== epoch) return;
        story = read;
        originId = read.id;
        title.value = read.title;
        title.removeAttribute("aria-invalid");
        error.textContent = "";
        author.value = read.author ?? "";
        status.value = read.state ?? "";
        panel.hidden = false;
        title.focus();
      } catch (error) {
        if (!destroyed && request === epoch) deps.notice(t("collection.error", { error: String(error) }));
      }
    },
    destroy(): void { destroyed = true; epoch++; shell.destroy(); panel.remove(); },
  };
}
