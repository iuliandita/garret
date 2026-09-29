// app/harness/src/first-run.ts
// What `shot-cli --first-run` presses, parsed from the flag's optional value.
// Pure, so the three shapes -- the default, an explicit empty list, and a
// named list -- are a tested rule and not a hope about how `shot-cli` reads
// its own argv.
export const DEFAULT_FIRST_RUN_PRESSES: readonly string[] = ["menu-new-chapter", "menu-new-scene"];

/** `undefined` (the flag stood alone) is the default two presses; `"none"` is
 *  no presses at all; anything else is that comma list, TRIMMED and with
 *  empty segments dropped -- a trailing comma or a stray space around one
 *  (`--first-run "menu-new-chapter, menu-new-scene"`) must not surface as a
 *  space-prefixed or blank menu id later. A value that is `""` is refused
 *  rather than read as "no presses" -- `--first-run none` already says that,
 *  unambiguously, and a bare empty string reaching here is far more likely to
 *  be a shell quoting accident than an intent. */
export function parseFirstRun(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_FIRST_RUN_PRESSES];
  if (value === "none") return [];
  if (value === "") {
    throw new Error('--first-run wants a comma list of menu ids, or "none" for no presses; got ""');
  }
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
