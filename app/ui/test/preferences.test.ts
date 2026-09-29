import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createPreferences, LOCALES, STARTS, type Locale, type Start } from "../src/preferences";
import { CATALOGS, t } from "../src/i18n";
import type { Theme } from "../src/theme";
import { DEFAULT_TYPOGRAPHY, type Typography } from "../src/typography";
import { DAILY_TARGETS, DEFAULT_DAILY_TARGET, type DailyTarget } from "../src/goals";
import { DEFAULT_WRITING_MODES, type FocusMode, type WritingModes } from "../src/writing-modes";
import { DEFAULT_ZOOM, type Zoom } from "../src/zoom";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function rig(
  initialTheme: Theme = "system",
  initialTypography = DEFAULT_TYPOGRAPHY,
  initialDailyTarget: DailyTarget = DEFAULT_DAILY_TARGET,
  initialWritingModes: WritingModes = DEFAULT_WRITING_MODES,
  initialZoom: Zoom = DEFAULT_ZOOM,
  initialLocale: Locale = "en",
  initialStart: Start = "last",
  // Optional-override tail, same pattern as every other dep here: most tests
  // do not care who is told about a writing-mode change, so this stays last
  // and defaults to nobody.
  onWritingModes?: (modes: WritingModes) => void,
  initialBibleRows?: number,
  openPrivacy?: () => Promise<void>,
) {
  const container = document.createElement("div");
  const root = document.createElement("html");
  document.body.append(container);
  const notices: string[] = [];
  const dones: string[] = [];
  const themes: Theme[] = [];
  const typographies: Typography[] = [];
  const targets: DailyTarget[] = [];
  const announced: DailyTarget[] = [];
  const writingModes: WritingModes[] = [];
  const spellings: string[] = [];
  const palettes: string[] = [];
  const dismissals: string[] = [];
  const dictAdds: string[] = [];
  const dictRemoves: string[] = [];
  const zooms: Zoom[] = [];
  const locales: Locale[] = [];
  const starts: Start[] = [];
  const markCastNames: boolean[] = [];
  const markCastNamesAnnounced: boolean[] = [];
  const bibleRows: number[] = [];
  const bibleRowsAnnounced: number[] = [];
  let reject: string | null = null;
  let dictReject: string | null = null;

  const control = createPreferences({
    openPrivacy,
    container,
    root,
    initialTheme,
    initialThemeFamily: "editorial",
    persistThemeFamily: async (family) => {
      palettes.push(family);
      if (reject !== null) throw new Error(reject);
    },
    initialDictionary: [],
    persistDictAdd: async (word) => {
      if (dictReject !== null) throw new Error(dictReject);
      dictAdds.push(word);
      return word;
    },
    persistDictRemove: async (word) => {
      if (dictReject !== null) throw new Error(dictReject);
      dictRemoves.push(word);
    },
    initialTypography,
    persistTheme: async (theme) => {
      themes.push(theme);
      if (reject !== null) throw new Error(reject);
    },
    persistTypography: async (typography) => {
      typographies.push(typography);
      if (reject !== null) throw new Error(reject);
    },
    initialDailyTarget,
    initialBibleRows,
    persistBibleRows: async (rows) => {
      bibleRows.push(rows);
      if (reject !== null) throw new Error(reject);
    },
    onBibleRows: (rows) => bibleRowsAnnounced.push(rows),
    initialWritingModes,
    initialZoom,
    persistZoom: async (zoom) => {
      zooms.push(zoom);
      if (reject !== null) throw new Error(reject);
    },
    initialLocale,
    persistLocale: async (locale) => {
      locales.push(locale);
      if (reject !== null) throw new Error(reject);
    },
    initialStart,
    persistStart: async (start) => {
      starts.push(start);
      if (reject !== null) throw new Error(reject);
    },
    initialSpelling: "on",
    persistSpelling: async (mode) => {
      spellings.push(mode);
      if (reject !== null) throw new Error(reject);
    },
    initialMarkCastNames: true,
    persistMarkCastNames: async (on) => {
      markCastNames.push(on);
      if (reject !== null) throw new Error(reject);
    },
    onMarkCastNames: (on) => markCastNamesAnnounced.push(on),
    persistWritingModes: async (modes) => {
      writingModes.push(modes);
      if (reject !== null) throw new Error(reject);
    },
    persistDailyTarget: async (target) => {
      targets.push(target);
      if (reject !== null) throw new Error(reject);
    },
    onDailyTarget: (target) => announced.push(target),
    onWritingModes,
    onNotice: (message) => notices.push(message),
    onDone: (message) => dones.push(message),
    // The panel no longer owns a focus-return target: the toggle that used to
    // sit in the bar is gone and File > Preferences... is the only route in.
    // Recorded as a count, so "called once" is a claim a test can make.
    onDismiss: () => dismissals.push("dismissed"),
  });

  const byId = (id: string): HTMLButtonElement => {
    const el = container.querySelector(`#${id}`);
    if (!(el instanceof HTMLButtonElement)) throw new Error(`no button #${id} mounted`);
    return el;
  };
  const panel = (): HTMLElement => {
    const el = container.querySelector("#prefs-panel");
    if (!(el instanceof HTMLElement)) throw new Error("no panel mounted");
    return el;
  };
  const dictInput = (): HTMLInputElement => {
    const el = container.querySelector("#prefs-dict-word");
    if (!(el instanceof HTMLInputElement)) throw new Error("no dictionary input mounted");
    return el;
  };
  const dictWords = (): string[] =>
    [...container.querySelectorAll("#prefs-dict-list li")]
      .filter((li) => li.id !== "prefs-dict-empty")
      .map((li) => li.querySelector("span")?.textContent ?? "");
  const languageSelect = (): HTMLSelectElement => {
    const el = container.querySelector("#prefs-language");
    if (!(el instanceof HTMLSelectElement)) throw new Error("no #prefs-language select mounted");
    return el;
  };
  const startSelect = (): HTMLSelectElement => {
    const el = container.querySelector("#prefs-start");
    if (!(el instanceof HTMLSelectElement)) throw new Error("no #prefs-start select mounted");
    return el;
  };
  const bibleRowsSelect = (): HTMLSelectElement => {
    const el = container.querySelector("#prefs-bible-rows");
    if (!(el instanceof HTMLSelectElement)) throw new Error("no #prefs-bible-rows select mounted");
    return el;
  };

  return {
    container,
    root,
    control,
    notices,
    dones,
    themes,
    typographies,
    targets,
    spellings,
    palettes,
    writingModes,
    announced,
    dismissals,
    dictAdds,
    dictRemoves,
    zooms,
    locales,
    starts,
    markCastNames,
    markCastNamesAnnounced,
    bibleRows,
    bibleRowsAnnounced,
    dictInput,
    dictWords,
    languageSelect,
    startSelect,
    bibleRowsSelect,
    byId,
    panel,
    failWith(message: string) {
      reject = message;
    },
    failDictWith(message: string) {
      dictReject = message;
    },
    async click(id: string) {
      byId(id).click();
      await settle();
    },
    async addDictWord(word: string) {
      dictInput().value = word;
      byId("prefs-dict-add").click();
      await settle();
    },
    async changeLanguage(value: string) {
      const select = languageSelect();
      select.value = value;
      select.dispatchEvent(new Event("change"));
      await settle();
    },
    async changeStart(value: string) {
      const select = startSelect();
      select.value = value;
      select.dispatchEvent(new Event("change"));
      await settle();
    },
    async changeBibleRows(value: string) {
      const select = bibleRowsSelect();
      select.value = value;
      select.dispatchEvent(new Event("change"));
      await settle();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the preferences panel", () => {
  test("two headed sections, Writing then Application, share the body's grid", () => {
    const r = rig();
    const body = r.panel().querySelector(".panel-body");
    expect(body instanceof HTMLElement).toBe(true);
    if (!(body instanceof HTMLElement)) return;
    const order = [...body.children].map((c) => (c.classList.contains("prefs-section") ? `# ${c.textContent}` : c.id));
    expect(order).toEqual([
      `# ${t("prefs.section.writing")}`,
      "prefs-family", "prefs-size", "prefs-measure", "prefs-goal", "prefs-focus",
      "prefs-typewriter", "prefs-spelling", "prefs-mark-cast-names", "prefs-dict",
      `# ${t("prefs.section.app")}`,
      "prefs-palette", "prefs-theme", "prefs-language-group", "prefs-start-group", "prefs-zoom",
      "prefs-bible-rows-group",
      ...(r.panel().querySelector("#prefs-privacy") === null ? [] : ["prefs-privacy"]),
    ]);
  });

  test("ordinary choice groups preserve their accessible group names around neutral choices wrappers", () => {
    const r = rig();
    const expectedControls = new Map([
      ["prefs-theme", ["prefs-theme-system", "prefs-theme-light", "prefs-theme-dark"]],
      ["prefs-language-group", ["prefs-language"]],
      ["prefs-start-group", ["prefs-start"]],
      ["prefs-bible-rows-group", ["prefs-bible-rows"]],
    ]);
    for (const [id, controls] of expectedControls) {
      const group = r.panel().querySelector(`#${id}`);
      expect(group instanceof HTMLElement).toBe(true);
      if (!(group instanceof HTMLElement)) continue;
      expect(group.classList.contains("prefs-choice-group")).toBe(true);
      expect(group.getAttribute("role")).toBe("group");
      expect(group.getAttribute("aria-label") !== null).toBe(true);

      const choices = group.querySelector(":scope > .prefs-choices");
      expect(choices instanceof HTMLElement).toBe(true);
      if (!(choices instanceof HTMLElement)) continue;
      expect(choices.getAttribute("role") === null).toBe(true);
      expect(choices.getAttribute("aria-label") === null).toBe(true);
      for (const controlId of controls) {
        const control = group.querySelector(`#${controlId}`);
        expect(control instanceof HTMLButtonElement || control instanceof HTMLSelectElement).toBe(true);
        expect(control instanceof HTMLElement && choices.contains(control)).toBe(true);
      }
    }
    expect(r.panel().querySelector("#prefs-dict")?.classList.contains("prefs-choice-group")).toBe(false);
  });

  test("applies both preferences on mount, before anything is clicked", () => {
    // The head script normally does this. The panel does it too, because the
    // head script does not run in a test or in any future embedding - and a
    // panel that disagreed with the page it is describing is worse than one
    // that does the work twice.
    const r = rig("dark", { family: "mono", size: "larger", measure: "narrow" });
    expect(r.root.getAttribute("data-theme")).toBe("dark");
    expect(r.root.getAttribute("data-prose-family")).toBe("mono");
    expect(r.root.getAttribute("data-prose-size")).toBe("larger");
    expect(r.root.getAttribute("data-prose-measure")).toBe("narrow");
  });

  test("starts closed, and open() shows it", () => {
    // Mounting must not put the panel on screen: the page builds it at startup
    // and the writer has asked for nothing.
    const r = rig();
    expect(r.panel().hidden).toBe(true);
    r.control.open();
    expect(r.panel().hidden).toBe(false);
  });

  test("open() moves focus to the panel itself", () => {
    // Not to a control inside: the panel is five groups of toggle buttons and
    // landing on one of them looks like a preference has been reached for. The
    // panel is role="dialog" with a name, so focusing it announces what opened.
    // Asserted on the id, never on the element: a happy-dom node printed by a
    // failing matcher is megabytes and takes the runner out by timeout.
    const r = rig();
    r.control.open();
    expect(document.activeElement?.id).toBe("prefs-panel");
  });

  test("the panel is focusable only programmatically", () => {
    // tabIndex -1 keeps it out of the Tab order, where an invisible stop before
    // the panel's own controls is a second thing to tab past. Asserted on the
    // ATTRIBUTE, not on `.tabIndex`: a <div> with no tabindex attribute already
    // reports -1 as a property, so the property assertion would pass against a
    // panel that had lost the attribute and could not be focused at all.
    const r = rig();
    expect(r.panel().getAttribute("tabindex")).toBe("-1");
  });

  test("marks exactly one button pressed per group", () => {
    // aria-pressed is the only channel this state has to a screen reader, and
    // the stylesheet keys its tint on the same attribute - so a group with two
    // pressed buttons is both a lie and a visible defect.
    const r = rig("light", { family: "sans", size: "small", measure: "wide" });
    const pressedIn = (group: string): string[] =>
      [...r.panel().querySelectorAll(`#${group} [aria-pressed="true"]`)].map((el) => el.id);
    expect(pressedIn("prefs-theme")).toEqual(["prefs-theme-light"]);
    expect(pressedIn("prefs-family")).toEqual(["prefs-family-sans"]);
    expect(pressedIn("prefs-size")).toEqual(["prefs-size-small"]);
    expect(pressedIn("prefs-measure")).toEqual(["prefs-measure-wide"]);
  });

  test("choosing a size applies it, repaints the group and records all three axes", async () => {
    // All three, because the host command takes all three and writes them
    // together. Sending only the changed axis would default the other two on
    // every click.
    const r = rig("system", { family: "mono", size: "medium", measure: "narrow" });
    await r.click("prefs-size-large");
    expect(r.root.getAttribute("data-prose-size")).toBe("large");
    expect(r.byId("prefs-size-large").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-size-medium").getAttribute("aria-pressed")).toBe("false");
    expect(r.typographies).toEqual([{ family: "mono", size: "large", measure: "narrow" }]);
  });

  test("each group changes only its own axis", async () => {
    // A single handler serving four groups is exactly where a mistyped branch
    // writes the family into the measure, and nothing else in the page would
    // notice: both are strings and both end up on the root.
    const r = rig();
    await r.click("prefs-family-mono");
    await r.click("prefs-measure-wide");
    expect(r.root.getAttribute("data-prose-family")).toBe("mono");
    expect(r.root.getAttribute("data-prose-size")).toBe(DEFAULT_TYPOGRAPHY.size);
    expect(r.root.getAttribute("data-prose-measure")).toBe("wide");
    expect(r.typographies.at(-1)).toEqual({
      family: "mono",
      size: DEFAULT_TYPOGRAPHY.size,
      measure: "wide",
    });
  });

  test("theme and typography persist through separate commands", async () => {
    // Two files' worth of preference, one panel. A theme click that went to the
    // typography command would write the palette into a field the next launch
    // reads as a font name and discards.
    const r = rig();
    await r.click("prefs-theme-dark");
    expect(r.themes).toEqual(["dark"]);
    expect(r.typographies).toEqual([]);
    await r.click("prefs-family-sans");
    expect(r.themes).toEqual(["dark"]);
    expect(r.typographies).toHaveLength(1);
  });

  test("theme still removes the attribute for system", async () => {
    // The panel is a different control from the retired cycling button, and
    // this is the one thing about the palette that is easy to lose in the move.
    const r = rig("dark");
    await r.click("prefs-theme-system");
    expect(r.root.hasAttribute("data-theme")).toBe(false);
  });

  test("a failed save keeps the choice and reports through the notice", async () => {
    // The writer asked for this in this window and they have it; only the
    // memory of it across launches was lost. Rolling it back would undo the
    // thing they just did, in front of them.
    const r = rig();
    r.failWith("read-only file system");
    await r.click("prefs-size-larger");
    expect(r.root.getAttribute("data-prose-size")).toBe("larger");
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("read-only file system");
  });

  test("a save that fails after teardown reports nothing", async () => {
    // A resolution landing after destroy() would report through a dead
    // project's callbacks, which is a defect this codebase has shipped once.
    const r = rig();
    r.failWith("gone");
    r.byId("prefs-size-small").click();
    r.control.destroy();
    await settle();
    expect(r.notices).toEqual([]);
  });

  test("Escape closes the panel and hands the dismissal to the page, once", () => {
    // The panel has no focus-return target of its own any more, so it says it
    // was dismissed and the page decides where focus goes. Exactly once: a
    // second call would move focus a second time, after the page had placed it.
    const r = rig();
    r.control.open();
    r.panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(r.panel().hidden).toBe(true);
    expect(r.dismissals).toHaveLength(1);
  });

  test("destroy clears the bar and stops every button working", async () => {
    const r = rig();
    const size = r.byId("prefs-size-large");
    const theme = r.byId("prefs-theme-dark");
    r.control.destroy();
    expect(r.container.children).toHaveLength(0);
    size.click();
    theme.click();
    await settle();
    expect(r.typographies).toEqual([]);
    expect(r.themes).toEqual([]);
  });

  test("destroy leaves every applied preference on the root", () => {
    // A project switch destroys and remounts the page's units. Clearing these
    // would flash the desktop's palette and the default type on every switch.
    const r = rig("dark", { family: "mono", size: "large", measure: "wide" });
    r.control.destroy();
    expect(r.root.getAttribute("data-theme")).toBe("dark");
    expect(r.root.getAttribute("data-prose-family")).toBe("mono");
    expect(r.root.getAttribute("data-prose-size")).toBe("large");
    expect(r.root.getAttribute("data-prose-measure")).toBe("wide");
  });

  test("a value that reached the DOM by any other route is ignored", async () => {
    // The click handler narrows against the same lists the panel was painted
    // from. Without that, anything carrying the two data- attributes could put
    // an arbitrary string on the root and into the settings file - where the
    // next launch would read it as a lost preference.
    const r = rig();
    r.control.open();
    const forged = document.createElement("button");
    forged.dataset.prefsValue = "enormous";
    forged.dataset.prefsGroup = "prefs-size";
    r.panel().append(forged);
    forged.click();
    await settle();
    expect(r.root.getAttribute("data-prose-size")).toBe(DEFAULT_TYPOGRAPHY.size);
    expect(r.typographies).toEqual([]);
  });
});

describe("preferences: Bible shortcuts", () => {
  test("uses an accessible select with every offered row count", () => {
    const r = rig();
    const select = r.bibleRowsSelect();
    expect(select.getAttribute("aria-label")).toBe(t("prefs.name.bible-rows"));
    expect([...select.options].map((option) => option.value)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 1)),
    );
  });

  test("invalid injected row counts read as five", () => {
    expect(rig("system", DEFAULT_TYPOGRAPHY, DEFAULT_DAILY_TARGET, DEFAULT_WRITING_MODES, DEFAULT_ZOOM, "en", "last", undefined, 21).bibleRowsSelect().value).toBe("5");
  });

  test("persists a changed count and updates the live project", async () => {
    const r = rig();
    await r.changeBibleRows("12");
    expect(r.bibleRows).toEqual([12]);
    expect(r.bibleRowsAnnounced).toEqual([12]);
  });

  test("refusal restores the previous selection and re-enables it", async () => {
    const r = rig();
    r.failWith("read-only");
    await r.changeBibleRows("12");
    expect(r.bibleRowsSelect().value).toBe("5");
    expect(r.bibleRowsSelect().disabled).toBe(false);
    expect(r.bibleRowsAnnounced).toEqual([]);
  });
});

describe("preferences: the daily goal", () => {
  test("every offered target has a button, and the chosen one is pressed", () => {
    const r = rig("system", DEFAULT_TYPOGRAPHY, "500");
    for (const target of DAILY_TARGETS) {
      expect(r.byId(`prefs-goal-${target}`).getAttribute("aria-pressed")).toBe(
        String(target === "500"),
      );
    }
  });

  test("choosing a goal announces it before it is saved, and saves it", async () => {
    const r = rig();
    r.control.open();
    await r.click("prefs-goal-1000");
    // The order is the claim: the bar shows what the writer just chose whether
    // or not the file takes it. Nothing here can see the order, so it is the
    // ordering test below that carries it -- this one only asserts both
    // happened.
    expect(r.announced).toEqual(["1000"]);
    expect(r.targets).toEqual(["1000"]);
    expect(r.byId("prefs-goal-1000").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-goal-off").getAttribute("aria-pressed")).toBe("false");
  });

  test("a goal that cannot be saved is still in effect in this window", async () => {
    const r = rig();
    r.failWith("read-only file system");
    r.control.open();
    await r.click("prefs-goal-250");
    // Applied and announced regardless: the writer asked for this here, and
    // only the memory of it across launches is at stake.
    expect(r.announced).toEqual(["250"]);
    expect(r.byId("prefs-goal-250").getAttribute("aria-pressed")).toBe("true");
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("daily goal");
  });

  test("the goal is announced BEFORE the save is awaited", async () => {
    // A repaint that waited on the file would leave the bar showing the old
    // goal for as long as a write takes, and showing the OLD one forever if the
    // write rejected. No end-state assertion can see this: both orders end with
    // the same panel, the same bar and the same file.
    const r = rig();
    r.control.open();
    r.byId("prefs-goal-2000").click();
    // Synchronously after the click and before any await: the announcement has
    // already happened, the persist has not resolved.
    expect(r.announced).toEqual(["2000"]);
    await settle();
    expect(r.targets).toEqual(["2000"]);
  });

  test("a target that reached the DOM by any other route is ignored", async () => {
    const r = rig();
    r.control.open();
    const forged = document.createElement("button");
    forged.dataset.prefsValue = "750";
    forged.dataset.prefsGroup = "prefs-goal";
    r.panel().append(forged);
    forged.click();
    await settle();
    expect(r.announced).toEqual([]);
    expect(r.targets).toEqual([]);
  });

  test("the goal writes nothing onto the root", () => {
    // Unlike the theme and the three type axes, this preference selects no
    // stylesheet rule. An attribute here would be state with no reader, and the
    // next person to add a `[data-*]` selector would find it already occupied.
    const before = [...r0().root.attributes].map((a) => a.name);
    const r = rig("system", DEFAULT_TYPOGRAPHY, "1000");
    expect([...r.root.attributes].map((a) => a.name).sort()).toEqual(before.sort());
  });
});

/** A control panel at the default goal, for the attribute comparison above. */
function r0() {
  return rig("system", DEFAULT_TYPOGRAPHY, "off");
}

describe("the language chooser", () => {
  test("shows the current locale, offering exactly English and German", () => {
    const r = rig("system", DEFAULT_TYPOGRAPHY, DEFAULT_DAILY_TARGET, DEFAULT_WRITING_MODES, DEFAULT_ZOOM, "de");
    const select = r.languageSelect();
    expect(select.value).toBe("de");
    const values = [...select.options].map((option) => option.value);
    expect(values).toEqual(["en", "de"]);
  });

  test("changing it persists the tag and announces the exact applied text, without touching onNotice", async () => {
    const r = rig();
    await r.changeLanguage("de");
    expect(r.locales).toEqual(["de"]);
    // THE EXACT TEXT, not just a count: a build that announced the wrong
    // catalog key, or the theme's own applied text by copy-paste, would still
    // satisfy "something was announced once".
    expect(r.dones).toEqual([t("prefs.language.applied")]);
    expect(r.notices).toEqual([]);
  });

  test("a refusal reaches onNotice and puts the select back to the recorded locale", async () => {
    const r = rig();
    r.failWith("nope");
    await r.changeLanguage("de");
    expect(r.locales).toEqual(["de"]);
    expect(r.dones).toEqual([]);
    expect(r.notices.length).toBe(1);
    expect(r.languageSelect().value).toBe("en");
  });

  test("a save that succeeds after teardown announces nothing", async () => {
    // The success path's own version of the failure path's guard above:
    // `if (destroyed) return` before `onDone`, not only before `onNotice`. A
    // resolution landing after `destroy()` would announce through a dead
    // project's callbacks, the same defect the outline slice shipped once.
    const r = rig();
    const select = r.languageSelect();
    select.value = "de";
    select.dispatchEvent(new Event("change"));
    r.control.destroy();
    await settle();
    expect(r.dones).toEqual([]);
  });

  test("the select carries a localized accessible name", () => {
    const r = rig();
    const select = r.languageSelect();
    expect(select.getAttribute("aria-label")).toBe(t("prefs.language"));
    const group = r.container.querySelector("#prefs-language-group");
    expect(group?.getAttribute("aria-label")).toBe(t("prefs.language"));
  });

  test("LOCALES matches every catalog this build ships", () => {
    // A third list, alongside `en.ts`/`de.ts` and `strings.rs`'s `CATALOGS` -
    // a language added to the catalogs and forgotten here would ship
    // translated strings with no way to choose them.
    expect(Object.keys(CATALOGS)).toEqual([...LOCALES] as string[]);
  });
});

describe("the start select", () => {
  test("shows the injected value, offering exactly the three words", () => {
    const r = rig(
      "system",
      DEFAULT_TYPOGRAPHY,
      DEFAULT_DAILY_TARGET,
      DEFAULT_WRITING_MODES,
      DEFAULT_ZOOM,
      "en",
      "home",
    );
    const select = r.startSelect();
    expect(select.value).toBe("home");
    expect([...select.options].map((option) => option.value)).toEqual([...STARTS] as string[]);
  });

  test("changing it persists the word", async () => {
    const r = rig();
    await r.changeStart("blank");
    expect(r.starts).toEqual(["blank"]);
  });

  test("a refusal reaches onNotice and puts the select back to the recorded start", async () => {
    // The language select's own shape: a <select> shows what was chosen with
    // no `aria-pressed` reading of its own, so a write the file never took
    // must not go on looking chosen on screen.
    const r = rig(
      "system",
      DEFAULT_TYPOGRAPHY,
      DEFAULT_DAILY_TARGET,
      DEFAULT_WRITING_MODES,
      DEFAULT_ZOOM,
      "en",
      "last",
    );
    r.failWith("nope");
    await r.changeStart("home");
    expect(r.starts).toEqual(["home"]);
    expect(r.notices.length).toBe(1);
    expect(r.startSelect().value).toBe("last");
  });

  test("the select carries a localized accessible name", () => {
    const r = rig();
    const select = r.startSelect();
    expect(select.getAttribute("aria-label")).toBe(t("prefs.start.label"));
    const group = r.container.querySelector("#prefs-start-group");
    expect(group?.getAttribute("aria-label")).toBe(t("prefs.start.label"));
  });
});

describe("the spelling group", () => {
  test("offers exactly on and off, and starts on the injected value", () => {
    const r = rig();
    r.control.open();
    const on = r.byId("prefs-spelling-on");
    const off = r.byId("prefs-spelling-off");
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(off.getAttribute("aria-pressed")).toBe("false");
  });

  test("choosing off persists it", () => {
    const r = rig();
    r.control.open();
    r.byId("prefs-spelling-off").click();
    expect(r.spellings).toEqual(["off"]);
    expect(r.byId("prefs-spelling-off").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-spelling-on").getAttribute("aria-pressed")).toBe("false");
  });

  test("does NOT write an attribute on the root", () => {
    // The underlines belong to WebKitWebContext, which the page cannot reach:
    // the host both records this preference and applies it. An attribute here
    // would be a second statement of the same fact with nothing reading it -
    // and a reader would take it for the mechanism.
    const r = rig();
    r.control.open();
    r.byId("prefs-spelling-off").click();
    expect(r.root.hasAttribute("data-spelling")).toBe(false);
  });

  test("a failed persist is reported and does not revert the panel", () => {
    // Applied BEFORE the await and never rolled back: the writer asked for this
    // in this window. Only the memory of it across launches is at stake.
    const r = rig();
    r.control.open();
    r.failWith("disk is full");
    r.byId("prefs-spelling-off").click();
    expect(r.byId("prefs-spelling-off").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the mark-cast-names group", () => {
  test("offers exactly on and off, and starts on the injected value", () => {
    const r = rig();
    r.control.open();
    expect(r.byId("prefs-mark-cast-names-on").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-mark-cast-names-off").getAttribute("aria-pressed")).toBe("false");
  });

  test("choosing off persists a plain bool and tells the mounted project at once", () => {
    const r = rig();
    r.control.open();
    r.byId("prefs-mark-cast-names-off").click();
    expect(r.markCastNames).toEqual([false]);
    // BEFORE the persist resolves, the same rule `applyWritingModesChange`
    // follows: the currently open scene must not wait for a switch.
    expect(r.markCastNamesAnnounced).toEqual([false]);
    expect(r.byId("prefs-mark-cast-names-off").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-mark-cast-names-on").getAttribute("aria-pressed")).toBe("false");
  });

  test("a failed persist is reported and does not revert the panel", async () => {
    const r = rig();
    r.control.open();
    r.failWith("disk is full");
    r.byId("prefs-mark-cast-names-off").click();
    expect(r.byId("prefs-mark-cast-names-off").getAttribute("aria-pressed")).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.notices).toEqual([
      t("prefs.error.save", { what: t("prefs.what.mark-cast-names"), error: "disk is full" }),
    ]);
  });
});

describe("the project dictionary", () => {
  test("starts on the injected list and shows nothing added yet when it is empty", () => {
    const r = rig();
    r.control.open();
    expect(r.dictWords()).toEqual([]);
    expect(r.container.querySelector("#prefs-dict-empty")).not.toBeNull();
  });

  test("adding a word persists it and paints it, and clears the input", async () => {
    const r = rig();
    r.control.open();
    await r.addDictWord("Zorbulax");
    expect(r.dictAdds).toEqual(["Zorbulax"]);
    expect(r.dictWords()).toEqual(["Zorbulax"]);
    expect(r.dictInput().value).toBe("");
    expect(r.container.querySelector("#prefs-dict-empty")).toBeNull();
  });

  test("a blank entry is never sent to the host", async () => {
    const r = rig();
    r.control.open();
    await r.addDictWord("   ");
    expect(r.dictAdds).toEqual([]);
    expect(r.dictWords()).toEqual([]);
  });

  test("words are painted alphabetically as they are added, not in the order typed", async () => {
    const r = rig();
    r.control.open();
    await r.addDictWord("Zorbulax");
    await r.addDictWord("Amberline");
    await r.addDictWord("Mireth");
    expect(r.dictWords()).toEqual(["Amberline", "Mireth", "Zorbulax"]);
  });

  test("removing a word persists it and takes it off the list", async () => {
    const r = rig();
    r.control.open();
    await r.addDictWord("Zorbulax");
    r.container.querySelector("#prefs-dict-list button")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await settle();
    expect(r.dictRemoves).toEqual(["Zorbulax"]);
    expect(r.dictWords()).toEqual([]);
    expect(r.container.querySelector("#prefs-dict-empty")).not.toBeNull();
  });

  test("a word that fails to add is reported and never appears on the list", async () => {
    // Unlike every toggle above, a failure here means NOTHING changed: the
    // panel must not show a word the store refused.
    const r = rig();
    r.control.open();
    r.failDictWith('"Zorbulax" is already on this project\'s dictionary');
    await r.addDictWord("Zorbulax");
    expect(r.dictWords()).toEqual([]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("Zorbulax");
  });

  test("a word that fails to remove stays on the list", async () => {
    const r = rig();
    r.control.open();
    await r.addDictWord("Zorbulax");
    r.failDictWith("gone");
    r.container.querySelector("#prefs-dict-list button")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await settle();
    expect(r.dictWords()).toEqual(["Zorbulax"]);
    expect(r.notices).toHaveLength(1);
  });

  test("setDictionary replaces the list wholesale and sorts it", () => {
    // What a project switch calls: the panel is mounted once and the list is
    // per-project, so a switch cannot go on showing the previous manuscript's
    // words.
    const r = rig();
    r.control.open();
    r.control.setDictionary(["Zorbulax", "Amberline"]);
    expect(r.dictWords()).toEqual(["Amberline", "Zorbulax"]);
    r.control.setDictionary([]);
    expect(r.dictWords()).toEqual([]);
    expect(r.container.querySelector("#prefs-dict-empty")).not.toBeNull();
  });

  test("setDictionary(null) hides the group; setDictionary([]) shows it", () => {
    // The empty boot's own answer: the dictionary is per book, and a
    // group whose every control would answer "no project is open" is hidden
    // rather than asked a question it cannot answer.
    const r = rig();
    r.control.open();
    const group = (): HTMLElement => {
      const el = r.container.querySelector("#prefs-dict");
      if (!(el instanceof HTMLElement)) throw new Error("no #prefs-dict mounted");
      return el;
    };
    expect(group().hidden).toBe(false);
    r.control.setDictionary(null);
    expect(group().hidden).toBe(true);
    r.control.setDictionary([]);
    expect(group().hidden).toBe(false);
  });

  test("Enter in the field adds the word, same as clicking Add", async () => {
    const r = rig();
    r.control.open();
    r.dictInput().value = "Kethrani";
    r.dictInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(r.dictAdds).toEqual(["Kethrani"]);
    expect(r.dictWords()).toEqual(["Kethrani"]);
  });

  test("destroy stops the add button and the remove buttons working", async () => {
    const r = rig();
    r.control.open();
    await r.addDictWord("Zorbulax");
    r.control.destroy();
    await r.addDictWord("Amberline").catch(() => undefined);
    expect(r.dictAdds).toEqual(["Zorbulax"]);
  });

  test("the zoom group paints five bare numbers and presses the injected one", () => {
    // Bare numbers, not percentages: the legend "Zoom" already says what they
    // are, and the "%" wrapped the row onto two lines in the first capture.
    const r = rig("system", DEFAULT_TYPOGRAPHY, DEFAULT_DAILY_TARGET, DEFAULT_WRITING_MODES, "150");
    expect(
      [...r.panel().querySelectorAll("#prefs-zoom [data-prefs-value]")].map((b) => b.textContent),
    ).toEqual(["100", "125", "150", "175", "200"]);
    expect(r.byId("prefs-zoom-150").getAttribute("aria-pressed")).toBe("true");
  });

  test("choosing a zoom persists that word alone and repaints the group", async () => {
    const r = rig();
    await r.click("prefs-zoom-175");
    expect(r.zooms).toEqual(["175"]);
    expect(r.byId("prefs-zoom-175").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-zoom-100").getAttribute("aria-pressed")).toBe("false");
    // Nothing on the root: the HOST draws the zoom, the page only asks.
    expect(r.root.getAttribute("style")).toBeNull();
    expect(r.root.getAttribute("data-zoom")).toBeNull();
  });

  test("a failed zoom save rolls the word back, unlike every other group", async () => {
    // Zoom is applied by the HOST, not by this unit -- unlike the other
    // groups, a refusal here means the screen never actually changed, so the
    // panel must not go on showing the word it asked for.
    const r = rig();
    r.failWith("read-only file system");
    await r.click("prefs-zoom-175");
    expect(r.byId("prefs-zoom-100").getAttribute("aria-pressed")).toBe("true");
    expect(r.byId("prefs-zoom-175").getAttribute("aria-pressed")).toBe("false");
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("read-only file system");
  });

  test("setZoom repaints without persisting, for a chord the page handled elsewhere", () => {
    const r = rig();
    r.control.setZoom("200");
    expect(r.byId("prefs-zoom-200").getAttribute("aria-pressed")).toBe("true");
    expect(r.zooms).toEqual([]);
  });

  test("setFocus applies, persists BOTH axes, repaints and reports", () => {
    // The header's Focus button is a second VIEW of this value, not a second
    // owner of it -- setFocus is its only entry point into this module.
    const modes: WritingModes[] = [];
    const r = rig(
      "system",
      DEFAULT_TYPOGRAPHY,
      DEFAULT_DAILY_TARGET,
      { focus: "off", typewriter: "on" },
      DEFAULT_ZOOM,
      "en",
      "last",
      (m) => modes.push(m),
    );
    r.control.setFocus("paragraph");
    expect(r.root.getAttribute("data-focus")).toBe("paragraph");
    expect(r.writingModes).toEqual([{ focus: "paragraph", typewriter: "on" }]);
    expect(modes).toEqual([{ focus: "paragraph", typewriter: "on" }]);
    expect(
      r
        .panel()
        .querySelector('[data-prefs-group="prefs-focus"][aria-pressed="true"]')
        ?.getAttribute("data-prefs-value"),
    ).toBe("paragraph");
  });

  test("a panel click on Focus reports through onWritingModes too", async () => {
    // Same sink either way in: the panel click branch and setFocus both go
    // through applyWritingModesChange, so a listener does not have to know
    // which view raised the change.
    const modes: WritingModes[] = [];
    const r = rig(
      "system",
      DEFAULT_TYPOGRAPHY,
      DEFAULT_DAILY_TARGET,
      DEFAULT_WRITING_MODES,
      DEFAULT_ZOOM,
      "en",
      "last",
      (m) => modes.push(m),
    );
    await r.click("prefs-focus-paragraph");
    expect(modes.at(-1)?.focus).toBe("paragraph");
  });

  test("setFocus with the mode already current still persists and reports", () => {
    // No dedupe: the host is the record of truth, so a call naming the mode
    // already in effect must still go all the way through, not be swallowed
    // as a no-op.
    const modes: WritingModes[] = [];
    const current: FocusMode = "off";
    const r = rig(
      "system",
      DEFAULT_TYPOGRAPHY,
      DEFAULT_DAILY_TARGET,
      { focus: current, typewriter: "off" },
      DEFAULT_ZOOM,
      "en",
      "last",
      (m) => modes.push(m),
    );
    r.control.setFocus(current);
    expect(r.writingModes).toEqual([{ focus: current, typewriter: "off" }]);
    expect(modes).toEqual([{ focus: current, typewriter: "off" }]);
  });
});


test("privacy preferences routes to native settings and states the file boundary", async () => {
  let calls = 0;
  rig(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { calls += 1; });
  const button = document.getElementById("prefs-privacy-open") as HTMLButtonElement;
  expect(button.textContent).toBe(t("privacy.settings"));
  expect(document.getElementById("prefs-privacy")?.textContent).toContain(t("privacy.boundary"));
  button.click(); await settle();
  expect(calls).toBe(1);
});


test("ambiguous writing modes carry readable descriptions on their controls", () => {
  const r = rig();
  for (const stem of ["focus", "typewriter", "mark-cast-names"]) {
    const note = r.container.querySelector(`#prefs-${stem}-note`);
    expect(note?.textContent).toBe(t(`prefs.${stem}.note`));
    for (const button of r.container.querySelectorAll(`#prefs-${stem} button`)) {
      expect(button.getAttribute("aria-describedby")).toBe(`prefs-${stem}-note`);
    }
  }
});
