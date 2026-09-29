// app/ui/src/typography.ts
// How the manuscript is set: which of three stacks, at which of four sizes, over
// which of three measures.
//
// EVERY ACTUAL VALUE LIVES IN style.css. Nothing here knows what "large" is in
// pixels or what "sans" is a stack of; the three attributes this module writes
// select a rule, and the rule holds the typography. That is what keeps a font
// stack out of the preferences file and out of the IPC payload: the only thing
// that crosses from settings.json into this page is one of ten known words.
//
// The attributes are the same ones index.html's head script writes before first
// paint, which restates the value lists below. It has to: it runs before the
// stylesheet, and it cannot import a module without becoming a second round trip
// in the head. typography.test.ts parses both files and fails when the three
// statements of these lists disagree.

export type ProseFamily = "serif" | "sans" | "mono";
export type ProseSize = "small" | "medium" | "large" | "larger";
export type ProseMeasure = "narrow" | "medium" | "wide";

export interface Typography {
  family: ProseFamily;
  size: ProseSize;
  measure: ProseMeasure;
}

/** In control order, which is smallest-to-largest for the two that have one.
 *  The panel paints its buttons from these, so the order is the reading order. */
export const FAMILIES: readonly ProseFamily[] = ["serif", "sans", "mono"];
export const SIZES: readonly ProseSize[] = ["small", "medium", "large", "larger"];
export const MEASURES: readonly ProseMeasure[] = ["narrow", "medium", "wide"];

/** What every build rendered unconditionally by default. Stated here AND
 *  as the `var()` fallbacks in style.css, so a page whose injection was lost is
 *  the page shipped by default rather than an unstyled one. */
export const DEFAULT_TYPOGRAPHY: Typography = {
  family: "serif",
  size: "medium",
  measure: "medium",
};

export function isFamily(value: unknown): value is ProseFamily {
  return typeof value === "string" && (FAMILIES as readonly string[]).includes(value);
}

export function isSize(value: unknown): value is ProseSize {
  return typeof value === "string" && (SIZES as readonly string[]).includes(value);
}

export function isMeasure(value: unknown): value is ProseMeasure {
  return typeof value === "string" && (MEASURES as readonly string[]).includes(value);
}

/**
 * Narrow whatever the host injected, PER AXIS.
 *
 * One unreadable axis costs exactly itself, which is the same rule the host
 * applies when reading the file. An all-or-nothing narrowing here would mean a
 * page that lost one injected value silently rendering at the default size as
 * well - and the writer would have to set two preferences to get one back.
 */
export function typographyFrom(source: {
  family?: unknown;
  size?: unknown;
  measure?: unknown;
}): Typography {
  return {
    family: isFamily(source.family) ? source.family : DEFAULT_TYPOGRAPHY.family,
    size: isSize(source.size) ? source.size : DEFAULT_TYPOGRAPHY.size,
    measure: isMeasure(source.measure) ? source.measure : DEFAULT_TYPOGRAPHY.measure,
  };
}

/**
 * The default value is WRITTEN, not removed, which is the opposite of what
 * `applyTheme` does with "system".
 *
 * The difference is real rather than an inconsistency: "system" means *defer to
 * the desktop* and has no stylesheet rule by design, so leaving it on the root
 * would work by accident until the first `[data-theme]` selector was added.
 * "medium" is a value with a rule exactly like the others.
 */
export function applyTypography(root: HTMLElement, typography: Typography): void {
  root.setAttribute("data-prose-family", typography.family);
  root.setAttribute("data-prose-size", typography.size);
  root.setAttribute("data-prose-measure", typography.measure);
}
