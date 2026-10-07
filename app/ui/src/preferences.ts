// app/ui/src/preferences.ts
// One button in the project bar and a panel behind it, holding every preference
// that is about how the application LOOKS: the palette, and the three axes the
// manuscript is set on.
//
// WHY A PANEL, AND WHY THE THEME BUTTON MOVED INTO IT.
//
// The project bar is five controls wide and its 39px height is a click-geometry
// constant restated in outline-cli, export-cli, words-cli and switch-cli. Three
// more controls on the strip is a real risk of wrapping it, and a wrapped strip
// moves every navigator row and makes four graded rigs click the wrong one. So
// the typography controls cannot go in the bar - which is the same constraint
// that put Import in the project panel.
//
// Theme came along because theme IS a preference. It was a bar button only
// because it was the first one, and a panel called Preferences that does not
// contain the palette is the arrangement nobody would choose deliberately. Net
// control count: five before, five after, and the strip's geometry is untouched.
//
// The groups are rows of buttons rather than <select>s. Inside a panel the bar's
// line-box constraint no longer applies, so this is a free choice, and it is
// made because a listbox is a second keyboard interaction model in a page whose
// panels are all click-and-Escape.
import { isCompositionKey } from "./composition-key";
import { formatNumber, t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { createHelpTip } from "./help-tip";
import {
  applyWritingModes,
  FOCUS_MODES,
  TYPEWRITER_MODES,
  type FocusMode,
  type TypewriterMode,
  type WritingModes,
} from "./writing-modes";
import { DAILY_TARGETS, isDailyTarget, type DailyTarget, type DailyTargetPreset } from "./goals";
import {
  applyTheme,
  applyThemeFamily,
  THEME_FAMILIES,
  THEMES,
  type Theme,
  type ThemeFamily,
} from "./theme";
import {
  applyTypography,
  FAMILIES,
  MEASURES,
  SIZES,
  type ProseFamily,
  type ProseMeasure,
  type ProseSize,
  type Typography,
} from "./typography";
import { ZOOMS, isZoom, createZoomPersistence, type Zoom, type ZoomPersistence } from "./zoom";

/** The two languages this build ships a catalog for. A `<select>`, not a row
 *  of buttons like every group above it: the row-of-buttons choice is
 *  recorded above as free because a listbox is a second keyboard model in a
 *  panel that is otherwise click-and-Escape - true for a choice among a
 *  handful of short words, and no longer true the day a third or fourth
 *  language makes the row wrap the panel the same way a sixth bar control
 *  would have wrapped the strip. */
export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The three words `settings.start` holds. A `<select>`, for
 *  LOCALES's own reason: each is a full sentence ("Open the last book I was
 *  writing"), not a short word a row of buttons fits. */
export const STARTS = ["home", "last", "blank"] as const;
export type Start = (typeof STARTS)[number];

export function isStart(value: string): value is Start {
  return (STARTS as readonly string[]).includes(value);
}

export interface PreferencesDeps {
  /** The bar element from index.html. Outside #project-controls, which the
   *  switcher clears wholesale. */
  container: HTMLElement;
  /** The element the preference attributes are written on.
   *  `document.documentElement` in the page; injected so a test can assert on
   *  something it owns. */
  root: HTMLElement;
  openPrivacy?: () => Promise<void>;
  /** What the host injected, already narrowed. */
  initialTheme: Theme;
  initialThemeFamily: ThemeFamily;
  initialTypography: Typography;
  initialDailyTarget: DailyTarget;
  initialWritingModes: WritingModes;
  initialZoom: Zoom;
  /** What the host injected as `window.__appLocale`, already narrowed. There
   *  is no live re-render: every unit in the page renders its strings once,
   *  at mount, so a choice made here takes effect the next time the
   *  application opens, exactly what `prefs.language.applied` tells the
   *  writer. */
  initialLocale: Locale;
  /** What `settings.start` holds: what the window opens onto next
   *  launch. Same "recorded only, no live effect" shape as `initialLocale` -
   *  it governs a launch that already happened. */
  initialStart: Start;
  initialSpelling: SpellingMode;
  /** Whether the cast-marks plugin is fed any names at all. On by
   *  default: the design record's own sample shows the marks. */
  initialMarkCastNames: boolean;
  /** This project's own spelling wordlist, alphabetically -- what `dict_list`
   *  answered when the window opened. Per-project, unlike everything else in
   *  this panel, which is why `setDictionary` exists: the panel is mounted
   *  once and a project switch must repaint this one group.
   *
   *  `null` AT AN EMPTY BOOT: `dict_list` answers the OPEN project's
   *  dictionary and errors with nothing open (`open_project`'s own guard), so
   *  main.ts never calls it there -- the dictionary is per book, and a group
   *  whose every control would answer "no project is open" is hidden instead
   *  of being asked a question it cannot answer. */
  initialDictionary: readonly string[] | null;
  persistTheme: (theme: Theme) => Promise<void>;
  persistThemeFamily: (family: ThemeFamily) => Promise<void>;
  persistTypography: (typography: Typography) => Promise<void>;
  persistDailyTarget: (target: DailyTarget) => Promise<void>;
  /** BOTH AXES, always, because the host parses both before writing either -
   *  a call naming one wrongly must change nothing rather than half of what was
   *  asked. */
  persistWritingModes: (modes: WritingModes) => Promise<void>;
  /** The host both records this AND applies it to the live webview: page zoom
   *  is WebKit's, set through the webview, and there is no attribute for this
   *  page to write. */
  persistZoom: (zoom: Zoom) => Promise<void>;
  /** Shared with keyboard shortcuts when mounted as application chrome. */
  zoomPersistence?: ZoomPersistence;
  /** Recorded ONLY - unlike theme, typography or zoom, nothing here is
   *  applied to the live page: every unit renders its strings at mount, and
   *  reaching into all of them to rebuild every label would be a second,
   *  unreviewed i18n architecture built for one control. */
  persistLocale: (locale: Locale) => Promise<void>;
  /** Recorded only, `persistLocale`'s own reason: it governs the NEXT launch,
   *  not this one. */
  persistStart: (start: Start) => Promise<void>;
  /** The host both records this AND applies it to the live webview, so unlike
   *  every other preference here the page does not touch the root at all. */
  persistSpelling: (spelling: SpellingMode) => Promise<void>;
  /** A plain bool at the host, unlike every other row here: there is no
   *  misspelling of on/off to refuse. */
  persistMarkCastNames: (on: boolean) => Promise<void>;
  /** Told on a successful change, so the currently mounted project can feed
   *  the editor plugin at once rather than waiting for the writer to switch
   *  scenes -- `onWritingModes`'s own reason and shape. */
  onMarkCastNames?: (on: boolean) => void;
  /** Add one word to the OPEN project's dictionary. Resolves to the word as the
   *  store stored it (trimmed) so the row painted matches the file; rejects
   *  with the store's own reason (empty, already there) rather than applying
   *  anything locally first -- unlike every toggle in this panel, a failure
   *  here means nothing changed, not merely that it will not survive relaunch. */
  persistDictAdd: (word: string) => Promise<string>;
  /** Take one word off the OPEN project's dictionary. Same all-or-nothing
   *  contract as `persistDictAdd`. */
  persistDictRemove: (word: string) => Promise<void>;
  /** Told when the target changes, so the bar can repaint against the new one
   *  without a round trip. The panel does not own the readout and must not reach
   *  into it. */
  onDailyTarget: (target: DailyTarget) => void;
  /** The header's Focus button repaints from this; the panel and the button are
   *  two views of one value and this module is its owner. */
  onWritingModes?: (modes: WritingModes) => void;
  /** NON-LATCHING. A preference that failed to save must never suppress the
   *  autosave banner, which is the only surface a real save failure has. */
  onNotice: (message: string) => void;
  /** Told on a successful preference save that has no visible effect of its
   *  own to confirm it by - the language, whose only feedback is this
   *  announcement, because nothing on screen changes until the next launch. */
  onDone: (message: string) => void;
  /** Where focus goes when the panel is dismissed. The toggle that used to sit
   *  in the bar was this unit's focus-return target; with the menu as the only
   *  route in, the unit no longer has one of its own and the page decides. */
  onDismiss: () => void;
}

export interface Preferences {
  /** Open the panel and move focus into it. File > Preferences…, which is the
   *  only route in. */
  open(): void;
  /** Replace the dictionary list wholesale, alphabetically. Called after a
   *  project switch: the panel is mounted once, but the list belongs to
   *  whichever project is open, and a switch must not go on showing the
   *  previous manuscript's words.
   *
   *  `null` HIDES THE GROUP: the empty boot's own answer, and a switch
   *  AWAY from a book back to nothing open would use it too, though nothing
   *  today drives that path -- a switch only ever lands on another book. */
  setDictionary(words: readonly string[] | null): void;
  /** Clear outgoing words and disable the group before a book switch. */
  invalidateDictionary(): void;
  /** Wait for outgoing dictionary writes before the host changes books. */
  drainDictionary(): Promise<void>;
  /** Read only for the current dictionary owner; failures leave it unavailable. */
  refreshDictionary(read: () => Promise<readonly string[]>): Promise<void>;
  /** Persist one word into the OPEN project's dictionary and paint it.
   *  Resolves to the word as stored; rejects with the host's refusal. */
  addWord(word: string): Promise<string>;
  /** A chord changed it outside this panel (Ctrl+= / Ctrl+- / Ctrl+0 anywhere
   *  in the page); repaint the group to match, but do not persist -- the
   *  caller that owns the chord already asked the host itself. */
  setZoom(zoom: Zoom): void;
  /** The header's Focus button calling in: applies, repaints, persists BOTH
   *  axes, and reports through `onWritingModes` the same as a panel click
   *  does. The panel and the button are two views of one value; this is the
   *  entry point that keeps this module the only owner of it. */
  setFocus(mode: FocusMode): void;
  destroy(): void;
}

/** On or off, and nothing between.
 *
 *  The off switch is not a nicety. WebKitGTK draws the underlines and offers
 *  suggestions, but its "Learn Spelling" and "Ignore Spelling" menu items are
 *  INSENSITIVE here - measured by capture, not assumed. So a novelist's invented
 *  character names and places are underlined permanently with no way to teach
 *  the dictionary about them, and for the writer who uses the most invented
 *  words that is the worst case. */
export const SPELLING_MODES = ["on", "off"] as const;
export type SpellingMode = (typeof SPELLING_MODES)[number];

const SPELLING_LABELS: Record<SpellingMode, string> = {
  on: t("prefs.on"),
  off: t("prefs.off"),
};

const FOCUS_LABELS: Record<FocusMode, string> = {
  off: t("prefs.off"),
  paragraph: t("prefs.focus.paragraph"),
};

const TYPEWRITER_LABELS: Record<TypewriterMode, string> = {
  off: t("prefs.off"),
  on: t("prefs.on"),
};

/** The names spec section 17 gives them, shortened to what fits the row. The
 *  full names - Linen and Ink, Paper and Graphite, Sage and Midnight - are the
 *  palettes' descriptions rather than their labels; a control offering three
 *  two-word phrases is a control a writer has to read rather than scan. */
const PALETTE_LABELS: Record<ThemeFamily, string> = {
  editorial: t("prefs.palette.editorial"),
  neutral: t("prefs.palette.neutral"),
  atmospheric: t("prefs.palette.atmospheric"),
};

const THEME_LABELS: Record<Theme, string> = {
  system: t("prefs.theme.system"),
  light: t("prefs.theme.light"),
  dark: t("prefs.theme.dark"),
};

/** Each language names ITSELF, in itself - "English" in the English catalog,
 *  "Deutsch" in the German one, and each catalog carries both so a writer
 *  reading either language sees the same two words in this one control. */
const LOCALE_LABELS: Record<Locale, string> = {
  en: t("prefs.language.en"),
  de: t("prefs.language.de"),
};

/** Each option names what happens, in full, on its own line - a `<select>`'s
 *  own reason (see STARTS above). */
const START_LABELS: Record<Start, string> = {
  home: t("prefs.start.home"),
  last: t("prefs.start.last"),
  blank: t("prefs.start.blank"),
};

const FAMILY_LABELS: Record<ProseFamily, string> = {
  serif: t("prefs.family.serif"),
  sans: t("prefs.family.sans"),
  mono: t("prefs.family.mono"),
};

// Named for what they are rather than for a number: the stylesheet states the
// measure in `em`, so a width in pixels follows the size and a label saying
// "39em" would be true of one of the four sizes at a time.
const SIZE_LABELS: Record<ProseSize, string> = {
  small: t("prefs.size.small"),
  medium: t("prefs.size.medium"),
  large: t("prefs.size.large"),
  larger: t("prefs.size.larger"),
};

const MEASURE_LABELS: Record<ProseMeasure, string> = {
  narrow: t("prefs.measure.narrow"),
  medium: t("prefs.measure.medium"),
  wide: t("prefs.measure.wide"),
};

// The five numbers label themselves, like the goal numbers: the legend
// "Zoom" already says what they are, and the "%" was dropped because the
// five percentages wrapped the row onto two lines in the first capture
// (2026-09-02-066-prefs-light-tiny.png) -- Goal's five buttons fit because
// its labels are narrower, and this row has to fit the same column.
const ZOOM_LABELS: Record<Zoom, string> = {
  "100": "100",
  "125": "125",
  "150": "150",
  "175": "175",
  "200": "200",
};

// The four numbers label themselves. "Off" is the only one that needs a word,
// and it needs the word rather than a "0" because zero words a day is a target
// nobody sets - it means "do not count me against anything".
const GOAL_LABELS: Record<DailyTargetPreset, string> = {
  off: t("prefs.off"),
  "250": "250",
  "500": "500",
  "1000": "1000",
  "2000": "2000",
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface GroupSpec<T extends string> {
  /** The id of the group's container, and the stem of each button's id. */
  id: string;
  /** The visible legend. Kept to ONE WORD: the column is a fixed width so that
   *  every group's buttons start at the same x, and two words wrap inside it.
   *  The column was widened to 76px to fit "Typewriter" rather than shortening
   *  that legend to something a sighted writer could not read. */
  legend: string;
  /** What the group is called to a screen reader, when the one word on screen
   *  is not enough on its own. "Goal" beside four numbers is unambiguous to
   *  someone who can see the four numbers; read aloud in a list of five groups
   *  it is not. Defaults to the legend, which is right for the four whose one
   *  word is the whole name. */
  name?: string;
  description?: string;
  values: readonly T[];
  labels: Record<T, string>;
}

export function createPreferences(deps: PreferencesDeps): Preferences {
  const { container, root } = deps;

  container.replaceChildren();

  let theme = deps.initialTheme;
  let themeFamily = deps.initialThemeFamily;
  let typography = deps.initialTypography;
  let dailyTarget = deps.initialDailyTarget;
  let writingModes = deps.initialWritingModes;
  let zoom = deps.initialZoom;
  const locale = deps.initialLocale;
  const start = deps.initialStart;
  let spelling = deps.initialSpelling;
  // On/off, the same shape spelling's own toggle takes -- the host command
  // is a plain bool, and this string is only ever converted at that one
  // boundary (see `onPanelClick`'s own branch below).
  let markCastNames: SpellingMode = deps.initialMarkCastNames ? "on" : "off";
  // Applied here as well as by the head script, because the panel must agree
  // with the page even when the head script did not run - which is every test,
  // and any future embedding of this page.
  applyTheme(root, theme);
  applyThemeFamily(root, themeFamily);
  applyTypography(root, typography);
  applyWritingModes(root, writingModes);

  const panel = document.createElement("div");
  panel.id = "prefs-panel";
  panel.setAttribute("role", "dialog");
  // Focusable, and only programmatically: `open()` puts focus HERE rather than
  // on a control inside, and a dialog nobody can focus announces nothing when
  // it opens. -1 keeps it out of the Tab order, where an invisible stop before
  // the panel's own controls would be a second thing to tab past.
  panel.tabIndex = -1;
  // Nothing here traps focus, and aria-modal="true" would tell a screen reader
  // the rest of the page is inert when it is not. Same as the project panel.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("prefs.title"));
  panel.hidden = true;

  let destroyed = false;

  /** Every button in every group, so a repaint is an attribute write per button
   *  rather than a rebuild. Rebuilding would drop focus mid-panel: the button
   *  the writer just pressed would be replaced by a new element. */
  const buttons = new Map<string, HTMLButtonElement>();

  function buildGroup<T extends string>(spec: GroupSpec<T>): HTMLElement {
    const group = document.createElement("div");
    group.id = spec.id;
    group.className = "prefs-choice-group";
    // A group rather than a radiogroup: radio semantics carry arrow-key
    // roving-focus expectations this panel does not implement, and promising
    // an interaction model that is not there is worse than not promising it.
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", spec.name ?? spec.legend);

    const legend = document.createElement("span");
    legend.className = "prefs-legend";
    // aria-hidden because the group's aria-label already says this, and a
    // screen reader announcing the legend twice per group is noise.
    legend.setAttribute("aria-hidden", "true");
    legend.textContent = spec.legend;
    group.append(legend);

    const choices = document.createElement("div");
    choices.className = "prefs-choices";
    for (const value of spec.values) {
      const button = document.createElement("button");
      button.id = `${spec.id}-${value}`;
      button.type = "button";
      button.textContent = spec.labels[value];
      button.dataset.prefsValue = value;
      button.dataset.prefsGroup = spec.id;
      choices.append(button);
      buttons.set(button.id, button);
    }
    group.append(choices);
    if (spec.description) {
      const note = document.createElement("p");
      note.id = `${spec.id}-note`;
      note.className = "prefs-choice-note";
      note.textContent = spec.description;
      group.append(note);
      group.setAttribute("aria-describedby", note.id);
    }
    return group;
  }

  const themeGroup = buildGroup<Theme>({
    id: "prefs-theme",
    legend: t("prefs.legend.theme"),
    values: THEMES,
    labels: THEME_LABELS,
  });

  // A <select>, not a buildGroup row of buttons - see LOCALES's own header.
  const languageGroup = document.createElement("div");
  languageGroup.id = "prefs-language-group";
  languageGroup.className = "prefs-choice-group";
  languageGroup.setAttribute("role", "group");
  languageGroup.setAttribute("aria-label", t("prefs.language"));
  const languageLegend = document.createElement("span");
  languageLegend.className = "prefs-legend";
  languageLegend.setAttribute("aria-hidden", "true");
  languageLegend.textContent = t("prefs.language");
  languageGroup.append(languageLegend);
  const languageSelect = document.createElement("select");
  languageSelect.id = "prefs-language";
  languageSelect.setAttribute("aria-label", t("prefs.language"));
  for (const value of LOCALES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = LOCALE_LABELS[value];
    languageSelect.append(option);
  }
  languageSelect.value = locale;
  const languageChoices = document.createElement("div");
  languageChoices.className = "prefs-choices";
  languageChoices.append(languageSelect);
  languageGroup.append(languageChoices);

  // A <select>, LOCALES's own reason: each of the three answers is a full
  // sentence and a row of buttons would wrap the panel exactly as a third
  // language would.
  const startGroup = document.createElement("div");
  startGroup.id = "prefs-start-group";
  startGroup.className = "prefs-choice-group";
  startGroup.setAttribute("role", "group");
  startGroup.setAttribute("aria-label", t("prefs.start.label"));
  const startLegend = document.createElement("span");
  startLegend.className = "prefs-legend";
  startLegend.setAttribute("aria-hidden", "true");
  startLegend.textContent = t("prefs.start.label");
  startGroup.append(startLegend);
  const startSelect = document.createElement("select");
  startSelect.id = "prefs-start";
  startSelect.setAttribute("aria-label", t("prefs.start.label"));
  for (const value of STARTS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = START_LABELS[value];
    startSelect.append(option);
  }
  startSelect.value = start;
  const startChoices = document.createElement("div");
  startChoices.className = "prefs-choices";
  startChoices.append(startSelect);
  startGroup.append(startChoices);

  // FIRST, above the light/dark control it qualifies: a writer picks a palette
  // and then decides whether to follow the desktop, not the other way round.
  const paletteGroup = buildGroup<ThemeFamily>({
    id: "prefs-palette",
    legend: t("prefs.legend.palette"),
    values: THEME_FAMILIES,
    labels: PALETTE_LABELS,
  });
  const familyGroup = buildGroup<ProseFamily>({
    id: "prefs-family",
    legend: t("prefs.legend.font"),
    values: FAMILIES,
    labels: FAMILY_LABELS,
  });
  const sizeGroup = buildGroup<ProseSize>({
    id: "prefs-size",
    legend: t("prefs.legend.size"),
    values: SIZES,
    labels: SIZE_LABELS,
  });
  const measureGroup = buildGroup<ProseMeasure>({
    id: "prefs-measure",
    legend: t("prefs.legend.width"),
    values: MEASURES,
    labels: MEASURE_LABELS,
  });

  // HOW BIG THE WHOLE APPLICATION IS DRAWN, and the one group here whose
  // choice this unit does not apply: page zoom is the web engine's, set by
  // the host through the webview, and there is no attribute for the page to
  // write. Beside the type size because a writer on a 4k monitor at scale 1
  // reaches for one when they wanted the other.
  const zoomGroup = buildGroup<Zoom>({
    id: "prefs-zoom",
    legend: t("prefs.legend.zoom"),
    values: ZOOMS,
    labels: ZOOM_LABELS,
  });

  // What the writer is trying to do, placed in the Writing section
  // after the three that set the page.
  const goalGroup = buildGroup<DailyTargetPreset>({
    id: "prefs-goal",
    legend: t("prefs.legend.goal"),
    name: t("prefs.name.goal"),
    values: DAILY_TARGETS,
    labels: GOAL_LABELS,
  });
  const customGoal = document.createElement("input");
  customGoal.id = "prefs-goal-custom";
  customGoal.type = "number";
  customGoal.spellcheck = false;
  customGoal.inputMode = "numeric";
  customGoal.min = "1";
  customGoal.max = "1000000";
  customGoal.step = "1";
  customGoal.setAttribute("aria-label", t("prefs.goal.custom"));
  customGoal.value = (DAILY_TARGETS as readonly string[]).includes(dailyTarget) ? "" : dailyTarget;
  goalGroup.querySelector(".prefs-choices")!.append(customGoal);
  // WHERE THE WRITER SITS, not how the application looks and not what they are
  // trying to do: a third kind of thing in the one panel there is. Both axes are
  // separate groups rather than one four-button row, because they are
  // independent - either, both, or neither - and a single row would read as a
  // choice of one.
  const focusGroup = buildGroup<FocusMode>({
    id: "prefs-focus",
    legend: t("prefs.legend.focus"),
    values: FOCUS_MODES,
    labels: FOCUS_LABELS,
  });
  const focusHelp = createHelpTip({
    id: "prefs-focus-help",
    label: t("prefs.legend.focus"),
    definition: t("prefs.focus.note"),
  });
  const focusLegend = focusGroup.querySelector<HTMLElement>(".prefs-legend")!;
  const focusLabel = document.createElement("span");
  focusLabel.setAttribute("aria-hidden", "true");
  focusLabel.textContent = t("prefs.legend.focus");
  focusLegend.removeAttribute("aria-hidden");
  focusLegend.replaceChildren(focusLabel, focusHelp.anchor);
  // NOT applied to the root by this unit. The underlines belong to the web
  // engine, which the host turns on and off through WebKitWebContext - there is
  // no attribute and no stylesheet rule for the page to write.
  const spellingGroup = buildGroup<SpellingMode>({
    id: "prefs-spelling",
    legend: t("prefs.legend.spelling"),
    values: SPELLING_MODES,
    labels: SPELLING_LABELS,
  });
  const typewriterGroup = buildGroup<TypewriterMode>({
    id: "prefs-typewriter",
    description: t("prefs.typewriter.note"),
    legend: t("prefs.legend.typewriter"),
    values: TYPEWRITER_MODES,
    labels: TYPEWRITER_LABELS,
  });
  // whether a cast member's name is marked where it appears in the
  // open scene's prose. Beside spelling and typewriter rather than in a
  // group of its own, on the same reasoning as both -- a fourth kind of
  // thing in the one panel there is, this one about the manuscript's own
  // surface.
  const markCastNamesGroup = buildGroup<SpellingMode>({
    id: "prefs-mark-cast-names",
    description: t("prefs.mark-cast-names.note"),
    legend: t("prefs.legend.mark-cast-names"),
    name: t("prefs.name.mark-cast-names"),
    values: SPELLING_MODES,
    labels: SPELLING_LABELS,
  });

  // BESIDE THE SPELLING TOGGLE, deliberately: this is the other half of spec
  // section 9's "spelling and user dictionaries", and the project bar has no
  // room left for a control of its own (see the module header). Not a
  // buildGroup: this is one word list with an editor, not a finite choice
  // among named values.
  //
  // `dictWords` is THIS unit's copy of the open project's list. It starts from
  // `initialDictionary` and is kept in step by `setDictionary` on a project
  // switch, and by `addDictWord`/`removeDictWord` locally once the host
  // confirms the write - never before, because unlike every toggle above, a
  // failed add or remove here means nothing changed at all, not merely that it
  // will not survive relaunch.
  const dictWords: string[] = deps.initialDictionary === null ? [] : [...deps.initialDictionary];
  let dictGeneration = 0;
  let dictReady = deps.initialDictionary !== null;
  let dictLoading = false;
  const pendingDictWrites = new Set<Promise<unknown>>();

  const dictGroup = document.createElement("div");
  dictGroup.id = "prefs-dict";
  dictGroup.setAttribute("role", "group");
  dictGroup.setAttribute("aria-label", t("prefs.legend.dictionary"));
  // See the `[hidden]` restatement beside `#prefs-panel #prefs-dict`'s own
  // `display: block` in style.css -- that rule's specificity beats the
  // user-agent `[hidden]` rule on its own, page-ui.md's recorded collision.
  dictGroup.hidden = deps.initialDictionary === null;

  const dictLegend = document.createElement("span");
  dictLegend.className = "prefs-legend";
  dictLegend.setAttribute("aria-hidden", "true");
  dictLegend.textContent = t("prefs.legend.dictionary");
  dictGroup.append(dictLegend);

  // SAID PLAINLY, because whether an already-open window's checker picks up a
  // rewritten wordlist immediately or only on the next launch is unmeasured on
  // this machine. The list
  // itself is correct and travels with the project either way; only the
  // underline in THIS window might lag it.
  const dictNote = document.createElement("p");
  dictNote.id = "prefs-dict-note";
  dictNote.textContent = t("prefs.dict.note");
  dictGroup.append(dictNote);

  const dictRow = document.createElement("div");
  dictRow.id = "prefs-dict-row";
  const dictInput = document.createElement("input");
  dictInput.id = "prefs-dict-word";
  dictInput.type = "text";
  const dictLabel = document.createElement("label");
  dictLabel.htmlFor = dictInput.id;
  dictLabel.textContent = t("prefs.dict.word.label");
  dictGroup.append(dictLabel);
  const dictAdd = document.createElement("button");
  dictAdd.id = "prefs-dict-add";
  dictAdd.type = "button";
  dictAdd.textContent = t("prefs.dict.add");
  dictRow.append(dictInput, dictAdd);
  dictGroup.append(dictRow);

  const dictList = document.createElement("ul");
  dictList.id = "prefs-dict-list";
  dictGroup.append(dictList);

  function paintDict(fallbackIndex?: number): void {
    const focused = document.activeElement;
    const focusedWord = focused instanceof HTMLElement && dictList.contains(focused)
      ? focused.dataset.dictRemove : undefined;
    dictInput.disabled = !dictReady;
    dictAdd.disabled = !dictReady;
    dictList.replaceChildren();
    if (!dictReady) {
      const unavailable = document.createElement("li");
      unavailable.id = "prefs-dict-unavailable";
      unavailable.setAttribute("role", "status");
      unavailable.textContent = t(dictLoading ? "prefs.dict.loading" : "prefs.dict.unavailable");
      dictList.append(unavailable);
      return;
    }
    if (dictWords.length === 0) {
      const empty = document.createElement("li");
      empty.id = "prefs-dict-empty";
      empty.textContent = t("prefs.dict.empty");
      dictList.append(empty);
      if (fallbackIndex !== undefined) dictInput.focus();
      return;
    }
    for (const word of dictWords) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = word;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.dictRemove = word;
      remove.setAttribute("aria-label", t("prefs.dict.remove", { word }));
      // A bare glyph, the same one #project-bar's banner dismiss button uses:
      // no letters in it, so the no-hardcoded-strings guard already treats it
      // as technical rather than prose needing a catalog key.
      remove.textContent = "×";
      row.append(label, remove);
      dictList.append(row);
    }
    const removes = [...dictList.querySelectorAll<HTMLButtonElement>("[data-dict-remove]")];
    const retained = removes.find((button) => button.dataset.dictRemove === focusedWord);
    if (retained !== undefined) retained.focus();
    else if (fallbackIndex !== undefined) removes[Math.min(fallbackIndex, removes.length - 1)]?.focus();
  }
  paintDict();

  function invalidateDictionary(): void {
    dictGeneration += 1;
    dictReady = false;
    dictLoading = true;
    dictWords.length = 0;
    dictInput.value = "";
    dictGroup.hidden = false;
    paintDict();
  }

  async function drainDictionary(): Promise<void> {
    await Promise.allSettled(pendingDictWrites);
  }

  function trackDictionaryWrite<T>(pending: Promise<T>): Promise<T> {
    pendingDictWrites.add(pending);
    void pending.then(
      () => { pendingDictWrites.delete(pending); },
      () => { pendingDictWrites.delete(pending); },
    );
    return pending;
  }

  async function refreshDictionary(read: () => Promise<readonly string[]>): Promise<void> {
    if (destroyed) return;
    invalidateDictionary();
    const generation = dictGeneration;
    try {
      const words = await read();
      if (destroyed || generation !== dictGeneration) return;
      dictWords.push(...[...words].sort((a, b) => a.localeCompare(b)));
      dictReady = true;
    } catch {
      if (destroyed || generation !== dictGeneration) return;
    }
    dictLoading = false;
    paintDict();
  }

  function insertSorted(word: string): void {
    const at = dictWords.findIndex((existing) => existing.localeCompare(word) > 0);
    if (at === -1) dictWords.push(word);
    else dictWords.splice(at, 0, word);
  }

  /** Persist one word and paint it into the list. The one body behind the
   *  panel's own field and the editor's routes; it throws what the host
   *  threw, and each caller says so in its own surface. */
  async function addWord(requested: string): Promise<string> {
    if (destroyed || !dictReady) throw new Error(t("prefs.dict.unavailable"));
    const generation = dictGeneration;
    const stored = await trackDictionaryWrite(deps.persistDictAdd(requested));
    if (destroyed || generation !== dictGeneration) return stored;
    insertSorted(stored);
    paintDict();
    return stored;
  }

  async function addDictWord(): Promise<void> {
    const requested = dictInput.value.trim();
    if (requested === "" || !dictReady || destroyed) return;
    const generation = dictGeneration;
    try {
      await addWord(requested);
      if (destroyed || generation !== dictGeneration) return;
      dictInput.value = "";
    } catch (error: unknown) {
      // A resolution landing after teardown would report through a dead
      // project's callbacks, the same defect the outline slice shipped once.
      if (destroyed || generation !== dictGeneration) return;
      deps.onNotice(t("prefs.dict.error.add", { word: requested, error: messageOf(error) }));
    }
    dictInput.focus();
  }

  async function removeDictWord(word: string, button: HTMLElement): Promise<void> {
    if (destroyed || !dictReady) return;
    const generation = dictGeneration;
    try {
      await trackDictionaryWrite(deps.persistDictRemove(word));
      if (destroyed || generation !== dictGeneration) return;
      const ownsFocus = document.activeElement === button;
      const at = dictWords.indexOf(word);
      if (at !== -1) dictWords.splice(at, 1);
      paintDict(ownsFocus ? Math.max(0, at) : undefined);
    } catch (error: unknown) {
      if (destroyed || generation !== dictGeneration) return;
      deps.onNotice(t("prefs.dict.error.remove", { word, error: messageOf(error) }));
    }
  }

  const onDictAddClick = (): void => {
    void addDictWord();
  };
  const onDictInputKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    void addDictWord();
  };
  const onDictListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-dict-remove]");
    if (!(button instanceof HTMLElement)) return;
    const word = button.dataset.dictRemove;
    if (word === undefined) return;
    void removeDictWord(word, button);
  };
  dictAdd.addEventListener("click", onDictAddClick);
  dictInput.addEventListener("keydown", onDictInputKeyDown);
  dictList.addEventListener("click", onDictListClick);

  const tabs = document.createElement("div");
  tabs.id = "prefs-tabs";
  tabs.className = "segmented";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("prefs.tabs.label"));
  const categories = ["writing", "appearance", "application"] as const;
  const tabButtons: HTMLButtonElement[] = [];
  const pages: HTMLElement[] = [];
  function selectCategory(index: number, focus = false): void {
    tabButtons.forEach((button, at) => {
      button.setAttribute("aria-selected", String(at === index));
      button.tabIndex = at === index ? 0 : -1;
      pages[at].hidden = at !== index;
    });
    if (focus) tabButtons[index].focus();
  }
  for (const [index, category] of categories.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `prefs-tab-${category}`;
    button.textContent = t(`prefs.tab.${category}`);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `prefs-page-${category}`);
    button.addEventListener("click", () => selectCategory(index));
    button.addEventListener("keydown", (event) => {
      if (isCompositionKey(event)) return;
      const next = event.key === "Home" ? 0 : event.key === "End" ? 2
        : event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : null;
      if (next !== null) { event.preventDefault(); selectCategory(next, true); }
    });
    const page = document.createElement("div");
    page.id = `prefs-page-${category}`;
    page.setAttribute("role", "tabpanel");
    page.setAttribute("aria-labelledby", button.id);
    tabButtons.push(button);
    pages.push(page);
    tabs.append(button);
  }
  const aids = document.createElement("details");
  aids.id = "prefs-writing-aids";
  const summary = document.createElement("summary");
  summary.setAttribute("role", "button");
  summary.textContent = t("prefs.writing-aids");
  const aidGroups = document.createElement("div");
  aidGroups.className = "prefs-aid-groups";
  aidGroups.append(focusGroup, typewriterGroup, spellingGroup, markCastNamesGroup, dictGroup);
  aids.append(summary, aidGroups);
  pages[0].append(familyGroup, sizeGroup, measureGroup, goalGroup, aids);
  pages[1].append(paletteGroup, themeGroup, zoomGroup);
  pages[2].append(languageGroup, startGroup);
  selectCategory(0);
  panel.append(tabs, ...pages);
  if (deps.openPrivacy) {
    const privacy = document.createElement("div");
    privacy.id = "prefs-privacy";
    privacy.setAttribute("role", "group");
    privacy.setAttribute("aria-label", t("privacy.settings"));
    const button = document.createElement("button");
    button.id = "prefs-privacy-open";
    button.type = "button";
    button.textContent = t("privacy.settings");
    button.addEventListener("click", () => {
      void deps.openPrivacy?.().catch(() => deps.onNotice(t("privacy.error")));
    });
    const note = document.createElement("p");
    note.textContent = t("privacy.boundary");
    privacy.append(button, note);
    pages[2].append(privacy);
  }
  container.append(panel);

  /** aria-pressed on every button, not a class on the chosen one: the state has
   *  to reach a screen reader, and "which of these is in effect" is exactly what
   *  a toggle button's pressed state means. */
  function paint(): void {
    for (const button of buttons.values()) {
      const value = button.dataset.prefsValue;
      const group = button.dataset.prefsGroup;
      const chosen =
        (group === "prefs-palette" && value === themeFamily) ||
        (group === "prefs-theme" && value === theme) ||
        (group === "prefs-family" && value === typography.family) ||
        (group === "prefs-size" && value === typography.size) ||
        (group === "prefs-measure" && value === typography.measure) ||
        (group === "prefs-zoom" && value === zoom) ||
        (group === "prefs-spelling" && value === spelling) ||
        (group === "prefs-mark-cast-names" && value === markCastNames) ||
        (group === "prefs-focus" && value === writingModes.focus) ||
        (group === "prefs-typewriter" && value === writingModes.typewriter) ||
        (group === "prefs-goal" && value === dailyTarget);
      button.setAttribute("aria-pressed", String(chosen));
    }
  }

  paint();

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  /** Applied BEFORE the await and never rolled back if the save fails: the
   *  writer asked for this in this window and they have it. Only the memory of
   *  it across launches is at stake. */
  const record = async (persist: () => Promise<void>, what: string): Promise<void> => {
    try {
      await persist();
    } catch (error: unknown) {
      // A resolution landing after teardown would report through a dead
      // project's callbacks - the defect the outline slice shipped once.
      if (destroyed) return;
      deps.onNotice(t("prefs.error.save", { what, error: messageOf(error) }));
    }
  };

  // Each select records only next-launch state. Keep writes ordered and
  // restore the last confirmed choice only when the latest request fails.
  const recordedSelect = <T extends Locale | Start>(
    select: HTMLSelectElement,
    initial: T,
    valid: (value: string) => value is T,
    persist: (value: T) => Promise<void>,
    what: string,
    onDone?: () => void,
  ): (() => void) => {
    let confirmed = initial;
    let generation = 0;
    let pending = Promise.resolve();
    return () => {
      const value = select.value;
      if (!valid(value)) return;
      const request = ++generation;
      pending = pending.then(async () => {
        try {
          await persist(value);
          confirmed = value;
          if (!destroyed && request === generation) onDone?.();
        } catch (error: unknown) {
          if (destroyed) return;
          if (request === generation) select.value = confirmed;
          deps.onNotice(t("prefs.error.save", { what, error: messageOf(error) }));
        }
      });
    };
  };
  const onLanguageChange = recordedSelect(
    languageSelect, locale, isLocale, deps.persistLocale, t("prefs.what.language"),
    () => deps.onDone(t("prefs.language.applied")),
  );
  languageSelect.addEventListener("change", onLanguageChange);
  const onStartChange = recordedSelect(
    startSelect, start, isStart, deps.persistStart, t("prefs.what.start"),
  );
  startSelect.addEventListener("change", onStartChange);

  const zoomPersistence = deps.zoomPersistence ?? createZoomPersistence(
    zoom, deps.persistZoom, (next) => {
      if (destroyed) return;
      zoom = next;
      paint();
    },
  );

  /** The one place either axis of writing mode is applied, painted, reported
   *  and persisted -- called from the panel's click branch and from
   *  `setFocus`, so the header's Focus button and this panel are two views
   *  of one value rather than two owners of it. */
  const applyWritingModesChange = (next: WritingModes): void => {
    writingModes = next;
    applyWritingModes(root, writingModes);
    paint();
    deps.onWritingModes?.(writingModes);
    // BOTH axes sent, always: the host parses both before writing either, so
    // sending one would be a call it refuses.
    void record(() => deps.persistWritingModes(writingModes), t("prefs.what.writing-modes"));
  };

  const applyDailyTargetChange = (next: DailyTarget): void => {
    dailyTarget = next;
    customGoal.value = (DAILY_TARGETS as readonly string[]).includes(next) ? "" : next;
    paint();
    deps.onDailyTarget(next);
    void record(() => deps.persistDailyTarget(next), t("prefs.what.daily-goal"));
  };
  let rejectedGoal: string | null = null;
  const commitCustomGoal = (restoreDraft: boolean): void => {
    const value = customGoal.value;
    if (!isDailyTarget(value) || value === "off") {
      if (value !== "" && rejectedGoal !== value) {
        deps.onNotice(t("prefs.goal.invalid", { min: formatNumber(1), max: formatNumber(1000000) }));
        rejectedGoal = value;
      }
      if (restoreDraft) {
        customGoal.value = (DAILY_TARGETS as readonly string[]).includes(dailyTarget) ? "" : dailyTarget;
        rejectedGoal = null;
      }
      return;
    }
    rejectedGoal = null;
    if (value === dailyTarget) return;
    applyDailyTargetChange(value);
  };
  const onCustomGoalBlur = (): void => commitCustomGoal(true);
  const onCustomGoalKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event) || event.key !== "Enter") return;
    event.preventDefault();
    commitCustomGoal(false);
  };
  customGoal.addEventListener("keydown", onCustomGoalKeyDown);
  customGoal.addEventListener("blur", onCustomGoalBlur);

  const onPanelClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-prefs-value]");
    if (!(button instanceof HTMLElement)) return;
    const value = button.dataset.prefsValue;
    const group = button.dataset.prefsGroup;
    if (value === undefined || group === undefined) return;

    // Narrowed against the same lists the panel was painted from, so a value
    // that reached the DOM by any route other than buildGroup cannot be applied
    // or persisted.
    if (group === "prefs-palette") {
      if (!(THEME_FAMILIES as readonly string[]).includes(value)) return;
      themeFamily = value as ThemeFamily;
      applyThemeFamily(root, themeFamily);
      paint();
      void record(() => deps.persistThemeFamily(themeFamily), t("prefs.what.palette"));
      return;
    }

    if (group === "prefs-theme") {
      if (!(THEMES as readonly string[]).includes(value)) return;
      theme = value as Theme;
      applyTheme(root, theme);
      paint();
      void record(() => deps.persistTheme(theme), t("prefs.what.theme"));
      return;
    }

    if (group === "prefs-spelling") {
      if (!(SPELLING_MODES as readonly string[]).includes(value)) return;
      spelling = value as SpellingMode;
      paint();
      void record(() => deps.persistSpelling(spelling), t("prefs.what.spelling"));
      return;
    }

    if (group === "prefs-mark-cast-names") {
      if (!(SPELLING_MODES as readonly string[]).includes(value)) return;
      markCastNames = value as SpellingMode;
      paint();
      const on = markCastNames === "on";
      // Applied before the persist, `applyWritingModesChange`'s own rule: the
      // writer has it in THIS window whether or not the file takes it, and
      // the currently open scene must not wait for a switch to see it.
      deps.onMarkCastNames?.(on);
      void record(() => deps.persistMarkCastNames(on), t("prefs.what.mark-cast-names"));
      return;
    }

    if (group === "prefs-focus" || group === "prefs-typewriter") {
      const allowed: readonly string[] =
        group === "prefs-focus" ? FOCUS_MODES : TYPEWRITER_MODES;
      if (!allowed.includes(value)) return;
      applyWritingModesChange(
        group === "prefs-focus"
          ? { ...writingModes, focus: value as FocusMode }
          : { ...writingModes, typewriter: value as TypewriterMode },
      );
      return;
    }

    if (group === "prefs-goal") {
      if (!(DAILY_TARGETS as readonly string[]).includes(value)) return;
      applyDailyTargetChange(value as DailyTargetPreset);
      return;
    }

    if (group === "prefs-zoom") {
      if (!isZoom(value)) return;
      void zoomPersistence.request(value).then(() => {
        // Host page zoom reflows the scrollport after the original click.
        requestAnimationFrame(() => {
          if (!destroyed && !panel.hidden && document.activeElement === button) {
            button.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        });
      }).catch((error: unknown) => {
        if (destroyed) return;
        deps.onNotice(t("prefs.error.save", { what: t("prefs.what.zoom"), error: messageOf(error) }));
      });
      return;
    }

    let next: Typography | null = null;
    if (group === "prefs-family" && (FAMILIES as readonly string[]).includes(value)) {
      next = { ...typography, family: value as ProseFamily };
    } else if (group === "prefs-size" && (SIZES as readonly string[]).includes(value)) {
      next = { ...typography, size: value as ProseSize };
    } else if (group === "prefs-measure" && (MEASURES as readonly string[]).includes(value)) {
      next = { ...typography, measure: value as ProseMeasure };
    }
    if (next === null) return;

    typography = next;
    applyTypography(root, typography);
    paint();
    // The whole object every time, because the host command takes all three and
    // writes them together. A per-axis command would be three commands and three
    // read-modify-writes of a file that already holds the other two.
    void record(() => deps.persistTypography(typography), t("prefs.what.typography"));
  };

  panel.addEventListener("click", onPanelClick);

  // Close, Escape and a click elsewhere (the shell's). Close and Escape hand
  // focus back where the retired toggle used to: a panel closing into nowhere
  // leaves the writer's next keystroke on <body>.
  const shell = createPanelShell({
    panel,
    title: t("prefs.title"),
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
  });
  panel.insertBefore(tabs, shell.body);

  return {
    open(): void {
      setOpen(true);
      // The PANEL, not the first control inside: the panel is a set of radio
      // groups and landing on one of them would look like a preference had been
      // reached for. It is `role="dialog"` with a name, so focusing it announces
      // what opened and leaves Tab to reach the groups. This is what the toggle
      // used to do from OUTSIDE the dialog, which was the weaker half of the
      // pattern - and there is no outside left to focus.
      panel.focus();
    },
    setDictionary(words: readonly string[] | null): void {
      dictGeneration += 1;
      dictReady = words !== null;
      dictLoading = false;
      dictInput.value = "";
      dictGroup.hidden = words === null;
      dictWords.length = 0;
      if (words !== null) dictWords.push(...[...words].sort((a, b) => a.localeCompare(b)));
      paintDict();
    },
    invalidateDictionary,
    drainDictionary,
    refreshDictionary,
    addWord,
    setZoom(next: Zoom): void {
      zoom = next;
      paint();
    },
    setFocus(mode: FocusMode): void {
      applyWritingModesChange({ ...writingModes, focus: mode });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel.removeEventListener("click", onPanelClick);
      customGoal.removeEventListener("keydown", onCustomGoalKeyDown);
      customGoal.removeEventListener("blur", onCustomGoalBlur);
      focusHelp.destroy();
      dictAdd.removeEventListener("click", onDictAddClick);
      dictInput.removeEventListener("keydown", onDictInputKeyDown);
      dictList.removeEventListener("click", onDictListClick);
      languageSelect.removeEventListener("change", onLanguageChange);
      startSelect.removeEventListener("change", onStartChange);
      // THE ONE THAT MATTERS: it is on the document, so it outlives these
      // elements and would accumulate one live closure per project switch.
      shell.destroy();
      container.replaceChildren();
      // data-theme and the three data-prose-* attributes are deliberately LEFT
      // ON THE ROOT. The preference outlives this control; a project switch
      // destroys and remounts the page's units, and clearing them here would
      // flash the desktop's palette and the default type on every switch.
    },
  };
}
