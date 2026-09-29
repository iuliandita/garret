export type MirrorChangesRoute = {
  theme: "light" | "dark";
  out: string;
};

/** Returns null for ordinary shot-cli arguments, leaving their parser untouched. */
export function parseMirrorChangesRoute(argv: readonly string[]): MirrorChangesRoute | null {
  if (!argv.includes("--mirror-changes")) return null;

  const [fixture, ...options] = argv;
  if (fixture !== "tiny") {
    throw new Error("--mirror-changes requires the tiny fixture");
  }

  let marker = false;
  let theme: "light" | "dark" = "dark";
  let out: string | null = null;
  let themeSeen = false;
  let outSeen = false;

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i]!;
    switch (option) {
      case "--mirror-changes":
        if (marker) throw new Error("--mirror-changes may appear only once");
        marker = true;
        break;
      case "--theme": {
        if (themeSeen) throw new Error("--theme may appear only once with --mirror-changes");
        const value = options[++i];
        if (value !== "light" && value !== "dark") {
          throw new Error("--theme with --mirror-changes must be light or dark");
        }
        theme = value;
        themeSeen = true;
        break;
      }
      case "--out": {
        if (outSeen) throw new Error("--out may appear only once with --mirror-changes");
        const value = options[++i];
        if (value === undefined || value === "" || value.startsWith("--")) {
          throw new Error("--out with --mirror-changes needs a path");
        }
        out = value;
        outSeen = true;
        break;
      }
      default:
        throw new Error(`--mirror-changes does not accept ${option}`);
    }
  }

  return { theme, out: out ?? `app/results/screenshots/change-set-${theme}-tiny.png` };
}
