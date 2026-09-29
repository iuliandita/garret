import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import {
  MARGIN_AXES,
  designName,
  marginOf,
  micrometresFromMillimetres,
  millimetres,
  pageReadout,
  withMargin,
  type BookDesign,
  type BookDesignView,
  type MarginAxis,
} from "./book-design";

export interface ProofPageSetupDeps {
  readDesign(): Promise<BookDesignView>;
  writeDesign(design: BookDesign): Promise<BookDesign>;
  refresh(): Promise<void>;
  onNotice(message: string): void;
}

export interface ProofPageSetup {
  show(): Promise<void>;
  hide(): void;
  destroy(): void;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createProofPageSetup(container: HTMLElement, deps: ProofPageSetupDeps, before?: Node): ProofPageSetup {
  const group = document.createElement("div");
  group.id = "proof-page-setup";
  group.hidden = true;
  const select = document.createElement("select");
  select.id = "proof-page-select";
  select.setAttribute("aria-label", t("proof.setup.page"));
  const margins = document.createElement("details");
  margins.id = "proof-page-margins";
  const summary = document.createElement("summary");
  summary.textContent = t("proof.setup.margins");
  margins.append(summary);
  const fields = new Map<MarginAxis, HTMLInputElement>();
  for (const axis of MARGIN_AXES) {
    const label = document.createElement("label");
    label.textContent = `${t(`design.margin.${axis}`)} `;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.setAttribute("aria-label", t("design.margin.label", { axis: t(`design.margin.${axis}`) }));
    label.append(input, document.createTextNode(` ${t("design.margin.unit")}`));
    margins.append(label);
    fields.set(axis, input);
  }
  group.append(select, margins);
  container.insertBefore(group, before ?? null);

  let destroyed = false;
  let generation = 0;
  let saving = false;
  let pendingSave: Promise<void> = Promise.resolve();
  let current: BookDesign | null = null;
  let view: BookDesignView | null = null;
  const disable = (value: boolean): void => {
    select.disabled = value;
    for (const input of fields.values()) input.disabled = value;
  };
  const clear = (): void => {
    saving = false;
    current = null;
    view = null;
    select.replaceChildren();
    for (const input of fields.values()) input.value = "";
    disable(true);
  };
  const paint = (force = false): void => {
    if (current === null || view === null) return;
    const match = view.page_sizes.find((p) => p.width_um === current?.page.width_um && p.height_um === current?.page.height_um);
    select.value = match?.name ?? "";
    for (const axis of MARGIN_AXES) {
      const input = fields.get(axis);
      if (input && (force || document.activeElement !== input)) input.value = millimetres(marginOf(current.margins, axis));
    }
  };
  const save = async (change: (design: BookDesign) => BookDesign): Promise<void> => {
    if (destroyed || group.hidden || saving || current === null || view === null) return;
    saving = true; disable(true);
    const mine = generation;
    try {
      const latest = await deps.readDesign();
      if (destroyed || mine !== generation) return;
      const landed = await deps.writeDesign(change(latest.design));
      if (destroyed || mine !== generation) return;
      current = landed;
      paint(true);
      await deps.refresh();
    } catch (error) {
      if (!destroyed && mine === generation) {
        paint(true);
        deps.onNotice(t("proof.setup.error", { error: messageOf(error) }));
      }
    } finally {
      if (!destroyed && mine === generation) { saving = false; disable(false); }
    }
  };
  select.addEventListener("change", () => {
    if (destroyed || group.hidden || saving) return;
    const size = view?.page_sizes.find((p) => p.name === select.value);
    if (size && current) pendingSave = save((design) => ({ ...design, page: { width_um: size.width_um, height_um: size.height_um, name: size.name } }));
  });
  for (const [axis, input] of fields) input.addEventListener("change", () => {
    if (destroyed || group.hidden || saving || current === null || view === null) return;
    const typed = input.value;
    const um = micrometresFromMillimetres(typed);
    if (um === null) { paint(true); deps.onNotice(t("design.error.margin", { typed })); return; }
    if (um !== marginOf(current.margins, axis)) pendingSave = save((design) => ({ ...design, margins: withMargin(design.margins, axis, um) }));
  });
  for (const input of fields.values()) input.addEventListener("keydown", (event) => {
    if (isCompositionKey(event)) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    input.dispatchEvent(new Event("change"));
  });
  return {
    async show(): Promise<void> {
      generation += 1; const mine = generation; clear(); group.hidden = false;
      try {
        // Closing cannot cancel a host write. Read the reopened controls only
        // after it lands, otherwise an earlier margin can reappear as current.
        await pendingSave;
        if (destroyed || mine !== generation) return;
        const answer = await deps.readDesign();
        if (destroyed || mine !== generation) return;
        view = answer; current = answer.design;
        select.replaceChildren();
        if (!answer.page_sizes.some((size) => size.width_um === answer.design.page.width_um && size.height_um === answer.design.page.height_um)) {
          const custom = document.createElement("option");
          custom.value = "";
          custom.textContent = t("design.page.custom", { size: pageReadout(answer.design.page) });
          custom.disabled = true;
          select.append(custom);
        }
        for (const size of answer.page_sizes) { const option = document.createElement("option"); option.value = size.name; option.textContent = designName("page", size.name); select.append(option); }
        paint(true);
        disable(false);
      } catch (error) { if (!destroyed && mine === generation) { clear(); deps.onNotice(t("proof.setup.error", { error: messageOf(error) })); } }
    },
    hide(): void { generation += 1; clear(); group.hidden = true; },
    destroy(): void { destroyed = true; generation += 1; clear(); group.remove(); },
  };
}
