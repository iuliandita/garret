// app/ui/src/theme.ts
// The writer's palette preference: which of the two palettes style.css already
// carries is used, independently of what the desktop asks for.
//
// THREE STATES, not a toggle. "system" is the default and follows
// prefers-color-scheme; a two-state control would make it unreachable once
// touched, and a preference the writer cannot get back without deleting a file
// is not a preference.
//
// The attribute this writes is the same one index.html's head script writes
// before first paint, and the same one style.css keys on. That head script
// restates the light/dark check below, deliberately: it must run before the
// stylesheet is applied, and it cannot import a module without becoming a
// second round trip in the head. Three lines, one place, named on both sides.

export type Theme = "system" | "light" | "dark";

/** In cycle order, which is also the order the button steps through. */
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Anything unrecognized is "system": the host validates what it writes, so a
 *  value arriving here that is not a theme means the injection was lost, and
 *  following the desktop is the behaviour of every build before this slice. */
export function themeFrom(value: unknown): Theme {
  return isTheme(value) ? value : "system";
}

/** "system" REMOVES the attribute rather than setting it to "system". The CSS
 *  has no rule for that value, so leaving it behind would work by accident
 *  today and stop working the moment a `[data-theme]` selector is added. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  if (theme === "system") {
    root.removeAttribute("data-theme");
    return;
  }
  root.setAttribute("data-theme", theme);
}

/** Which of the three curated palettes the theme is drawn from.
 *
 *  Spec section 17 names them: **Editorial** (Linen and Ink), the default;
 *  **Neutral** (Paper and Graphite); **Atmospheric** (Sage and Midnight).
 *
 *  ORTHOGONAL TO THE THEME, not a longer list of themes. Each family has a
 *  light half and a dark half, so a writer chooses a palette AND whether to
 *  follow the desktop - six combinations from two controls of three and three
 *  rather than one control of six, which is also why the stylesheet can express
 *  it as an override of the tokens rather than six full palettes.
 */
export type ThemeFamily = "editorial" | "neutral" | "atmospheric";

export const THEME_FAMILIES: readonly ThemeFamily[] = ["editorial", "neutral", "atmospheric"];

export function isThemeFamily(value: unknown): value is ThemeFamily {
  return typeof value === "string" && (THEME_FAMILIES as readonly string[]).includes(value);
}

/** Anything unrecognized is the default family, for the reason `themeFrom` gives
 *  for "system": the host validates what it writes, so a value arriving here
 *  that is not a family means the injection was lost - and Editorial is what
 *  every build before this slice rendered. */
export function themeFamilyFrom(value: unknown): ThemeFamily {
  return isThemeFamily(value) ? value : "editorial";
}

/** "editorial" REMOVES the attribute rather than writing its name, exactly as
 *  `applyTheme` does for "system" and for the same reason: the stylesheet
 *  carries the default family on bare `:root` and has no rule for the word, so
 *  leaving it behind works by accident today and breaks the day any
 *  `[data-family]` selector is added.
 *
 *  It also means a page whose head script did not run renders the default
 *  rather than nothing. */
export function applyThemeFamily(root: HTMLElement, family: ThemeFamily): void {
  if (family === "editorial") {
    root.removeAttribute("data-family");
    return;
  }
  root.setAttribute("data-family", family);
}

// The cycling bar button this module used to export was retired: the
// palette is now one group in the preferences panel, alongside the three
// typography axes, and `preferences.ts` states why it moved. What is left here
// is the palette's VALUES and how they reach the page, which is what index.html,
// the panel and the stylesheet all agree about.
