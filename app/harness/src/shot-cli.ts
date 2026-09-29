// app/harness/src/shot-cli.ts
// Take a picture of the running application.
//
// IT GRADES NOTHING AND WRITES NO RESULT, exactly like smoke-cli.ts. It exists
// because the first-light slice established that a screenshot is a measurement
// this project was not taking -- a five-minute look found the navigator drawing
// its tree completely flat while advertising a correct aria-level to AT-SPI at
// 110 of 110 rows, and every outline button wrapped onto two lines. Neither is
// visible to a latency percentile, an RSS figure, a gate verdict or a role
// string, which is the entire instrument set this project had.
//
// That slice committed two screenshots and no way to take one. The next capture
// was reconstructed by hand and took half an hour; this is that half hour, made
// repeatable.
//
// FORCING A COLOUR SCHEME IS THE NON-OBVIOUS PART, and it was measured on
// 2026-08-13 rather than guessed. WebKitGTK 2.52.4 resolves
// `prefers-color-scheme` from the XDG desktop settings PORTAL
// (org.freedesktop.appearance / color-scheme) whenever the session bus is
// reachable, and at that point NEITHER `GTK_THEME` NOR `XDG_CONFIG_HOME`
// changes the page's media query at all -- the GTK chrome (form controls)
// follows them while the page does not, which looks exactly like the media
// query being broken. Only with the bus unreachable does it fall back to
// GtkSettings `gtk-application-prefer-dark-theme`. So both schemes are forced
// the same way: cut the bus, then write the GTK setting we want.
//
// Both schemes are forced, including the one the operator's desktop already
// prefers, so a capture does not depend on whose machine took it.
//
// Usage:
//   APP_GUI=1 bun app/harness/src/shot-cli.ts <tiny|normal|stress|sample> [options]
//   APP_GUI=1 bun app/harness/src/shot-cli.ts tiny --mirror-changes [--theme light|dark] [--out path]
//
// `sample` (094) resolves to `app/fixtures/sample` rather than
// `lab/fixtures/out/sample` -- see `fixture-name.ts`. It is the one fixture
// with its own real cast, synopses and appearances, built from prose rather
// than generated, so `--cast`, `--synopsis`, `--appears` and `--appears-map`
// below do NOT plant their demo data over it: each opens its panel on
// whatever `sample` already holds instead.
// Options:
//   --mirror-changes     capture the tiny fixture's readable-folder change set;
//                         accepts only --theme light|dark and --out <path>
//   --scheme light|dark   default dark
//   --out <path>          default app/results/screenshots/<date>-<label>-<fixture>.png
//   --label <name>        slice name for the default filename, default "shot"
//   --size <WxH>          seed this window size through settings.json;
//                         default leaves the host's own 1200x800. Refused
//                         below the host's floor of 640x480 (MIN_WINDOW) by
//                         name, rather than let the host clamp it and the
//                         capture lie about the size it was asked for.
//                         Widens the Xvfb screen when the size does not fit;
//                         every size that does fit keeps the shared screen,
//                         so an existing capture stays byte-identical. The
//                         window is read back after it opens, and the run
//                         fails loudly if the size does not match.
//   --find <query>        open the find panel with Ctrl+F and search for this
//   --projects            open the project panel (the Projects button)
//   --ghost-book          plant a remembered book whose file is GONE in the
//                         data home's settings, so --projects shows the missing
//                         row and its Forget control (059)
//   --menu <name>         open an application menu (file, edit, outline, help)
//   --outline-view <table|cards|reading>  open and verify a central manuscript view
//   --reference         open the selected scene as a saved reference
//   --bible-folders      nest three existing sample notes in two bible folders
//   --continuous        open the editable chapter around the selected scene
//   --continuous-next   then use Alt+PageDown to edit the next scene
//   --outline-empty      move manuscript roots into the bin in this temporary copy
//   --outline-long-synopsis  plant a long synopsis on the first scene in this copy
//   --outline-act <move-menu|drag>  with --outline-view table: open the fourth
//                        row's Move menu, or hold a drag of the fourth row over
//                        the sixth (the drop line) while capturing
//   --shortcuts           open Help > Keyboard shortcuts
//   --nav-context         open the navigator row context menu (Shift+F10 on the
//                         focused row). Keystrokes only, so it takes NO AT-SPI
//                         walk and composes with --scheme.
//   --stats               open Outline > Statistics…
//   --analytics           open Outline > Analytics…
//   --analytics-demo      open Analytics with bounded seeded observations
//   --craft-knowledge     plant one retained source and scene relationship, then open Knowledge
//   --craft-reports       use the same source and open Craft reports (combine with --press id:craft-run-report)
//   --status              open the footer's copies popover. Clicks the
//                         #status-dot button, located through AT-SPI like
//                         --hover, so it CANNOT be combined with --scheme.
//   --states-demo         mark four items, so the navigator's marks are in the
//                         picture. Planted rather than produced by use.
//   --revision-planning   plant one pass and two tasks, then open Outline >
//                         Revision state so the plan is visible.
//   --comments-demo       leave three notes on the open scene (one live, one
//                         resolved, one orphaned). Planted rather than produced
//                         by use. Does NOT open the panel: the panel covers the
//                         prose, so the underline in the manuscript and the rows
//                         in the list are two pictures and not one.
//   --review-demo         plant two review proposals on the open scene (239):
//                         Mara's with one pending change and Jonas's with two,
//                         so the proposal list's summary line is in the
//                         picture. Planted, like --comments-demo; open the
//                         panel with --menu-item outline:37.
//   --marks-demo          split the open scene's first paragraph into runs
//                         carrying strong, em and underline, so a capture shows
//                         what the three formatting controls do and what the
//                         writer's own underline looks like beside a comment
//                         anchor. Planted, like --comments-demo, and it changes
//                         no character and no position: only which runs the
//                         same text is split into. The FIRST run carries all
//                         three, but a caret alone shows nothing since 069 --
//                         see --select-word.
//   --select-word         select into the first run with Ctrl+Shift+Right, so
//                         the bubble toolbar has something non-collapsed to
//                         rest on and its buttons photograph PRESSED where
//                         --marks-demo planted them. The bubble appears 250 ms
//                         after a selection at rest, so this sleeps 600 ms
//                         past that debounce -- with margin, not measured
//                         exactly, because a rig sleeping the debounce's own
//                         length would be the one capture most likely to race
//                         it. Keystrokes only, sent through the same focus
//                         guard --menu needed, so it takes NO AT-SPI walk and
//                         composes with --scheme. Composes with --marks-demo
//                         too: the plant is a fixture step finished before the
//                         window even opens, and this selects into whatever
//                         the fixture's first run turns out to be.
//   --identities          open File > Pen names… over a PLANTED vault of two
//                         pen names, with the book pinned to the first and the
//                         private tier filled in. Two and not one: with a single
//                         identity the cross-identity check has nothing to
//                         compare against, which is the least interesting
//                         picture the report can produce. Driven by menu id, so
//                         it takes no AT-SPI walk and composes with --scheme.
//   --identities-empty    the same panel with NOTHING planted, which is the
//                         state every library is in today.
//   --identities-report   plant, open the panel, and press the report control
//                         with two Tabs and a Return. The panel's two list
//                         controls are ABOVE its list precisely so their
//                         position does not depend on how many pen names the
//                         library holds, which is what makes a counted Tab safe.
//   --warning-history     open that report without a planted pin, with one
//                         historical reason beside the current warning form.
//   --library-series      the library with planted shared series/universe membership
//   --host-error          open malformed future membership through the real command
//   --library             the library screen (100): boots with NOTHING
//                         mounted (start=home, no APP_PROJECT) over a library
//                         of three books, two pen names planted, one extra
//                         book pinned to each -- so the strip's filter hides
//                         something.
//   --library-empty       the same screen with nothing seeded at all: no
//                         fixture, no vault, no extra books.
//   --library-form        --library, then presses "New pen name…" by name
//                         through AT-SPI so the inline form is open.
//   --library-over-book   a normal seeded boot (APP_PROJECT set, a book open),
//                         then File > Library… -- the screen as a view over an
//                         open book.
//   --epub                open File > EPUB preview… (the side rail). Driven by
//                         menu id through the shared driver, so it takes no
//                         AT-SPI walk and composes with --scheme.
//   --epub-styled         the same, with the four chapter options PLANTED on,
//                         which is a second capture rather than a second state
//                         of the first.
//   --pdf                 open File > PDF proof… -- THE SAME RAIL in the other
//                         format. A whole proof is laid out by a
//                         second web view, so this waits longer than --epub.
//   --pdf-styled          the same, with the four options planted on.
//   --preview-scroll <n>  scroll the rail by n wheel notches before capturing.
//                         The ONLY way to photograph what the options do: an
//                         ornament is on a chapter and a book's chapters sit
//                         below its title page and its contents.
//   --select-last-word    after --type, select the LAST typed word backwards
//                         with Ctrl+Shift+Left (111): the bubble then rests
//                         on one word and its dictionary control is shown.
//                         Same 600 ms wait as --select-word; needs --type.
//   --type-after <text>   after --press, put the caret at the line's end and
//                         type this (111), then sleep TYPE_SETTLE_MS so the
//                         checker has drawn what it thinks of the new text.
//                         The one way to photograph whether a word just added
//                         through the bubble is still underlined when typed
//                         again. Needs --press.
//   --dict-word <word>    add this word to the project's own dictionary before
//                         the window opens, so a --type capture can show
//                         whether the checker leaves it alone. Planted, the
//                         same way --states-demo and --comments-demo are: this
//                         rig cannot click through the preferences panel's Add
//                         control, so it writes the row `dict_add` would.
//   --data-home <path>    reuse this directory as XDG_DATA_HOME instead of
//                         making a fresh one, so two invocations can share
//                         ENCHANT_CONFIG_DIR -- the one way to capture the
//                         per-project boundary a --dict-word pair by itself
//                         cannot: two runs with no shared directory prove
//                         nothing about a leak between them, because neither
//                         ever had anywhere to leak through.
//   --matter-demo         press New dedication, New foreword, New
//                         acknowledgements and New afterword, so the navigator
//                         shows both matter sections with two pages each. FOUR
//                         REAL PRESSES rather than a plant: what the picture is
//                         of is what the four items actually build. Driven
//                         through the shared menu driver, so it takes no AT-SPI
//                         walk and composes with --scheme.
//   --timeline-row         press Outline > New timeline ONCE (101), so the
//                         navigator shows the calendar-range glyph on a bible
//                         row and its one timeline underneath -- a real press,
//                         `--matter-demo`'s own argument for one over a plant.
//                         Nothing starts collapsed, so both rows are visible
//                         with no further action. Driven through the shared
//                         menu driver, so it takes no AT-SPI walk and composes
//                         with --scheme.
//   --timeline             the lanes (102) over ~12 planted events on 4
//                         tracks (one meeting, one range), seeded into a
//                         TEMP COPY of the chosen fixture so the committed
//                         one is never written into, titled "Story clock"
//                         (not "Timeline": the sample fixture's own bible
//                         note "Timeline of Events" ties with that under
//                         Quick Open's prefix rule -- RIG-FOUND). Opened
//                         through Quick Open (Ctrl+P, "Story clock",
//                         Return), then Fit, pressed by name -- ONE AT-SPI
//                         walk, so this refuses --press/--hover/--status/
//                         --scheme, same reason --cast-edit does.
//   --timeline-card        --timeline's seed, then the first planted event
//                         opened in READ mode -- a SECOND walk, so this too
//                         refuses --press/--hover/--status/--scheme.
//   --timeline-edit        --timeline-card's press, then Edit -- a THIRD
//                         walk, same refusals.
//   --timeline-empty       --timeline-row's own press (a fresh, empty
//                         timeline -- no ndjson, no tracks, no events),
//                         immediately opened through Quick Open: the empty
//                         state ("No events yet…") a book with nothing
//                         planted actually shows, which --timeline-row alone
//                         never puts on screen. No AT-SPI walk, composes
//                         with --scheme.
//   --timeline-branch      --timeline's own seed plus ONE planted branch
//                         (103, "Danse wins", forked at 0), opened and Fit
//                         exactly as --timeline. One AT-SPI walk, refuses
//                         --press/--hover/--status/--scheme.
//   --timeline-swapped     --timeline-branch's seed, then a SECOND walk
//                         pressing "Make this the one I am writing" -- the
//                         swap already having happened, not the button
//                         that starts it. Same refusals.
//   --timeline-scale       --timeline's own seed and Fit, then a SECOND
//                         walk pressing "Edit scale…", so the scale panel
//                         (103) is on screen. Same refusals.
//   --timeline-far         --timeline's own seed and Fit, then repeated
//                         presses of the SAME located Zoom out button until
//                         the planted cluster collapses into dots
//                         ("far-out with collapsed dots"). One AT-SPI walk
//                         (the button's position does not move between
//                         presses), same refusals.
//   --book-design         open File > Book design…. Nothing is planted and
//                         nothing is typed: the panel reads the OPEN PROJECT's
//                         own design, and a project nobody has designed is the
//                         state every book starts in and the one worth a
//                         picture. No AT-SPI walk, so it composes with --scheme.
//   --comments            open Edit > Comments…
//   --synopsis [<text>]   open Outline > Synopsis… on the selected row. A row
//                         with nothing written opens straight into Edit, with
//                         the caret already in the field, and <text> is typed
//                         there -- no click and no coordinate. A row that
//                         already has one opens in Read instead (097), which
//                         is what `sample`'s scenes show: this flag SUPPRESSES
//                         typing under that fixture rather than corrupting
//                         real prose with demo text. Driven through the shared
//                         menu driver, so it takes no AT-SPI walk on its own
//                         and composes with --scheme.
//   --synopsis-edit       the same as --synopsis, then presses `#synopsis-edit`
//                         so the capture shows the FIELD (097) rather than the
//                         read paragraph -- the shape a row with something
//                         already written opens in by default. Reached by ONE
//                         AT-SPI WALK, `--cast-edit`'s own mechanism. Taken
//                         LAST, right before the capture, so it cannot combine
//                         with --press, --hover, --status (another walk in the
//                         same window) or --scheme (which cuts the very bus
//                         AT-SPI needs).
//   --cast                open Outline > Cast…. PLANTS a demo cast first, one
//                         entry of which carries a PICTURE --
//                         three characters, two places and a point of interest,
//                         the first of them carrying detail fields -- because a
//                         fixture project has none and the empty state is a
//                         different picture. Then TABS ONCE to the first entry
//                         and presses Return, so the capture shows the list AND
//                         the READ SHEET (096), which opens by default on a
//                         selection. ONE TAB, not three: 096 collapsed the add
//                         row by default (it used to sit open above the list,
//                         which is what the earlier three-tab count crossed),
//                         so the panel now takes focus on itself and the very
//                         first Tab reaches the first entry regardless of how
//                         many the fixture holds. Driven through the shared
//                         menu driver and the keyboard only, so it takes no
//                         AT-SPI walk and composes with --scheme.
//   --cast-missing        the same, with the picture ROW planted and the FILE
//                         left out: the `missing` state, which is the one a
//                         writer meets when something has gone wrong and the
//                         only one whose sentence and control layout no other
//                         flag photographs.
//   --cast-deleted        mark one seeded member removed; use --press id:cast-deleted-toggle
//   --cast-empty          open the same panel with NOTHING planted, which is
//                         the state every new book is in and the one a writer
//                         meets first.
//   --cast-edit           the same as --cast, then presses `#cast-edit` so the
//                         capture shows TODAY'S FORM (096) rather than the
//                         read sheet. Reached by ONE AT-SPI WALK, the same
//                         mechanism --press already uses, rather than a
//                         further keyboard count: how many Tabs separate the
//                         selected entry from `#cast-edit` depends on how many
//                         siblings the open cast has, which `sample`'s real
//                         cast and the demo one plant in different numbers --
//                         a fixed count would be right for one and silently
//                         wrong for the other. Taken LAST, right before the
//                         capture, so it cannot combine with --press, --hover,
//                         --status (another walk in the same window) or
//                         --scheme (which cuts the very bus AT-SPI needs).
//   --appears             open Outline > Who appears here… on the selected row.
//                         PLANTS the demo cast AND a set of appearances first,
//                         so the boxes photograph both ticked and unticked -- a
//                         panel of empty boxes is a different picture and says
//                         nothing about what a tag looks like. The panel takes
//                         focus itself and needs no Tab and no coordinate.
//                         Driven through the shared menu driver, so it takes no
//                         AT-SPI walk and composes with --scheme.
//   --appears-empty       the same panel with NOTHING planted: the state a
//                         writer meets before they have a cast, where the panel
//                         has no boxes to draw and says where to go instead.
//                         COMBINES WITH --appears-map, which is the only way to
//                         photograph that panel's first empty state -- the two
//                         empty states it can be in are different sentences
//                         pointing at different panels, and a picture of one
//                         says nothing about the other.
//   --appears-map         open Outline > Who appears where…, with the same
//                         plant. The rolled-up view: a chapter shows the union
//                         of its scenes and one row is tagged DIRECTLY, so the
//                         two lines a container can carry are both in the
//                         picture.
//   --menu-item <m>:<n>   activate item n of menu m (file:0 is New project)
//   --cast-card            hover the leftmost cast match in the open scene's
//                         prose (098, W5; 105: a name OR an alias, whichever
//                         sorts first) and capture the card. Only works on
//                         the `sample` fixture: the graded fixtures carry no
//                         cast, so the plugin has nothing to mark on them.
//                         NOT `--hover`'s id-by-id mechanism: WebKitGTK
//                         exposes the whole ProseMirror editable as one
//                         AT-SPI `entry` with no child node for a bare
//                         decoration `<span>`, so this walks the entry's own
//                         text interface for the name instead, with its own
//                         longer settle -- the card is timer-driven (450ms
//                         after the pointer arrives), where a tooltip shows on
//                         `mouseenter` alone. Taken LAST, right before the
//                         capture, so it cannot combine with --press, --hover,
//                         --status (another walk in the same window) or
//                         --scheme (which cuts the very bus AT-SPI needs).
//   --cast-alias           `--cast-card`'s own walk, narrowed to hover the
//                         FIRST occurrence of a bare ALIAS -- excluding any
//                         match that is a member's own full name (105).
//                         `sample`-only, and cannot combine with --cast-card
//                         or the same three flags --cast-card refuses.
//   --hover <element-id>  put the pointer on the control with this DOM id and
//                         capture what appears. The one route to a photograph
//                         of a TOOLTIP, which is a surface no other flag can
//                         reach: it exists only while a pointer is on a
//                         control. Takes an AT-SPI walk to find the control, so
//                         like a panel capture it CANNOT be combined with
//                         --scheme (that flag works by making the session bus
//                         unreachable, and AT-SPI is on that bus) -- force the
//                         palette with --theme instead.
//   --press <selector>    find one control -- `id:<dom-id>`, `name:<accessible
//                         name>`, or a bare token (an id) -- and CLICK it
//                         immediately before capturing, so a panel section
//                         that only appears once something is pressed is
//                         finally reachable. Zero or several matches both
//                         refuse, naming the candidates: a press that landed
//                         on the wrong one of two controls sharing a name
//                         would photograph the wrong section and say nothing.
//                         Takes the same AT-SPI walk as --hover and
//                         --status, last, so it CANNOT combine with either of
//                         them or with --scheme -- force the palette with
//                         --theme instead.
//   --prefs               open the preferences panel (the Preferences button)
//   --prefs-scroll <n>    with --prefs, scroll the panel's body by n wheel
//                         notches (240), so its second section is in the
//                         picture. A real wheel over the panel, restated
//                         geometry, no walk: composes with --scheme.
//   --prose f,s,m         force the typography, e.g. mono,larger,narrow
//                         before capturing, so the panel is in the picture
//   --type <prose>        REPLACE the open scene's body with this and capture
//                         that. The two-character sequence \n starts a new
//                         paragraph. Select-all first is deliberate: the tiny
//                         fixture's prose is Hebrew and Arabic, so a capture
//                         that appended would mix scripts and say nothing about
//                         how a paragraph of the operator's sample is set.
//   --fade gone|woken     photograph what typing in focus mode does to the
//                         chrome (071): "gone" sleeps past the 1.5s arm and the
//                         1000ms fade; "woken" also moves the pointer and
//                         sleeps past the 120ms wake. Needs --modes
//                         paragraph,<typewriter> and --type <text>, because the
//                         fade only ever arms from a real keystroke while the
//                         mode is on -- refused below without both.
//   --first-run [ids]     boot an EMPTY data home -- no fixture seeded, no
//                         APP_PROJECT -- and activate each comma-separated menu
//                         item id in order once the window is up, through the
//                         shared menu driver. Bare `--first-run` presses the
//                         default two (menu-new-chapter, menu-new-scene);
//                         `--first-run none` presses nothing, so a capture of
//                         the host's own starter scene is possible; a comma
//                         list presses those ids instead. The surface every
//                         other flag here cannot reach: they all photograph a
//                         SEEDED fixture, and this is the book as a person
//                         actually meets it, before anything is in it. Refused
//                         with every flag that assumes a seeded project (see
//                         below) rather than silently seeding one.
//   --start home|last|blank
//                         plant settings.start before boot. Harmless
//                         under a seeded APP_PROJECT, which ignores it
//                         entirely -- meaningful paired with --blank below, or
//                         once a future flag boots without APP_PROJECT too.
//   --blank               the empty workspace: boots without
//                         APP_PROJECT and no fixture seeded, --first-run's own
//                         omission, and plants start=blank unless --start
//                         named a different word. Refused with --first-run
//                         and with every flag --first-run refuses, for the
//                         same reason: nothing is seeded to open a panel on.
//   --theme system|light|dark
//                         the APP's own preference, default system
//   --locale en|de         seed the application's language through settings.json;
//                         default en, including menu-driving catalog routes
//
// --scheme and --theme are two different levers and the pair of them is what
// proves the theme slice: --scheme is what the DESKTOP asks for, --theme is what
// the WRITER asked for. Set them against each other and the picture says which
// one won. The preference is delivered through an isolated XDG_DATA_HOME holding
// its own settings.json, so a capture never reads or writes the operator's real
// preferences -- and it exercises the whole path the application uses, from the
// settings file through the init script to the head script, rather than a
// shortcut only the rig has.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  CAST_CARD_SETTLE_MS,
  castHoverCandidates,
  confirmCastCardShown,
  locateCastHoverRect,
} from "./cast-hover";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinBook, plantDemoIdentities } from "./demo-vault";
import { parseFirstRun } from "./first-run";
import { resolveFixtureDir } from "./fixture-name";
import { catalogText, KEY_STEP_MS, menuChord, menuDriver, type MenuId } from "./menu-drive";
import { centreOf, locateNodes } from "./nodes";
import { assertOutlineViewShown, outlineRows, type OutlineBox, PY_OUTLINE_VIEW } from "./outline-shot-check";
import { pidListArg } from "./atspi";
import { nodeToPress, parsePressSelector, pressPoint, pressSlug, type PressSelector } from "./press-selector";
import { BIN, findWindowId, runShell } from "./shell";
import { generateTimelineCorpus } from "./timeline-corpus";
import { parseGeometry, parseSize, serverArgsFor, type Size } from "./window-size";
import { captureMirrorChanges } from "./mirror-shot";
import { parseMirrorChangesRoute } from "./mirror-shot-route";

const DIST = "app/ui/dist";
const SHOTS = "app/results/screenshots";

const mirrorChanges = parseMirrorChangesRoute(process.argv.slice(2));
if (mirrorChanges !== null) {
  if (process.env.APP_GUI !== "1") {
    console.log("APP_GUI=1 not set; screenshot skipped (needs a display and a built shell).");
  } else {
    await captureMirrorChanges(mirrorChanges);
  }
  process.exit(0);
}

/** Long enough for the page to have painted after it sinks its payload. The
 *  sink says the page is ready, not that WebKitGTK has put pixels on the X
 *  server; a capture taken immediately catches a half-painted window. */
const PAINT_SETTLE_MS = 1500;
/** xdotool type returns when X has the key events, not when WebKitGTK has
 *  turned them into document state. hand-cli.ts found 500 ms silently
 *  truncating typed text; this is the same constant every rig uses. */
const TYPE_SETTLE_MS = 2500;
const TYPE_DELAY_MS = 20;
/** The planted timeline's own title for --timeline/--timeline-card/
 *  --timeline-edit -- distinctive rather than `timeline.untitled`
 *  ("Timeline"), which the sample fixture's bible note "Timeline of
 *  Events" ties with under Quick Open's own prefix rule. See
 *  openTimelineByQuickOpen's comment for the rig run that found it. */
const SHOT_TIMELINE_TITLE = "Story clock";

/** A fixture that CARRIES a timeline (the sample since 104) is captured on
 *  its own: nothing is planted, Quick Open gets the fixture's title, and
 *  --timeline-card presses its earliest event by title. Fixtures without one
 *  (tiny, stress) keep the planted "Story clock" corpus. */
function fixtureOwnTimeline(fixtureDir: string): { title: string; firstEventTitle: string } | null {
  const path = join(fixtureDir, "timelines.ndjson");
  if (!existsSync(path)) return null;
  const first = readFileSync(path, "utf8").split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return null;
  const row = JSON.parse(first) as { title: string; body: { events: { title: string; at: number; branch: string | null }[] } };
  const main = row.body.events.filter((e) => e.branch === null).sort((a, b) => a.at - b.at);
  const earliest = main[0];
  if (earliest === undefined) throw new Error(`${path}: the fixture's timeline has no main-line event to press`);
  return { title: row.title, firstEventTitle: earliest.title };
}
/** What a press starts may be host work off the AT-SPI thread entirely -- an
 *  archive written to disk -- and there is no second walk this rig can take
 *  to poll for it finishing (one walk per capture stands). A fixed settle
 *  instead of a poll. */
const PRESS_SETTLE_MS = 3000;

type Theme = "system" | "light" | "dark";
type Locale = "en" | "de";

interface Options {
  fixture: string;
  scheme: "light" | "dark";
  theme: Theme;
  locale: Locale;
  out: string;
  find: string | null;
  projects: boolean;
  ghostBook: boolean;
  prefs: boolean;
  /** Whether --scheme was actually passed. The field above defaults to dark, so
   *  it cannot be read as "the operator asked for a scheme", and --hover has to
   *  refuse the pair rather than ignore it. */
  schemeAsked: boolean;
  /** A DOM id to put the pointer on before capturing. Null for no hover.
   *
   *  The only way to photograph a tooltip: it is painted while a pointer is on
   *  a control and at no other time, so no keystroke route and no seeded
   *  setting can produce one. The control is located through AT-SPI rather than
   *  by arithmetic because everything before it in the strip is data -- four
   *  menu titles whose widths are their words. */
  hover: string | null;
  /** A control to click, found by id or by accessible name, immediately
   *  before the capture -- the AT-SPI walk `--hover` and `--status` also
   *  take, and the same "one walk per capture" rule applies. Null for no
   *  press. */
  press: PressSelector | null;
  prose: string | null;
  /** `<focus>,<typewriter>`, seeded through settings.json. */
  modes: string | null;
  /** One of the three curated theme families, seeded through settings.json. */
  palette: string | null;
  type: string | null;
  menu: string | null;
  outlineView: "table" | "cards" | "reading" | null;
  reference: boolean;
  continuous: boolean;
  continuousNext: boolean;
  outlineEmpty: boolean;
  outlineLongSynopsis: boolean;
  outlineAct: "move-menu" | "drag" | null;
  bibleFolders: boolean;
  shortcuts: boolean;
  /** Open the navigator's context menu on the focused row.
   *
   *  Shift+Tab out of the editor into #nav, then the chord - so it is
   *  KEYSTROKES ONLY and takes no AT-SPI walk, which is what lets it compose
   *  with --scheme (that flag works by making the session bus unreachable, and
   *  AT-SPI is on that bus). A pointer route would have needed a walk to find a
   *  row, and the two would not compose. */
  navContext: boolean;
  /** Plant a few past states so the history panel can be photographed with
   *  rows in it. See plantDemoHistory. */
  historyDemo: boolean;
  /** Mark a few items with revision states so the navigator's marks are in the
   *  picture. See plantDemoStates. */
  statesDemo: boolean;
  revisionPlanning: boolean;
  craftKnowledge: boolean;
  craftReports: boolean;
  /** Plant three notes on the open scene. See plantDemoComments. */
  commentsDemo: boolean;
  /** Plant two review proposals on the open scene. See plantDemoReview. */
  reviewDemo: boolean;
  marksDemo: boolean;
  /** Select into the first run with Ctrl+Shift+Right once the window has
   *  focus, so the bubble toolbar has a non-collapsed selection to rest on.
   *  See the flag reference above for why 600 ms and why it composes with
   *  --scheme and --marks-demo. */
  selectWord: boolean;
  /** Ctrl+Shift+Left after --type, selecting the last typed word (111). */
  selectLastWord: boolean;
  /** Typed after --press, at the end of the line (111). */
  typeAfter: string | null;
  /** Add this word to the project's own dictionary before the window opens, so
   *  a capture can show what the checker does with it already there -- see
   *  plantDemoDict. Planted with `bun:sqlite`, exactly like every other demo
   *  here: this is a photograph, not a graded claim, and this rig does not
   *  import page or host source. */
  dictWord: string | null;
  /** Reuse this directory as XDG_DATA_HOME instead of making a fresh one.
   *
   *  THE ONE WAY TWO INVOCATIONS OF THIS RIG CAN SHARE `ENCHANT_CONFIG_DIR`:
   *  it is derived from XDG_DATA_HOME, and every run otherwise mkdtemps its
   *  own. Exists so a pair of captures can prove the PER-PROJECT boundary
   *  against the SAME shared directory a novelist's one machine actually has
   *  -- project A's word rendered there by one run, project B opened by a
   *  second run into that same directory and still shown misspelled, because
   *  `sync_project_dictionary` truncates rather than appends. Without this
   *  flag two "different project" captures are two different data homes as
   *  well, which proves nothing: neither run ever shared a directory with the
   *  other to leak through in the first place. */
  dataHome: string | null;
  /** The window size to seed through settings.json as `window`; null leaves
   *  the host's 1200x800 default. */
  size: Size | null;
  /** Open Outline… no: Edit > Comments…, through the shared menu driver, so it
   *  takes NO AT-SPI walk and composes with --scheme. Separate from the plant
   *  because the panel COVERS the prose it is about, so the decorated passage
   *  and the list are two captures. */
  comments: boolean;
  /** Open the history panel and put ONE version's diff on screen.
   *
   *  A comparison is the surface this feature added and nothing else can photograph it:
   *  --menu-item edit:N opens the panel, and the panel opens with no diff in
   *  it, correctly. Implies the panel, so a capture cannot ask for a diff and
   *  get a closed panel. */
  compare: boolean;
  /** Open Outline > Statistics…. Driven through the shared menu driver, so it
   *  takes NO AT-SPI walk and composes with --scheme. */
  stats: boolean;
  analytics: boolean;
  analyticsDemo: boolean;
  /** Click the footer's status dot so its popover is in the picture. */
  status: boolean;
  /** Open Outline > Synopsis… on the selected row, and the text to type into
   *  it. Null when the flag was not passed; an EMPTY STRING is a deliberate
   *  capture of the empty state, which is a different picture and one a writer
   *  meets first. Driven through the shared menu driver, so it takes NO AT-SPI
   *  walk and composes with --scheme. */
  synopsis: string | null;
  /** The same open as --synopsis, then presses `#synopsis-edit` (097) by an
   *  AT-SPI walk rather than a further keyboard count -- `--cast-edit`'s own
   *  reason: Read is the panel's default on a row that has anything written,
   *  and this is the flag that shows the field underneath it instead. */
  synopsisEdit: boolean;
  /** Open File > Book design…. NOTHING IS PLANTED: the panel paints the
   *  built-in default for a project nobody has designed, which is the state
   *  every book starts in. */
  bookDesign: boolean;
  /** Open File > Covers…, and whether to plant a cover on each side before the
   *  window opens. Two flags rather than one optional argument, for --cast's
   *  reason: the difference is whether the store has anything in it, and that
   *  is decided before the process starts. */
  covers: boolean;
  coversEmpty: boolean;
  /** Open `File > Pen names…` over a planted vault of two identities, with the
   *  book pinned to the first. */
  identities: boolean;
  /** The same, with nothing planted: the state every library is in today. */
  identitiesEmpty: boolean;
  /** Press the report control on that panel, so the export report is what the
   *  picture holds. */
  identitiesReport: boolean;
  warningHistory: boolean;
  identitiesEdit: boolean;
  identitiesRepin: boolean;
  /** The library screen (100): boots with nothing mounted and `start=home`,
   *  a library of three books, two pen names planted and two of the three
   *  books pinned one each -- so the strip's filter has something to hide. */
  library: boolean;
  /** The screen with NOTHING seeded at all: no fixture, no vault, no extra
   *  books -- the empty state a brand-new library shows. */
  libraryEmpty: boolean;
  /** `--library`, then presses "New pen name…" so the inline form is open. */
  libraryForm: boolean;
  /** A normal seeded boot (a book open via APP_PROJECT), with File > Library…
   *  pressed afterwards -- the screen as a view over an open book. */
  libraryOverBook: boolean;
  librarySeries: boolean;
  hostError: boolean;
  /** Which book the side rail is opened on, or null for no rail. ONE RAIL,
   *  TWO FORMATS: the menu item differs and nothing else does. */
  previewFormat: "epub" | "pdf" | null;
  /** The same, with all four styling options turned on first. */
  previewStyled: boolean;
  /** How far to scroll the preview before capturing, in wheel notches. */
  previewScroll: number;
  /** The same for the preferences panel's body (240). */
  prefsScroll: number;
  /** Plant, open the panel, and press the front cover's View full size. TWO
   *  TABS AND A RETURN rather than a coordinate: the panel takes focus itself,
   *  so the first Tab reaches Change cover… and the second View full size --
   *  which needs no AT-SPI walk and therefore composes with --scheme. */
  coversFull: boolean;
  matterDemo: boolean;
  /** Press Outline > New timeline once (101), so the navigator shows the
   *  bible's calendar-range glyph on a real row a create actually built --
   *  `matterDemo`'s own argument for a press over a plant. Nothing is
   *  collapsed by default (`navigator/index.ts`'s `collapsed` set starts
   *  empty), so the freshly made bible root and its one timeline are both
   *  visible with no further action -- no AT-SPI walk, no expand. */
  timelineRow: boolean;
  /** The lanes on ~12 planted events over 4 tracks (one meeting, one range),
   *  seeded through the ndjson path (timeline-corpus.ts's own generator,
   *  restated small) into a TEMP COPY of the chosen fixture -- the
   *  committed fixture is never written into. Opened by clicking the row's
   *  computed position (no AT-SPI walk: the same arithmetic bible-cli.ts
   *  uses for a reserved-root child), then Fit through one walk so the
   *  whole planted document is framed. */
  timeline: boolean;
  /** `--timeline`'s seed, then one more press: the first planted event, by
   *  name, opening its card in READ mode. */
  timelineCard: boolean;
  /** `--timeline-card`'s press, then Edit, in the SAME walk (`nodeToPress`
   *  is a pure lookup over one `locateNodes` call, so both controls come
   *  from one walk regardless of how many of them this branch presses). */
  timelineEdit: boolean;
  /** `--timeline-row`'s own press (a fresh, empty timeline, no ndjson),
   *  immediately followed by opening it -- the empty state
   *  ("No events yet…") is what a book with nothing planted actually shows,
   *  and `--timeline-row` alone never opens what it creates. */
  timelineEmpty: boolean;
  /** `--timeline`'s own small corpus, plus ONE planted branch (103) forked
   *  at the corpus's own zero, so the dashed lane group under the main
   *  lanes has something to draw. Opened and Fit exactly as `--timeline`. */
  timelineBranch: boolean;
  /** `--timeline-branch`'s seed, then a SECOND walk pressing "Make this the
   *  one I am writing" on the planted branch -- the swap the design record
   *  calls out as its own capture ("a branch as the one being written"). */
  timelineSwapped: boolean;
  /** `--timeline`'s own seed and Fit, then a SECOND walk pressing "Edit
   *  scale…" so the scale panel (103) is the thing on screen. */
  timelineScale: boolean;
  /** `--timeline`'s own seed and Fit, then repeated presses of Zoom out
   *  (the SAME walk's button, no new lookup between presses -- its
   *  position does not move while only the lanes repaint) until the
   *  planted cluster collapses into dots -- "far-out with collapsed dots",
   *  design section 5's own capture. */
  timelineFar: boolean;
  /** Open Outline > Cast…, and whether to plant a demo cast before the window
   *  opens. Two flags rather than one optional argument, unlike --synopsis,
   *  because the difference is not what gets typed: it is whether the store has
   *  anything in it, and that is decided before the process starts. */
  cast: boolean;
  castEmpty: boolean;
  castDeleted: boolean;
  /** The same plant and selection as --cast, then presses `#cast-edit` (096)
   *  by an AT-SPI walk rather than a further keyboard count -- see the flag's
   *  own help text for why a fixed Tab count cannot cross fixtures here. */
  castEdit: boolean;
  /** Hover the FIRST cast mark in the open scene's prose (098, W5) and
   *  capture the card. `sample`-only -- see the flag's own help text. */
  castCard: boolean;
  /** Hover the FIRST occurrence of a bare ALIAS -- not a member's own name --
   *  in the open scene's prose (105) and capture the card. `sample`-only,
   *  `castCard`'s own reason: the leftmost cast match; here narrowed to the
   *  alias family. */
  castAlias: boolean;
  /** Open Outline > Who appears here…, and whether to plant. */
  appears: boolean;
  appearsEmpty: boolean;
  /** Open Outline > Who appears where…. */
  appearsMap: boolean;
  /** Plant the picture ROW and not the FILE, so the capture is the `missing`
   *  state: the one a writer meets when something has gone wrong, and the one
   *  whose sentence and control layout nothing else photographs. */
  castMissing: boolean;
  menuItem: string | null;
  /** Photograph the chrome fade (071): "gone" past the hide, "woken" past a
   *  subsequent pointer displacement too. Null for no --fade. */
  fade: "gone" | "woken" | null;
  /** The menu item ids to activate in order on a fresh, unseeded data home.
   *  Null for no --first-run at all; see `parseFirstRun` for what an absent,
   *  `"none"`, or a named value means. */
  firstRun: string[] | null;
  /** `settings.start` to plant before boot: "home" | "last" | "blank".
   *  Null leaves the field out of settings.json entirely, which the host
   *  reads as its own default. */
  start: "home" | "last" | "blank" | null;
  /** The empty-workspace capture: boots without `APP_PROJECT`, the
   *  SAME omission `--first-run` already makes, and plants `start: "blank"`
   *  unless `--start` named a different word. Seeds no project either, for
   *  `--first-run`'s own reason: the empty workspace is the one thing worth
   *  photographing here, and a seeded fixture nothing opens would be a
   *  picture of the fixture rather than of that. */
  blank: boolean;
}

/** The flag's menu names, by the id `menu-bar.ts` gives each menu. The chord
 *  is NOT restated here: since 088 the letter is a catalog value, and a
 *  restated letter that stopped matching would deliver the chord and the
 *  Downs and Return after it into the focused editor, and still capture. So
 *  it is read through `menuChord`, from the source that decides it. */
const MENU_IDS = new Map<string, MenuId>([
  ["file", "menu-file"],
  ["edit", "menu-edit"],
  ["outline", "menu-outline"],
  ["help", "menu-help"],
]);

function parseArgs(argv: string[]): Options {
  const [fixture, ...rest] = argv;
  if (fixture === undefined) {
    throw new Error(
      "usage: shot-cli.ts <tiny|normal|stress> [--scheme light|dark] [--out path] [--size WxH]",
    );
  }
  let scheme: "light" | "dark" = "dark";
  let schemeAsked = false;
  // system, so a capture that says nothing about the theme is the application
  // as every build before the theme slice behaved.
  let theme: Theme = "system";
  let locale: Locale = "en";
  let out: string | null = null;
  let label = "shot";
  let find: string | null = null;
  let projects = false;
  let ghostBook = false;
  let prefs = false;
  let hover: string | null = null;
  let press: PressSelector | null = null;
  let prose: string | null = null;
  let modes: string | null = null;
  let palette: string | null = null;
  let type: string | null = null;
  let menu: string | null = null;
  let outlineView: "table" | "cards" | "reading" | null = null;
  let reference = false;
  let continuous = false;
  let continuousNext = false;
  let outlineEmpty = false;
  let bibleFolders = false;
  let outlineLongSynopsis = false;
  let outlineAct: "move-menu" | "drag" | null = null;
  let shortcuts = false;
  let navContext = false;
  let historyDemo = false;
  let statesDemo = false;
  let revisionPlanning = false;
  let craftKnowledge = false;
  let craftReports = false;
  let commentsDemo = false;
  let reviewDemo = false;
  let marksDemo = false;
  let selectWord = false;
  let selectLastWord = false;
  let typeAfter: string | null = null;
  let dictWord: string | null = null;
  let dataHomeOverride: string | null = null;
  let comments = false;
  let synopsis: string | null = null;
  let synopsisEdit = false;
  let bookDesign = false;
  let covers = false;
  let coversEmpty = false;
  let identities = false;
  let identitiesEmpty = false;
  let identitiesReport = false;
  let warningHistory = false;
  let identitiesEdit = false;
  let identitiesRepin = false;
  let library = false;
  let libraryEmpty = false;
  let libraryForm = false;
  let libraryOverBook = false;
  let librarySeries = false;
  let hostError = false;
  let previewFormat: "epub" | "pdf" | null = null;
  let previewStyled = false;
  let previewScroll = 0;
  let prefsScroll = 0;
  let coversFull = false;
  let matterDemo = false;
  let timelineRow = false;
  let timeline = false;
  let timelineCard = false;
  let timelineEdit = false;
  let timelineEmpty = false;
  let timelineBranch = false;
  let timelineSwapped = false;
  let timelineScale = false;
  let timelineFar = false;
  let cast = false;
  let castEmpty = false;
  let castDeleted = false;
  let castEdit = false;
  let castCard = false;
  let castAlias = false;
  let appears = false;
  let appearsEmpty = false;
  let appearsMap = false;
  let castMissing = false;
  let compare = false;
  let stats = false;
  let analytics = false;
  let analyticsDemo = false;
  let status = false;
  let menuItem: string | null = null;
  let fade: "gone" | "woken" | null = null;
  let firstRun: string[] | null = null;
  let start: "home" | "last" | "blank" | null = null;
  let blank = false;
  let size: Size | null = null;
  // An explicit index rather than `i += 2`: --projects is the only flag here
  // that takes no argument, and a fixed stride would make it swallow whichever
  // flag followed it -- silently, since the swallowed one would simply not take
  // effect and the capture would still be written.
  let i = 0;
  while (i < rest.length) {
    const flag = rest[i];
    if (flag === "--outline-empty") { outlineEmpty = true; i += 1; continue; }
    if (flag === "--bible-folders") { bibleFolders = true; i += 1; continue; }
    if (flag === "--outline-long-synopsis") { outlineLongSynopsis = true; i += 1; continue; }
    if (flag === "--outline-act") {
      const value = rest[i + 1];
      if (value !== "move-menu" && value !== "drag") throw new Error(`--outline-act wants move-menu or drag, not ${String(value)}`);
      outlineAct = value; i += 2; continue;
    }
    if (flag === "--reference") { reference = true; i += 1; continue; }
    if (flag === "--continuous") { continuous = true; i += 1; continue; }
    if (flag === "--continuous-next") { continuous = true; continuousNext = true; i += 1; continue; }
    if (flag === "--projects") {
      projects = true;
      i += 1;
      continue;
    }
    if (flag === "--ghost-book") {
      ghostBook = true;
      i += 1;
      continue;
    }
    if (flag === "--prefs") {
      prefs = true;
      i += 1;
      continue;
    }
    if (flag === "--prefs-scroll") {
      const n = Number(rest[i + 1]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--prefs-scroll needs a positive whole number of notches");
      prefsScroll = n;
      i += 2;
      continue;
    }
    // Takes no argument, so it belongs HERE and not in the switch below: that
    // path has already stepped past a value, and a boolean placed there eats
    // whichever flag follows it. Silently - the swallowed flag just does not
    // take effect and the capture is still written.
    if (flag === "--shortcuts") {
      shortcuts = true;
      i += 1;
      continue;
    }
    // Boolean, so ABOVE the switch for the same reason: one placed below has
    // already stepped past a value and eats whichever flag follows it,
    // silently, because the swallowed flag simply does not take effect and the
    // capture is still written.
    if (flag === "--nav-context") {
      navContext = true;
      i += 1;
      continue;
    }
    // Same rule: a boolean flag belongs above the switch, or it eats the flag
    // after it.
    if (flag === "--history-demo") {
      historyDemo = true;
      i += 1;
      continue;
    }
    // Boolean, so ABOVE the switch: one placed below has already stepped past a
    // value and eats whichever flag follows it - silently, because the swallowed
    // flag simply does not take effect and the capture is still written.
    if (flag === "--states-demo") {
      statesDemo = true;
      i += 1;
      continue;
    }
    if (flag === "--revision-planning") {
      revisionPlanning = true;
      i += 1;
      continue;
    }
    if (flag === "--craft-knowledge" || flag === "--craft-reports") {
      if (flag === "--craft-knowledge") craftKnowledge = true;
      else craftReports = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch for the same reason as the ones above it: a
    // boolean placed in the switch has already stepped past a value and eats
    // whichever flag follows it, silently.
    if (flag === "--comments-demo") {
      commentsDemo = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    if (flag === "--review-demo") {
      reviewDemo = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    if (flag === "--marks-demo") {
      marksDemo = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    if (flag === "--select-word") {
      selectWord = true;
      i += 1;
      continue;
    }
    if (flag === "--select-last-word") {
      selectLastWord = true;
      i += 1;
      continue;
    }
    if (flag === "--synopsis") {
      // ONE INSTRUCTION FOR THE FIELD (097 review, ticket 06): a preceding
      // `--synopsis-edit` already decided what this open shows and forced
      // `synopsis` to the empty capture -- a `--synopsis <text>` after it
      // would silently discard that decision rather than compose with it.
      if (synopsisEdit) {
        throw new Error(
          "--synopsis cannot follow --synopsis-edit: two instructions for the same field.",
        );
      }
      // The text is OPTIONAL: `--synopsis` on its own captures the empty state.
      // A following argument that starts with `--` is the next flag, not the
      // body, which is what lets the two be told apart without a sentinel.
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        synopsis = "";
        i += 1;
      } else {
        synopsis = next;
        i += 2;
      }
      continue;
    }
    if (flag === "--synopsis-edit") {
      // THE OTHER DIRECTION of the same refusal: `synopsis !== null` means an
      // earlier `--synopsis` already set what this open types, and forcing it
      // to "" here would overwrite that silently rather than refuse the pair.
      if (synopsis !== null) {
        throw new Error(
          "--synopsis-edit cannot follow --synopsis: two instructions for the same field.",
        );
      }
      synopsis = "";
      synopsisEdit = true;
      i += 1;
      continue;
    }
    if (flag === "--first-run") {
      // OPTIONAL, the same way --synopsis's text is: a following argument
      // that starts with `--` is the next flag, not the press list, which is
      // what lets a bare `--first-run` be told apart from `--first-run
      // menu-new-scene` without a sentinel. `parseFirstRun` reads the value
      // itself, including the `undefined` default and the `"none"` empty
      // list.
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        firstRun = parseFirstRun(undefined);
        i += 1;
      } else {
        firstRun = parseFirstRun(next);
        i += 2;
      }
      continue;
    }
    if (flag === "--start") {
      const next = rest[i + 1];
      if (next !== "home" && next !== "last" && next !== "blank") {
        throw new Error(`--start wants "home", "last" or "blank", got ${JSON.stringify(next)}`);
      }
      start = next;
      i += 2;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    if (flag === "--blank") {
      blank = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    if (flag === "--book-design") {
      bookDesign = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    // THE ONLY WAY TO PHOTOGRAPH WHAT THE FOUR OPTIONS DO. An ornament and a
    // drop cap are on a CHAPTER, and a book's chapters sit below its title page
    // and its contents -- so a capture of the top of the preview shows the
    // controls and none of their effect.
    if (flag === "--preview-scroll") {
      const raw = rest[i + 1];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 1) {
        throw new Error("--preview-scroll needs a positive whole number of notches");
      }
      previewScroll = n;
      i += 2;
      continue;
    }
    if (flag === "--epub") {
      previewFormat = "epub";
      i += 1;
      continue;
    }
    // THE FOUR OPTIONS ON, and it is a second capture rather than a second
    // state of the first for --comments-demo's recorded reason: a picture of
    // the plainest book and a picture of an ornamented one are two things a
    // reader has to compare, and one picture cannot be both.
    if (flag === "--epub-styled") {
      previewFormat = "epub";
      previewStyled = true;
      i += 1;
      continue;
    }
    // 044. THE SAME RAIL IN THE OTHER FORMAT, which is why these are two flags
    // on one mechanism rather than two capture routes: the menu item differs
    // and nothing else does.
    if (flag === "--pdf") {
      previewFormat = "pdf";
      i += 1;
      continue;
    }
    if (flag === "--pdf-styled") {
      previewFormat = "pdf";
      previewStyled = true;
      i += 1;
      continue;
    }
    if (flag === "--identities") {
      identities = true;
      i += 1;
      continue;
    }
    if (flag === "--identities-empty") {
      identitiesEmpty = true;
      i += 1;
      continue;
    }
    if (flag === "--identities-report") {
      identities = true;
      identitiesReport = true;
      i += 1;
      continue;
    }
    if (flag === "--warning-history") {
      warningHistory = true;
      i += 1;
      continue;
    }
    if (flag === "--identities-edit") {
      identities = true;
      identitiesEdit = true;
      i += 1;
      continue;
    }
    if (flag === "--identities-repin") {
      identities = true;
      identitiesRepin = true;
      i += 1;
      continue;
    }
    if (flag === "--library-series") { librarySeries = true; library = true; i += 1; continue; }
    if (flag === "--host-error") { hostError = true; libraryOverBook = true; i += 1; continue; }
    if (flag === "--library") {
      library = true;
      i += 1;
      continue;
    }
    if (flag === "--library-empty") {
      libraryEmpty = true;
      i += 1;
      continue;
    }
    if (flag === "--library-form") {
      library = true;
      libraryForm = true;
      i += 1;
      continue;
    }
    if (flag === "--library-over-book") {
      libraryOverBook = true;
      i += 1;
      continue;
    }
    if (flag === "--covers") {
      covers = true;
      i += 1;
      continue;
    }
    if (flag === "--covers-empty") {
      coversEmpty = true;
      i += 1;
      continue;
    }
    if (flag === "--covers-full") {
      covers = true;
      coversFull = true;
      i += 1;
      continue;
    }
    if (flag === "--matter-demo") {
      matterDemo = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-row") {
      timelineRow = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline") {
      timeline = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-card") {
      timelineCard = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-edit") {
      timelineEdit = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-empty") {
      timelineEmpty = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-branch") {
      timelineBranch = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-swapped") {
      timelineSwapped = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-scale") {
      timelineScale = true;
      i += 1;
      continue;
    }
    if (flag === "--timeline-far") {
      timelineFar = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch: same rule again.
    if (flag === "--comments") {
      comments = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch for the same reason as the flags around it.
    if (flag === "--cast") {
      cast = true;
      i += 1;
      continue;
    }
    if (flag === "--cast-missing") {
      cast = true;
      castMissing = true;
      i += 1;
      continue;
    }
    if (flag === "--cast-edit") {
      cast = true;
      castEdit = true;
      i += 1;
      continue;
    }
    // NOT `cast = true`: this flag never opens the panel at all -- it hovers
    // the mark already in the prose, so the picture is the manuscript, not
    // the sheet. Boolean, so above the switch for the same reason as the
    // flags around it.
    if (flag === "--cast-card") {
      castCard = true;
      i += 1;
      continue;
    }
    // NOT `cast = true`, `--cast-card`'s own reason.
    if (flag === "--cast-alias") {
      castAlias = true;
      i += 1;
      continue;
    }
    if (flag === "--appears") {
      appears = true;
      i += 1;
      continue;
    }
    if (flag === "--appears-empty") {
      appearsEmpty = true;
      i += 1;
      continue;
    }
    if (flag === "--appears-map") {
      appearsMap = true;
      i += 1;
      continue;
    }
    if (flag === "--cast-deleted") {
      cast = true;
      castDeleted = true;
      i += 1;
      continue;
    }
    if (flag === "--cast-empty") {
      castEmpty = true;
      i += 1;
      continue;
    }
    // Boolean, so above the switch for the same reason as the three above it.
    if (flag === "--compare") {
      compare = true;
      i += 1;
      continue;
    }
    // And again. A boolean placed in the switch below has already stepped past
    // a value, so it eats whichever flag follows it - silently, since the
    // swallowed one simply does not take effect and the capture is still
    // written.
    if (flag === "--stats") {
      stats = true;
      i += 1;
      continue;
    }
    if (flag === "--analytics") {
      analytics = true;
      i += 1;
      continue;
    }
    if (flag === "--analytics-demo") {
      analytics = true;
      analyticsDemo = true;
      i += 1;
      continue;
    }
    if (flag === "--status") {
      status = true;
      i += 1;
      continue;
    }
    const value = rest[i + 1];
    i += 2;
    if (value === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case "--scheme":
        if (value !== "light" && value !== "dark") {
          throw new Error(`--scheme must be light or dark, not ${value}`);
        }
        scheme = value;
        schemeAsked = true;
        break;
      case "--theme":
        if (value !== "system" && value !== "light" && value !== "dark") {
          throw new Error(`--theme must be system, light or dark, not ${value}`);
        }
        theme = value;
        break;
      case "--locale":
        if (value !== "en" && value !== "de") {
          throw new Error(`--locale must be en or de, not ${value}`);
        }
        locale = value;
        break;
      case "--out":
        out = value;
        break;
      case "--label":
        label = value;
        break;
      case "--find":
        find = value;
        break;
      case "--menu":
        // Opened with Alt+<key>, so this needs NO AT-SPI walk and composes with
        // --scheme. As of the retirement slice so do --projects and --prefs,
        // which used to locate a toggle through the accessibility tree and are
        // now keystrokes through the same menu.
        if (!MENU_IDS.has(value)) {
          throw new Error(`--menu must be one of ${[...MENU_IDS.keys()].join(", ")}, not ${value}`);
        }
        menu = value;
        break;
      case "--outline-view":
        if (value !== "table" && value !== "cards" && value !== "reading") throw new Error(`--outline-view wants table, cards or reading, not ${value}`);
        outlineView = value;
        break;
      case "--menu-item": {
        // <menu>:<index>. Activating a menu item is the ONE route this rig
        // could not take, and it is the route the help panel was broken on:
        // the item ran, the menu closed, and the surface it was supposed to
        // open was not in the document. Every panel here has a BUTTON that
        // opens it too, and capturing through the button says nothing about
        // the menu.
        const [name = "", index = ""] = value.split(":");
        if (!MENU_IDS.has(name)) {
          throw new Error(`--menu-item's menu must be one of ${[...MENU_IDS.keys()].join(", ")}, not ${name}`);
        }
        if (!/^\d+$/.test(index)) throw new Error(`--menu-item needs <menu>:<index>, not ${value}`);
        menuItem = value;
        break;
      }
      case "--type":
        type = value;
        break;
      case "--fade":
        if (value !== "gone" && value !== "woken") {
          throw new Error(`--fade must be gone or woken, not ${value}`);
        }
        fade = value;
        break;
      case "--dict-word":
        dictWord = value;
        break;
      case "--type-after":
        typeAfter = value;
        break;
      case "--data-home":
        dataHomeOverride = value;
        break;
      case "--palette":
        palette = value;
        break;
      case "--size":
        size = parseSize(value);
        break;
      case "--modes":
        // <focus>,<typewriter>, e.g. "paragraph,on". Not validated here for the
        // same reason --prose is not: the host refuses an unknown spelling and
        // the settings file is read leniently, so a typo renders the default
        // rather than failing the capture, and the filename records what was
        // asked for.
        modes = value;
        break;
      case "--hover":
        // A DOM id, matched against the `id:` object attribute AT-SPI carries.
        // Not validated here: nothing in this file knows what ids the page has,
        // and the run fails loudly below when the walk cannot find one.
        hover = value;
        break;
      case "--press":
        // Parsed here so a malformed selector fails before the window opens,
        // rather than after the walk has already been spent finding out.
        press = parsePressSelector(value);
        break;
      case "--prose":
        // Not validated here: the host refuses an unknown spelling when the
        // page asks it to, and the settings file this writes is read leniently,
        // so a typo renders the default rather than failing the capture. The
        // capture is the record of what was asked for, and its filename says.
        prose = value;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  // Date from the clock rather than a flag: a screenshot's filename is the only
  // record of when it was taken, and the committed ones are named by date.
  //
  // LOCAL date, not `toISOString().slice(0, 10)`. That is UTC, so every capture
  // taken between midnight and the UTC offset is stamped with the previous day
  // -- which this rig did on its first run, at 00:10 local.
  const now = new Date();
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const sizeTag = size === null ? "" : `${size.width}x${size.height}-`;
  const pressTag = press === null ? "" : `press-${pressSlug(press)}-`;
  const firstRunTag = firstRun === null ? "" : "first-run-";
  // No fixture was seeded, so no fixture segment names one: a filename ending
  // in "-tiny" would say this book came from a fixture it never touched.
  const fixtureTag = firstRun === null ? `-${fixture}` : "";
  return {
    fixture,
    scheme,
    schemeAsked,
    theme,
    locale,
    find,
    type,
    projects,
    ghostBook,
    prefs,
    hover,
    press,
    prose,
    modes,
    palette,
    menu,
    outlineView,
    reference,
    continuous,
    continuousNext,
    outlineEmpty,
    outlineLongSynopsis,
    outlineAct,
    bibleFolders,
    shortcuts,
    navContext,
    historyDemo,
    statesDemo,
    revisionPlanning,
    craftKnowledge,
    craftReports,
    commentsDemo,
    reviewDemo,
    marksDemo,
    selectWord,
    selectLastWord,
    typeAfter,
    dictWord,
    dataHome: dataHomeOverride,
    size,
    comments,
    synopsis,
    synopsisEdit,
    bookDesign,
    covers,
    coversEmpty,
    identities,
    identitiesEmpty,
    identitiesReport,
    warningHistory,
    identitiesEdit,
    identitiesRepin,
    library,
    libraryEmpty,
    libraryForm,
    libraryOverBook,
    librarySeries,
    hostError,
    previewFormat,
    previewStyled,
    previewScroll,
    prefsScroll,
    coversFull,
    matterDemo,
    timelineRow,
    timeline,
    timelineCard,
    timelineEdit,
    timelineEmpty,
    timelineBranch,
    timelineSwapped,
    timelineScale,
    timelineFar,
    cast,
    castEmpty,
    castDeleted,
    castEdit,
    castCard,
    castAlias,
    castMissing,
    appears,
    appearsEmpty,
    appearsMap,
    compare,
    stats,
    analytics,
    analyticsDemo,
    status,
    menuItem,
    fade,
    firstRun,
    start,
    blank,
    // The theme goes in the name only when it was asked for: a filename that
    // said "system" on every historical capture would imply the earlier ones
    // had chosen it. The size, the press and --first-run, the same way:
    // present in the name only when asked, so an existing default-named
    // capture keeps meaning what it always meant.
    out:
      out ??
      join(
        SHOTS,
        theme === "system"
          ? `${day}-${label}-${sizeTag}${pressTag}${firstRunTag}${scheme}${fixtureTag}.png`
          : `${day}-${label}-${sizeTag}${pressTag}${firstRunTag}${scheme}desktop-${theme}app${fixtureTag}.png`,
      ),
  };
}

/** A GTK config directory expressing one colour-scheme preference.
 *
 *  Written per run rather than shipped, so the rig has no state on disk between
 *  runs and nothing to keep in sync with the operator's own settings. */
function gtkConfig(scheme: "light" | "dark"): string {
  const dir = mkdtempSync(join(tmpdir(), `app-gtk-${scheme}-`));
  mkdirSync(join(dir, "gtk-3.0"), { recursive: true });
  writeFileSync(
    join(dir, "gtk-3.0", "settings.ini"),
    `[Settings]\ngtk-theme-name=Adwaita\ngtk-application-prefer-dark-theme=${
      scheme === "dark" ? 1 : 0
    }\n`,
  );
  return dir;
}

/** A data directory holding one settings.json, which is where the application
 *  reads the writer's palette preference from.
 *
 *  Isolated per run for two reasons: a capture must not write to the operator's
 *  real preferences, and it must not READ them either -- a rig that inherited
 *  the operator's theme would produce a different picture on a different
 *  machine. The path through settings.json is also the whole point: the
 *  application is exercised exactly as a launch exercises it. */
function dataHome(
  theme: Theme,
  locale: Locale,
  prose: string | null,
  modes: string | null,
  palette: string | null,
  windowSize: Size | null,
  // Reuses this directory instead of making one, so a second invocation can
  // point the app's XDG_DATA_HOME -- and so ENCHANT_CONFIG_DIR, which is
  // derived from it -- at the same place a first invocation used. See
  // Options.dataHome.
  reuse?: string,
): string {
  const dir = reuse ?? mkdtempSync(join(tmpdir(), `app-data-${theme}-`));
  mkdirSync(join(dir, "cc.local.app"), { recursive: true });
  const [family, size, measure] = (prose ?? "").split(",");
  const typography =
    prose === null ? {} : { typography: { family, size, measure } };
  // Through the SETTINGS FILE, like every other preference this rig sets, so
  // the writing modes are applied by the head script before first paint - which
  // is the thing worth photographing. Driving the panel instead would capture
  // the modes as applied on mount, a route the head script exists to make
  // unnecessary.
  const [focus, typewriter] = (modes ?? "").split(",");
  const writing = modes === null ? {} : { writing_modes: { focus, typewriter } };
  // Through the settings file for the same reason as the rest: the family is
  // applied by the head script before first paint, which is what a capture of a
  // palette has to photograph.
  const paletteField = palette === null ? {} : { theme_family: palette };
  // Seeded through settings.json like everything above: the host reads
  // `window` at window creation, before first paint, which is what a capture
  // under width pressure has to photograph.
  const windowField = windowSize === null ? {} : { window: windowSize };
  writeFileSync(
    join(dir, "cc.local.app", "settings.json"),
    JSON.stringify({ theme, locale, ...typography, ...writing, ...paletteField, ...windowField }),
  );
  return dir;
}

function xdo(display: string, args: string[]): string {
  const proc = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

// --scheme works by making the session bus unreachable, because WebKitGTK reads
// the XDG settings portal first and the portal is on that bus. AT-SPI is on the
// same bus, so a capture that forces the DESKTOP scheme cannot also locate a
// widget: the probe reports "not exactly one matching application" and the run
// dies with an exit code that says nothing about the cause.
//
// Refused with the explanation rather than left to fail: --theme forces the
// APP's palette without touching the bus, and is what a panel capture wants.
function refuseUndrivableCombination(o: Options): void {
  if (o.craftKnowledge && o.craftReports) throw new Error("choose one craft panel per capture");
  if ((o.craftKnowledge || o.craftReports) && o.schemeAsked) throw new Error("craft panel captures need the accessibility bus: use --theme instead of --scheme");
  if ((o.hostError || o.warningHistory) && (o.press !== null || o.hover !== null || o.status || o.schemeAsked))
    throw new Error("host error and warning-history captures require one connected accessibility walk");
  if (o.continuous && o.outlineView !== null) throw new Error("--continuous and --outline-view select different central views");
  if (o.outlineView !== null || o.analytics) {
    const view = o.analytics ? "--analytics" : "--outline-view";
    if (o.schemeAsked) throw new Error(`${view} cannot be combined with --scheme: use --theme so AT-SPI can verify the view.`);
    const anotherWalk = o.status || o.hover !== null || o.press !== null || o.castEdit || o.castCard || o.castAlias || o.synopsisEdit || o.libraryForm || o.timeline || o.timelineCard || o.timelineEdit || o.timelineBranch || o.timelineSwapped || o.timelineScale || o.timelineFar || o.warningHistory || o.hostError || (o.analytics && o.outlineView !== null);
    if (anotherWalk) throw new Error(`${view} cannot be combined with another AT-SPI walk in one capture.`);
  }
  if (o.blank && o.firstRun !== null) {
    throw new Error(
      "--blank cannot be combined with --first-run: one photographs nothing " +
        "open, the other presses menu items on the starter book --first-run " +
        "itself creates.",
    );
  }
  // --scheme WITH --projects or --prefs used to be refused here. It no longer
  // has to be: both panels are opened by keystrokes through the menu, so
  // neither needs the session bus that --scheme makes unreachable. The refusal
  // was correct for as long as the panels were opened by locating a toggle in
  // the accessibility tree, and it is gone with the toggles.
  if (o.status && o.schemeAsked) {
    // Same bus, same reason as --hover below: the dot is located by a walk.
    throw new Error("--status cannot be combined with --scheme: use --theme to force the palette.");
  }
  if (o.status && o.hover !== null) {
    // Two walks in one window kill the application; each of these takes one.
    throw new Error("--status cannot be combined with --hover: one AT-SPI walk per capture.");
  }
  if (o.hover !== null && o.schemeAsked) {
    // --hover needs the accessibility tree to find the control, and --scheme
    // works by making the session bus unreachable. AT-SPI is on that bus, so
    // the pair fails as "not exactly one matching application" -- an exit code
    // about the probe that is really about one line of env. --theme forces the
    // application's own palette and needs no bus.
    throw new Error("--hover cannot be combined with --scheme: use --theme to force the palette.");
  }
  if (o.press !== null && o.hover !== null) {
    // Two walks in one window kill the application; each of these takes one.
    throw new Error("--press cannot be combined with --hover: one AT-SPI walk per capture.");
  }
  if (o.press !== null && o.status) {
    throw new Error("--press cannot be combined with --status: one AT-SPI walk per capture.");
  }
  if (o.press !== null && o.schemeAsked) {
    // Same bus, same reason as --hover above: the control is located by a walk.
    throw new Error("--press cannot be combined with --scheme: use --theme to force the palette.");
  }
  if (o.castEdit && o.press !== null) {
    // Two walks in one window kill the application; each of these takes one.
    throw new Error("--cast-edit cannot be combined with --press: one AT-SPI walk per capture.");
  }
  if (o.castEdit && o.hover !== null) {
    throw new Error("--cast-edit cannot be combined with --hover: one AT-SPI walk per capture.");
  }
  if (o.castEdit && o.status) {
    throw new Error("--cast-edit cannot be combined with --status: one AT-SPI walk per capture.");
  }
  if (o.castEdit && o.schemeAsked) {
    // Same bus, same reason as --press above: `#cast-edit` is located by a
    // walk, and --scheme works by making the session bus that walk needs
    // unreachable.
    throw new Error("--cast-edit cannot be combined with --scheme: use --theme to force the palette.");
  }
  if (o.castCard && o.press !== null) {
    throw new Error("--cast-card cannot be combined with --press: one AT-SPI walk per capture.");
  }
  if (o.castCard && o.hover !== null) {
    throw new Error("--cast-card cannot be combined with --hover: one AT-SPI walk per capture.");
  }
  if (o.castCard && o.status) {
    throw new Error("--cast-card cannot be combined with --status: one AT-SPI walk per capture.");
  }
  if (o.castCard && o.schemeAsked) {
    // Same bus, same reason as --cast-edit above: the leftmost cast name is
    // located by a walk, and --scheme works by making the session bus that
    // walk needs unreachable.
    throw new Error("--cast-card cannot be combined with --scheme: use --theme to force the palette.");
  }
  if (o.castCard && o.fixture !== "sample") {
    // The graded fixtures carry no cast at all, so the plugin's names list is
    // empty on them and there is no mark to hover -- `--synopsis-edit`'s own
    // reason for the identical restriction.
    throw new Error("--cast-card only works on the sample fixture, which has a cast that appears in its prose.");
  }
  if (o.castAlias && o.castCard) {
    throw new Error("--cast-alias cannot be combined with --cast-card: one AT-SPI walk per capture.");
  }
  if (o.castAlias && o.press !== null) {
    throw new Error("--cast-alias cannot be combined with --press: one AT-SPI walk per capture.");
  }
  if (o.castAlias && o.hover !== null) {
    throw new Error("--cast-alias cannot be combined with --hover: one AT-SPI walk per capture.");
  }
  if (o.castAlias && o.status) {
    throw new Error("--cast-alias cannot be combined with --status: one AT-SPI walk per capture.");
  }
  if (o.castAlias && o.schemeAsked) {
    throw new Error("--cast-alias cannot be combined with --scheme: use --theme to force the palette.");
  }
  if (o.castAlias && o.fixture !== "sample") {
    // `sample` is the one fixture the aliases slice seeded (105); the graded
    // fixtures carry no cast at all -- `--cast-card`'s own reason.
    throw new Error(
      "--cast-alias only works on the sample fixture, which has a cast with aliases in its prose.",
    );
  }
  if (o.synopsisEdit && o.press !== null) {
    // Two walks in one window kill the application; each of these takes one.
    throw new Error("--synopsis-edit cannot be combined with --press: one AT-SPI walk per capture.");
  }
  if (o.synopsisEdit && o.hover !== null) {
    throw new Error("--synopsis-edit cannot be combined with --hover: one AT-SPI walk per capture.");
  }
  if (o.synopsisEdit && o.status) {
    throw new Error("--synopsis-edit cannot be combined with --status: one AT-SPI walk per capture.");
  }
  if (o.synopsisEdit && o.schemeAsked) {
    // Same bus, same reason as --cast-edit above: `#synopsis-edit` is located
    // by a walk, and --scheme works by making the session bus that walk needs
    // unreachable.
    throw new Error(
      "--synopsis-edit cannot be combined with --scheme: use --theme to force the palette.",
    );
  }
  if (o.synopsisEdit && o.fixture !== "sample") {
    // 097 review, ticket 06: `--synopsis-edit` forces `synopsis` to the empty
    // capture rather than typing anything, so the row it opens on shows READ
    // only if a synopsis is ALREADY THERE from before this run started --
    // which is true of nothing this rig plants, and true only of `sample`
    // (094's own fixture, seeded with real synopses). On any other fixture
    // the panel opens straight into Edit (097, W4: an empty synopsis has no
    // Read state), `#synopsis-edit` is `display: none`, and the walk this
    // flag depends on finds nothing to press.
    throw new Error("--synopsis-edit only works on the sample fixture, which already has a synopsis to read.");
  }
  {
    const timelineFlags = [
      ["--timeline", o.timeline],
      ["--timeline-card", o.timelineCard],
      ["--timeline-edit", o.timelineEdit],
      ["--timeline-empty", o.timelineEmpty],
      ["--timeline-row", o.timelineRow],
      ["--timeline-branch", o.timelineBranch],
      ["--timeline-swapped", o.timelineSwapped],
      ["--timeline-scale", o.timelineScale],
      ["--timeline-far", o.timelineFar],
    ] as const;
    const askedFor = timelineFlags.filter(([, on]) => on).map(([name]) => name);
    if (askedFor.length > 1) {
      throw new Error(`${askedFor.join(", ")} cannot be combined: one timeline capture mode per run.`);
    }
  }
  {
    // --timeline-branch, --timeline-scale and --timeline-far each open with
    // Fit's own walk exactly as --timeline does (Fit, then their own second
    // press for the swap/scale/zoom-out modes) -- the SAME "one AT-SPI walk
    // family" --timeline-card/--timeline-edit are already in, so they join
    // this refusal rather than restate it.
    const walksItself =
      o.timeline || o.timelineCard || o.timelineEdit || o.timelineBranch || o.timelineSwapped || o.timelineScale || o.timelineFar;
    const walkFlagsLabel =
      "--timeline/--timeline-card/--timeline-edit/--timeline-branch/--timeline-swapped/--timeline-scale/--timeline-far";
    if (walksItself && o.press !== null) {
      throw new Error(`${walkFlagsLabel} cannot be combined with --press: they already take their own AT-SPI walk.`);
    }
    if (walksItself && o.hover !== null) {
      throw new Error(`${walkFlagsLabel} cannot be combined with --hover: one AT-SPI walk per capture.`);
    }
    if (walksItself && o.status) {
      throw new Error(`${walkFlagsLabel} cannot be combined with --status: one AT-SPI walk per capture.`);
    }
    if (walksItself && o.schemeAsked) {
      // Same bus, same reason as --cast-edit above: Fit (and every second
      // press these flags take) is located by a walk, and --scheme works by
      // making the session bus that walk needs unreachable.
      throw new Error(`${walkFlagsLabel} cannot be combined with --scheme: use --theme to force the palette.`);
    }
  }
  if (o.press !== null && o.fade !== null) {
    // --fade photographs the CHROME FADED: the pointer move plus click a press
    // makes is the exact gesture chrome-fade.ts wakes the chrome on, so the
    // capture would show woken chrome under a filename claiming the faded one.
    throw new Error("--press cannot be combined with --fade: pressing anything wakes the faded chrome.");
  }
  if (o.projects && o.prefs) {
    // Still refused, for the surviving half of the old reason: the two panels
    // overlap, both anchored to the same bar, so a capture of one is a capture
    // of the other with something on top of it.
    throw new Error("--projects and --prefs cannot be combined: one panel per capture.");
  }
  if (o.selectLastWord && o.type === null) {
    throw new Error("--select-last-word selects the last word --type typed; pass --type");
  }
  if (o.typeAfter !== null && o.press === null) {
    throw new Error("--type-after types after --press; pass --press");
  }
  if (o.fade !== null && (o.type === null || o.modes === null || !o.modes.startsWith("paragraph,"))) {
    // The fade only ever arms from a real keystroke while focus mode is on,
    // so a capture of it without both is not a picture of anything the
    // module does.
    throw new Error(
      "--fade photographs what typing in focus mode does to the chrome, so it needs --modes paragraph,<typewriter> and --type <text>",
    );
  }
  // --select-word is NOT refused with --status, --hover or --menu, and that is
  // a decision and not an oversight: every refusal above exists because one
  // side needs the session bus (an AT-SPI walk) that the other side cuts, or
  // because two walks in one window kill the application, or because two
  // panels paint over the same bar. --select-word takes none of those routes
  // -- it is a keystroke sent through the same focus guard --menu already
  // needed, nothing more -- so none of those reasons apply to it. Combined
  // with one of the three the later action simply wins the picture, the same
  // as any two panel flags passed together elsewhere in this file; that is a
  // capture nobody would ask for on purpose, not one this rig cannot take.

  if (o.firstRun !== null || o.blank) {
    // Every one of these plants into, or reads from, a SEEDED project -- a
    // demo cast, a remembered book, a dictionary word, a selected scene, a
    // tagged appearance, a chapter style. A fresh data home has none of that
    // to plant into or read from, so the combination is refused by name
    // rather than seeding one behind --first-run's back.
    //
    // --data-home is refused for a different reason: it names a directory to
    // REUSE across invocations, and a reused home is not the first thing
    // anyone met in it.
    const seeded: readonly [string, boolean][] = [
      ["--projects", o.projects],
      ["--prefs", o.prefs],
      ["--cast", o.cast],
      ["--cast-empty", o.castEmpty],
      ["--cast-missing", o.castMissing],
      ["--cast-edit", o.castEdit],
      ["--cast-card", o.castCard],
      ["--cast-alias", o.castAlias],
      ["--covers", o.covers],
      ["--covers-empty", o.coversEmpty],
      ["--covers-full", o.coversFull],
      ["--history-demo", o.historyDemo],
      ["--states-demo", o.statesDemo],
      ["--revision-planning", o.revisionPlanning],
      ["--craft-knowledge", o.craftKnowledge],
      ["--craft-reports", o.craftReports],
      ["--comments-demo", o.commentsDemo],
      ["--review-demo", o.reviewDemo],
      ["--marks-demo", o.marksDemo],
      ["--identities", o.identities],
      ["--identities-empty", o.identitiesEmpty],
      ["--identities-report", o.identitiesReport],
      ["--warning-history", o.warningHistory],
      ["--identities-edit", o.identitiesEdit],
      ["--identities-repin", o.identitiesRepin],
      ["--library", o.library],
      ["--library-empty", o.libraryEmpty],
      ["--library-form", o.libraryForm],
      ["--library-over-book", o.libraryOverBook],
      ["--type", o.type !== null],
      ["--find", o.find !== null],
      ["--select-word", o.selectWord],
      ["--select-last-word", o.selectLastWord],
      ["--type-after", o.typeAfter !== null],
      ["--fade", o.fade !== null],
      ["--press", o.press !== null],
      ["--hover", o.hover !== null],
      ["--status", o.status],
      ["--dict-word", o.dictWord !== null],
      ["--appears", o.appears],
      ["--appears-map", o.appearsMap],
      ["--preview-styled", o.previewStyled],
      ["--data-home", o.dataHome !== null],
    ];
    const combined = seeded.filter(([, on]) => on).map(([name]) => name);
    if (combined.length > 0) {
      // Same refusal, either flag: both boot a fresh, empty data home with
      // nothing seeded into it.
      const flagName = o.firstRun !== null ? "--first-run" : "--blank";
      throw new Error(
        `${flagName} cannot be combined with ${combined.join(", ")}: those assume a seeded ` +
          `project or a reused data home, and ${flagName} boots a fresh, empty one with neither.`,
      );
    }
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.bibleFolders && options.fixture !== "sample") {
  throw new Error("--bible-folders needs the sample fixture's existing bible notes");
}
if ((options.outlineEmpty || options.outlineLongSynopsis) && options.outlineView === null) {
  throw new Error("--outline-empty and --outline-long-synopsis need --outline-view");
}
if (options.outlineAct !== null && options.outlineView !== "table") {
  throw new Error("--outline-act needs --outline-view table");
}
refuseUndrivableCombination(options);
const FIXTURE = resolveFixtureDir(options.fixture);
// THE ONE FIXTURE WITH ITS OWN REAL CAST, SYNOPSES AND APPEARANCES (094): the
// four flags below plant DEMO data over whatever a fixture already holds, and
// planting it over `sample`'s real content would bury the very thing that
// fixture exists to show. Every site below skips its plant under `sample` and
// opens the panel on what is there instead.
const isSample = options.fixture === "sample";

if (process.env.APP_GUI !== "1") {
  console.log("APP_GUI=1 not set; screenshot skipped (needs a display and a built shell).");
  process.exit(0);
}
// --first-run seeds no fixture, so it names none: FIXTURE still points at
// lab/fixtures/out/<the positional argument>, and requiring it present would
// refuse a --first-run capture over a fixture the run never touches.
for (const p of [
  BIN,
  DIST,
  ...(options.firstRun === null && !options.blank && !options.libraryEmpty ? [FIXTURE] : []),
]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — build the shell and the UI, and generate the fixture.`);
    process.exit(1);
  }
}
if (Bun.spawnSync(["which", "import"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
  console.error("missing `import` (ImageMagick); nothing can capture the window.");
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), "app-shot-"));
const projectPath = join(workDir, "project.db");
const configHome = gtkConfig(options.scheme);
const appDataHome = dataHome(
  options.theme,
  options.locale,
  options.prose,
  options.modes,
  options.palette,
  options.size,
  options.dataHome ?? undefined,
);
const localeCatalog = `app/ui/src/i18n/${options.locale}.ts`;
const timelineUntitled = catalogText("timeline.untitled", localeCatalog);
const localizedMenuDriver = (display: string, wid: string) =>
  menuDriver(display, wid, xdo, undefined, localeCatalog);
if (options.ghostBook) {
  // A path under the run's own work dir that nothing creates: the shape of a
  // book the writer moved in their file manager. Planted through settings.json
  // like every other preference, so the panel meets it the way a launch would.
  const settingsPath = join(appDataHome, "cc.local.app", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings.books = [join(workDir, "moved-away", "the-harbour.db")];
  writeFileSync(settingsPath, JSON.stringify(settings));
}
// `--start` names the word directly; bare `--blank` defaults to "blank" so
// the empty-workspace capture does not also need `--start blank` typed out.
// `--first-run` defaults to "last" for the reason `first-cli.ts` plants the
// same word (an earlier change flipped `Start`'s own default to `Home`, which
// this flag's whole subject -- `open_from_library`'s CREATED-DEFAULT path,
// with no APP_PROJECT and nothing seeded -- would otherwise never reach).
// Planted through settings.json like every other preference here.
const plantedStart =
  options.start ??
  (options.blank
    ? "blank"
    : options.firstRun !== null
      ? "last"
      : options.library || options.libraryEmpty
        ? "home"
        : null);
if (plantedStart !== null) {
  const settingsPath = join(appDataHome, "cc.local.app", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings.start = plantedStart;
  writeFileSync(settingsPath, JSON.stringify(settings));
}
const cleanup = (): void => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  // A REUSED data home is the caller's, not this run's: it may still be
  // wanted by a second invocation sharing it (see --data-home), and it is the
  // caller's job to remove it once both runs are done.
  if (options.dataHome === null) rmSync(appDataHome, { recursive: true, force: true });
};

// --first-run and --library-empty both want an EMPTY data home and no fixture
// at all -- the surface worth photographing there is the one a person
// actually meets with nothing seeded yet, and seeding one would be a picture
// of the fixture rather than of that.
// --timeline/--timeline-card/--timeline-edit plant a small timeline BEFORE
// the seed, into a TEMP COPY of the chosen fixture -- the committed fixture
// directory is never written into. `timeline-corpus.ts`'s own generator,
// restated small (12 events, not 2,000): this capture is a picture, not a
// stress run, and a dense document would collapse most of its events into
// dots the moment the window opens.
let seedFixtureDir = FIXTURE;
const ownTimeline = fixtureOwnTimeline(FIXTURE);
const timelineTitle = ownTimeline?.title ?? SHOT_TIMELINE_TITLE;
const timelineFirstEventTitle = ownTimeline?.firstEventTitle ?? "Event 1";
if (
  ownTimeline === null &&
  (options.timeline ||
    options.timelineCard ||
    options.timelineEdit ||
    options.timelineBranch ||
    options.timelineSwapped ||
    options.timelineScale ||
    options.timelineFar)
) {
  const fixtureCopy = join(workDir, "fixture-with-timeline");
  cpSync(FIXTURE, fixtureCopy, { recursive: true });
  const corpus = generateTimelineCorpus({
    eventCount: 12,
    trackCount: 4,
    spreadUnits: 400,
    rangeFraction: 1 / 12,
    meetingFraction: 1 / 12,
    sceneLinkFraction: 0,
    sceneIds: [],
    seed: 102,
  });
  // --timeline-branch/--timeline-swapped's own addition (103): ONE branch
  // forked at the corpus's own zero on its first track, with one event on
  // it -- enough for the dashed lane group to draw and, for
  // --timeline-swapped, for the swap to move something visible.
  if (options.timelineBranch || options.timelineSwapped) {
    const tracks = corpus.tracks as { id: string }[];
    const events = corpus.events as Record<string, unknown>[];
    (corpus.branches as Record<string, unknown>[]).push({
      id: "b-shot",
      name: "Danse wins",
      forkAt: 0,
      forkTrack: tracks[0]!.id,
      writing: false,
    });
    events.push({
      id: "v-shot-branch",
      title: "Branch event",
      at: 40,
      until: null,
      tracks: [tracks[0]!.id],
      branch: "b-shot",
      scene: null,
      cast: [],
      note: "",
    });
  }
  writeFileSync(
    join(fixtureCopy, "timelines.ndjson"),
    `${JSON.stringify({ id: "tl-shot", title: SHOT_TIMELINE_TITLE, body: corpus })}\n`,
  );
  seedFixtureDir = fixtureCopy;
}

if (options.firstRun === null && !options.blank && !options.libraryEmpty) {
  console.log(`[1/3] seeding project from ${seedFixtureDir}`);
  const seeded = Bun.spawnSync([BIN, "--seed", seedFixtureDir, projectPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (seeded.exitCode !== 0) {
    console.error(`seeding failed (exit ${seeded.exitCode}).`);
    cleanup();
    process.exit(1);
  }
} else {
  console.log(
    options.blank
      ? "[1/3] --blank: no project seeded, an empty data home only"
      : options.libraryEmpty
        ? "[1/3] --library-empty: nothing seeded, an empty library only"
        : "[1/3] --first-run: no project seeded, an empty data home only",
  );
}

/** `--library` / `--library-form`: two extra books beside `projectPath`, two
 *  pen names planted, `projectPath` and one extra book pinned to the first
 *  and the other extra book pinned to the second -- so the strip's filter
 *  actually hides something. `DEMO_VAULT`, `plantDemoIdentities` and
 *  `pinBook` live in `demo-vault.ts` (107), shared with `preflight-cli.ts`. */
const libraryExtraPaths: string[] = [];
if (options.library) {
  plantDemoIdentities(appDataHome, projectPath);
  for (const name of ["second-book", "third-book"]) {
    const extra = join(workDir, `${name}.db`);
    const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, extra], { stdout: "inherit", stderr: "inherit" });
    if (seeded.exitCode !== 0) {
      console.error(`seeding ${name} failed (exit ${seeded.exitCode}).`);
      cleanup();
      process.exit(1);
    }
    libraryExtraPaths.push(extra);
  }
  pinBook(libraryExtraPaths[0]!, "i1");
  pinBook(libraryExtraPaths[1]!, "i2");
}
if (options.librarySeries || options.hostError) {
  for (const path of [projectPath, ...libraryExtraPaths]) {
    const db = new Database(path);
    try {
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)").run("library_membership",
        JSON.stringify({ version: options.hostError ? 99 : 1,
          series: { id: "1".repeat(32), name: "The harbour books" },
          universe: { id: "2".repeat(32), name: "Harbour Lights" } }));
    } finally { db.close(); }
  }
}
// THE SCREEN LISTS WHAT THE HOST KNOWS, not what sits in the work dir: every
// book this run seeds lives OUTSIDE the library directory, and the overview
// reads `list_known` (the library scan plus `settings.books`). Without this
// line the first capture showed two pen names and "No books yet." over three
// seeded books. `--ghost-book`'s own route, with real files.
if (options.library || options.libraryOverBook) {
  const settingsPath = join(appDataHome, "cc.local.app", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings.books = [projectPath, ...libraryExtraPaths];
  writeFileSync(settingsPath, JSON.stringify(settings));
}

/** Plant a few past states and one named snapshot, so `--history-demo` can
 *  photograph a panel with ROWS in it.
 *
 *  PLANTED, not produced by use, and the capture's filename says so. The panel
 *  a fresh boot shows is both empty states at once, which is worth one picture
 *  and cannot answer the questions a capture exists to answer here: whether the
 *  three figures line up down the column, whether a long snapshot label
 *  truncates rather than pushing Restore off the edge, and whether an armed
 *  confirmation reads as a question. Producing six real versions would take
 *  half an hour of wall clock, because the automatic interval is five minutes.
 *
 *  The graded run plants nothing it grades a figure against: history-cli's
 *  planted version exists so the RESTORE oracle is text the application never
 *  wrote. This is a photograph. */
/** One stored body, edited the way a draft is: some of it cut, a sentence in it
 *  that is no longer anywhere.
 *
 *  Both directions on purpose. A version that is only SHORTER paints one colour
 *  and one decoration, which cannot answer whether the two sides are
 *  distinguishable from each other - the question the capture exists for.
 *
 *  It reads and rewrites this schema's JSON by hand rather than importing the
 *  page's builders: the harness does not import page source. A wrong shape here
 *  fails loudly, at the panel, in a capture whose filename says --compare. */
function demoOlderBody(body: string): string {
  const doc = JSON.parse(body) as {
    type: string;
    content?: { type: string; content?: { type: string; text?: string }[] }[];
  };
  const paragraphs = (doc.content ?? []).slice(0, 2).map((paragraph) => {
    const text = (paragraph.content ?? []).map((node) => node.text ?? "").join("");
    const words = text.split(" ");
    const kept = words.slice(0, Math.max(1, Math.ceil(words.length * 0.6))).join(" ");
    return {
      type: "paragraph",
      content: [{ type: "text", text: `${kept} This sentence stood here in the earlier draft.` }],
    };
  });
  return JSON.stringify({
    type: "doc",
    content: paragraphs.length > 0 ? paragraphs : doc.content,
  });
}

function plantAnalyticsDemo(path: string): void {
  const db = new Database(path);
  try {
    const scene = db.query("SELECT id FROM item WHERE type='scene' ORDER BY position LIMIT 1").get() as { id: string } | null;
    if (scene === null) throw new Error("--analytics-demo needs a scene in the fixture");
    db.query("INSERT INTO meta(key,value) VALUES('analytics_recording_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    db.query("INSERT INTO meta(key,value) VALUES('analytics_selected_category',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ id: "drafting", name: "Drafting" }));
    db.query("INSERT INTO meta(key,value) VALUES('analytics_motivation_visible','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    db.query("INSERT INTO meta(key,value) VALUES('analytics_forecast_goal_words','12000') ON CONFLICT(key) DO UPDATE SET value='12000'").run();
    const now = new Date();
    const dayOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    for (let index = 0; index < 4; index++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3 + index, 11 + index, 0, 0);
      const ms = at.getTime();
      const day = dayOf(at);
      const offset = -at.getTimezoneOffset();
      const sessionId = (index + 1).toString(16).repeat(32);
      const segmentId = (index + 5).toString(16).repeat(32);
      const category = index === 2 ? "Revision" : "Drafting";
      db.query("INSERT INTO analytics_session(id,started_ms,ended_ms,start_day,start_offset_min,metric_version,gap) VALUES(?1,?2,?3,?4,?5,1,0)")
        .run(sessionId, ms - 120000, ms + 120000, day, offset);
      db.query("INSERT INTO analytics_segment(id,session_id,category_id,category_name,started_ms,ended_ms,gap) VALUES(?1,?2,?3,?4,?5,?6,0)")
        .run(segmentId, sessionId, category.toLowerCase(), category, ms - 120000, ms + 120000);
      for (let minute = 0; minute < 3 + index; minute++) {
        const observed = ms + minute * 60000;
        const bucket = Math.floor(observed / 60000);
        db.query("INSERT INTO analytics_minute(session_id,segment_id,utc_minute,local_day,offset_min) VALUES(?1,?2,?3,?4,?5)")
          .run(sessionId, segmentId, bucket, day, offset);
      }
      db.query("INSERT INTO analytics_movement(segment_id,item_id,utc_ms,utc_minute,local_day,offset_min,source,added,deleted) VALUES(?1,?2,?3,?4,?5,?6,'typing',?7,?8)")
        .run(segmentId, scene.id, ms, Math.floor(ms / 60000), day, offset, 120 + index * 35, index === 2 ? 24 : 8);
    }
  } finally { db.close(); }
}

function plantDemoHistory(path: string): void {
  const db = new Database(path);
  try {
    // THE SCENE THE PAGE OPENS, which is the first scene in the depth-first
    // walk -- not the first row of `doc`, whose order is arbitrary. The first
    // version of this planted straight into `doc` and the capture came back
    // with a panel saying "No earlier versions of this scene yet.", which reads
    // exactly like the feature not working.
    const scenes = db
      .query(
        `WITH RECURSIVE walk(id, parent_id, type, position, path) AS (
           SELECT id, parent_id, type, position, position FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.type, i.position, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
         )
         SELECT w.id AS item_id, d.body AS body
           FROM walk w JOIN doc d ON d.item_id = w.id
          WHERE w.type = 'scene'
          ORDER BY w.path LIMIT 1`,
      )
      .all() as { item_id: string; body: string }[];
    const first = scenes[0];
    if (first === undefined) return;
    const now = Date.now();
    const ages = [4 * 60_000, 41 * 60_000, 3 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000];
    const counts = [1240, 1060, 1180, 402];
    db.run("INSERT INTO snapshot (label, created_at) VALUES (?1, ?2)", [
      "before the second act",
      now - 41 * 60_000,
    ]);
    const snapshotId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    // THE OLDEST PLANTED VERSION HOLDS DIFFERENT PROSE, and that is what makes
    // a comparison photographable at all. Every version planted here used to
    // carry the scene's current body, so the first --compare capture came back
    // with a panel honestly reporting "No difference" - a picture of the empty
    // state rather than of the feature, and one that reads exactly like a diff
    // that failed to run.
    const olderBody = demoOlderBody(first.body);
    ages.forEach((age, index) => {
      const key = `shot-demo-${index}`;
      const body = index === ages.length - 1 ? olderBody : first.body;
      db.run("INSERT OR REPLACE INTO blob (key, body) VALUES (?1, ?2)", [key, body]);
      db.run(
        `INSERT INTO doc_version (item_id, blob_key, created_at, words, snapshot_id)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        [first.item_id, key, now - age, counts[index] ?? 0, index === 1 ? snapshotId : null],
      );
    });
  } finally {
    db.close();
  }
}

/** Mark a few items, so a capture shows what the marks look like against each
 *  other rather than one mark alone.
 *
 *  PLANTED, and the capture's filename says so. A fresh fixture is entirely
 *  unmarked, which is the ordinary state and worth exactly one picture; it
 *  cannot answer the questions this capture exists for - whether the four marks
 *  are distinguishable at 11px, whether a mark beside a word count crowds the
 *  title, and whether a part's spaced capitals still read as a part with one.
 *
 *  ONE PER STATE, on the first four rows of the WALK rather than of `doc`, so
 *  they land on rows near the top of the pane and on a mixture of types. The
 *  planted rev is not bumped: nothing has read these rows yet, and the page
 *  re-reads the whole walk at boot.
 *
 *  Written with bun:sqlite by hand rather than through the app's own command,
 *  exactly as plantDemoHistory is: the harness does not import page source, and
 *  a capture is a photograph rather than a graded claim. */
function plantDemoStates(path: string): void {
  const db = new Database(path);
  try {
    const rows = db
      .query(
        `WITH RECURSIVE walk(id, parent_id, position, path) AS (
           SELECT id, parent_id, position, position FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.position, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
         )
         SELECT id FROM walk ORDER BY path LIMIT 4`,
      )
      .all() as { id: string }[];
    // Restated here rather than imported, like every other rule this harness
    // shares with the page. A word this build does not know would be planted
    // silently and the navigator would draw nothing, which reads as the feature
    // not working - so the count is asserted instead.
    const states = ["revising", "draft", "done", "outline"];
    if (rows.length < states.length) {
      throw new Error(`--states-demo needs ${states.length} items, the fixture walked ${rows.length}`);
    }
    rows.forEach((row, at) => {
      db.query("UPDATE item SET state = ?1 WHERE id = ?2").run(states[at] ?? null, row.id);
    });
  } finally {
    db.close();
  }
}

function plantRevisionPlanning(path: string): void {
  const db = new Database(path);
  try {
    const scene = db.query("SELECT id,title FROM item WHERE type='scene' ORDER BY position LIMIT 1")
      .get() as { id: string; title: string } | null;
    if (scene === null) throw new Error("--revision-planning needs a scene in the fixture");
    const now = Date.now();
    const pass = db.query("INSERT INTO revision_pass(name,name_key,purpose,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)")
      .run("Structure pass", "structure pass", "Check the opening and the arc", now);
    const passId = Number(pass.lastInsertRowid);
    db.query("INSERT INTO revision_task(body,item_id,target_caption,pass_id,created_at,updated_at) VALUES(?1,NULL,NULL,?2,?3,?3)")
      .run("Check the middle chapter transition", passId, now);
    db.query("INSERT INTO revision_task(body,item_id,target_caption,pass_id,done_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5,?5)")
      .run("Strengthen the opening image", scene.id, scene.title, passId, now + 1);
  } finally {
    db.close();
  }
}

function plantCraftDemo(path: string): void {
  const db = new Database(path);
  try {
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 16) throw new Error("--craft requires a schema 16 shell");
    const scene = db.query("SELECT id,title FROM item WHERE type='scene' ORDER BY position LIMIT 1")
      .get() as { id: string; title: string } | null;
    if (scene === null) throw new Error("--craft needs a scene in the fixture");
    const original = "Field notes: the harbor lights go out before the tide turns.\n";
    const hash = createHash("sha256").update(original).digest("hex");
    const researchDir = path.replace(/\.db$/, "") + ".research";
    mkdirSync(researchDir, { mode: 0o700 });
    writeFileSync(join(researchDir, hash), original, { mode: 0o600 });
    const now = Date.now();
    const resourceId = "0198c0de-0000-7000-8000-000000000187";
    db.query("INSERT INTO research_resource(id,title,original_name,media_type,bytes,sha256,source_note,citation,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")
      .run(resourceId, "Harbor field notes", "harbor-notes.txt", "text/plain", Buffer.byteLength(original), hash,
        "Collected before the storm", "Notebook, page 4", now);
    db.query("INSERT INTO knowledge_link(id,source_kind,source_id,source_caption,target_kind,target_id,target_caption,label,note,citation,created_at) VALUES(?1,'item',?2,?3,'resource',?4,?5,?6,?7,?8,?9)")
      .run("0198c0de-0000-7000-8000-000000000188", scene.id, scene.title, resourceId,
        "Harbor field notes", "inspired by", "Check the tide timing", "Notebook, page 4", now);
    db.query("INSERT INTO meta(key,value) VALUES('craft.watchlist',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ version: 1, terms: [{ text: "harbor", mode: "folded" }] }));
  } finally { db.close(); }
}

/** Three notes on the scene the application opens with: one live, one resolved,
 *  one whose passage is gone.
 *
 *  ALL THREE KINDS IN ONE PICTURE, because they are drawn differently and the
 *  differences are the thing worth looking at - a live row quotes prose that is
 *  there, a resolved one is quieter, and an orphan carries a rule and a sentence
 *  saying its passage was deleted. Producing them by use would mean typing,
 *  selecting, adding and then deleting through the UI, which is a graded rig's
 *  job and not a photograph's.
 *
 *  Written with bun:sqlite by hand, exactly as plantDemoHistory and
 *  plantDemoStates are: the harness does not import page source.
 *
 *  THE POSITIONS ARE COMPUTED FROM THE STORED BODY, not guessed. A ProseMirror
 *  paragraph opens at 0 and its text starts at 1, so a range inside the first
 *  paragraph's text is [1 + a, 1 + b) with b no larger than that text's length.
 *  An anchor past the end of the document would decorate nothing and the capture
 *  would say the feature does not work. */
/** --review-demo: two proposals on the first document, each hunk replacing a
 *  span of the first paragraph's first text node with its own before text
 *  read from the store, so the host's own apply check would accept it. Same
 *  document and same text-node rule as plantDemoComments. */
function plantDemoReview(path: string): void {
  const db = new Database(path);
  try {
    const row = db
      .query(
        `WITH RECURSIVE walk(id, parent_id, position, path) AS (
           SELECT id, parent_id, position, position FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.position, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
         )
         SELECT w.id AS id, d.body AS body FROM walk w JOIN doc d ON d.item_id = w.id
          ORDER BY w.path LIMIT 1`,
      )
      .get() as { id: string; body: string } | null;
    if (row === null) throw new Error("--review-demo found no document in the fixture");
    const parsed = JSON.parse(row.body) as { content?: { content?: { text?: string; marks?: unknown[] }[] }[] };
    const node = parsed.content?.[0]?.content?.[0];
    const text = node?.text ?? "";
    if (text.length < 40 || (node?.marks?.length ?? 0) > 0) {
      throw new Error(`--review-demo needs an unmarked first text of at least 40 characters, found ${text.length}`);
    }
    const now = Date.now();
    const author = db.query("INSERT INTO review_author (display_name, created_at) VALUES (?1, ?2)");
    const group = db.query(
      "INSERT INTO review_group (item_id, author_id, author_name, rev, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
    );
    const hunk = db.query(
      `INSERT INTO review_hunk (group_id, ordinal, original_from, original_to, before_json, after_json,
         mapped_from, mapped_to, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3, ?4, 'pending')`,
    );
    const plant = (name: string, ago: number, spans: [number, number, string][]): void => {
      const authorId = Number(author.run(name, now - ago).lastInsertRowid);
      const groupId = Number(group.run(row.id, authorId, name, now - ago).lastInsertRowid);
      spans.forEach(([a, b, after], ordinal) => {
        hunk.run(groupId, ordinal, 1 + a, 1 + b, JSON.stringify([{ kind: "text", text: text.slice(a, b) }]),
          JSON.stringify([{ kind: "text", text: after }]));
      });
    };
    plant("Mara", 3 * 60 * 60_000, [[0, 3, "This"]]);
    plant("Jonas", 40 * 60_000, [[10, 14, "that"], [30, 34, "then"]]);
  } finally {
    db.close();
  }
}

function plantDemoComments(path: string): string {
  const db = new Database(path);
  try {
    const row = db
      .query(
        `WITH RECURSIVE walk(id, parent_id, position, path) AS (
           SELECT id, parent_id, position, position FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.position, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
         )
         SELECT w.id AS id, d.body AS body FROM walk w JOIN doc d ON d.item_id = w.id
          ORDER BY w.path LIMIT 1`,
      )
      .get() as { id: string; body: string } | null;
    if (row === null) throw new Error("--comments-demo found no document in the fixture");
    const parsed = JSON.parse(row.body) as {
      content?: { content?: { text?: string }[] }[];
    };
    const text = parsed.content?.[0]?.content?.[0]?.text ?? "";
    if (text.length < 20) {
      throw new Error(
        `--comments-demo needs a first paragraph of at least 20 characters, found ${text.length}`,
      );
    }
    const cut = (a: number, b: number): [number, number, string] => [
      1 + a,
      1 + b,
      text.slice(a, b),
    ];
    const live = cut(0, Math.min(14, text.length));
    const settled = cut(Math.min(20, text.length - 6), Math.min(30, text.length));
    const now = Date.now();
    const insert = db.query(
      `INSERT INTO comment
         (item_id, body, anchor_from, anchor_to, quote, resolved_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    );
    insert.run(row.id, "Is she looking at it, or past it?", live[0], live[1], live[2], null, now - 4 * 60_000);
    insert.run(row.id, "Fixed - the tense agrees now.", settled[0], settled[1], settled[2], now, now - 90 * 60_000);
    // The orphan: a collapsed pair, which is exactly what the mapping leaves
    // behind when a writer deletes the whole passage. Its quote is the only
    // thing left naming what it was about, which is the point of the row.
    insert.run(row.id, "This whole paragraph was doing nothing.", 1, 1, "the drowned orchard", null, now - 26 * 60 * 60_000);
    return row.id;
  } finally {
    db.close();
  }
}

/** Split the open scene's first paragraph into runs carrying the three
 *  formatting marks, before the window opens.
 *
 *  Planted, exactly as the comments are: producing this through the UI means
 *  selecting a word and pressing a chord, which is a graded rig's job
 *  (`export-cli` does it) and not a photograph's.
 *
 *  IT CHANGES NO CHARACTER AND NO POSITION. The paragraph's text is identical
 *  afterwards, only split into more text nodes -- so ProseMirror positions are
 *  unmoved and this composes with --comments-demo, whose anchors are computed
 *  from the same text. That is the whole reason the runs are cut out of the
 *  existing paragraph rather than appended to it.
 *
 *  THE FIRST RUN CARRIES ALL THREE, but that stopped being enough to
 *  photograph when 069 retired the header's B/I/U bar for a bubble toolbar
 *  that only paints over a selection: the page opens with the caret at the
 *  start of the document, and a caret is collapsed, so nothing shows what
 *  marks it sits inside any more. --select-word is what makes the pressed
 *  states visible again -- it selects into this first run once the window has
 *  focus, and the bubble that rests on that selection is what photographs
 *  Bold, Italic and Underline pressed. A capture of the resting state is the
 *  same command without either flag.
 */
function plantDemoMarks(path: string): void {
  const db = new Database(path);
  try {
    const row = db
      .query(
        `WITH RECURSIVE walk(id, parent_id, position, path) AS (
           SELECT id, parent_id, position, position FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.position, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
         )
         SELECT w.id AS id, d.body AS body FROM walk w JOIN doc d ON d.item_id = w.id
          ORDER BY w.path LIMIT 1`,
      )
      .get() as { id: string; body: string } | null;
    if (row === null) throw new Error("--marks-demo found no document in the fixture");
    const parsed = JSON.parse(row.body) as {
      content?: { content?: { type: string; text?: string }[] }[];
    };
    const first = parsed.content?.[0];
    const text = first?.content?.[0]?.text ?? "";
    // Long enough to hold three separated runs AFTER the range --comments-demo
    // anchors its live note in, so the two signals are side by side in the
    // picture rather than on top of each other.
    if (text.length < MARKS_DEMO_MIN) {
      throw new Error(
        `--marks-demo needs a first paragraph of at least ${MARKS_DEMO_MIN} characters, found ${text.length}`,
      );
    }
    interface Run {
      type: string;
      text: string;
      marks?: { type: string }[];
    }
    const run = (from: number, to: number, marks: string[]): Run => ({
      type: "text",
      text: text.slice(from, to),
      ...(marks.length === 0 ? {} : { marks: marks.map((type) => ({ type })) }),
    });
    // Cuts, in order, covering the paragraph exactly once. The first carries all
    // three; the rest sit past the demo comment's anchors.
    first!.content = [
      run(0, 6, ["strong", "em", "underline"]),
      run(6, 34, []),
      run(34, 42, ["strong"]),
      run(42, 48, []),
      run(48, 56, ["em"]),
      run(56, 62, []),
      run(62, 72, ["underline"]),
      run(72, text.length, []),
    ].filter((n) => n.text.length > 0);
    db.query("UPDATE doc SET body = ?1 WHERE item_id = ?2").run(JSON.stringify(parsed), row.id);
  } finally {
    db.close();
  }
}

/** The shortest first paragraph --marks-demo can cut its runs out of. */
const MARKS_DEMO_MIN = 72;

/** Add one word to the project's own dictionary, before the window opens.
 *
 *  WRITES THE ROW `dict_add` WOULD, exactly as plantDemoStates writes the
 *  column `item_set_state` would: this rig does not import host source, and a
 *  capture is a photograph rather than a graded claim. The row landing in the
 *  file is what `main()` reads on the open-project path and renders into
 *  `ENCHANT_CONFIG_DIR` before the webview exists -- see
 *  commands/spell.rs::sync_project_dictionary -- so this exercises the same
 *  mechanism a writer's own Add click would, without needing this rig to type
 *  into the preferences panel and click through it. */
/** A cast worth photographing: every kind represented, one entry carrying real
 *  detail fields, and one name long enough to test the ellipsis the entry rule
 *  promises.
 *
 *  PLANTED, exactly as --states-demo and --comments-demo are, and for the same
 *  reason: this rig cannot drive the panel's Add control three times and choose
 *  a different kind each time without coordinates, and a capture that needed
 *  coordinates could not compose with --scheme.
 *
 *  It writes the rows `cast_create` and `cast_set` would, restated here rather
 *  than shared -- the harness does not import host source, for the reason it
 *  restates gate thresholds. A drift can only produce a picture that is wrong in
 *  a way somebody looking at it will see, which is what a capture is for.
 */
/** A cover on each side of the book, planted before the window opens.
 *
 *  PLANTED, exactly as --cast plants a photograph and for the same reason: the
 *  only route a writer has is the host's OS file dialog, which `dialog-cli`
 *  drives and no capture can, and a picture that needed a dialog could not
 *  compose with --scheme.
 *
 *  IT WRITES THE TWO `meta` ROWS `covers_pick` WOULD and copies the files where
 *  `pictures::attach` would have put them, restated here rather than imported --
 *  the harness does not read host source, for the reason it restates gate
 *  thresholds.
 *
 *  THE ORIGINALS AND NOT THE THUMBNAILS. The host regenerates a missing
 *  thumbnail from the original on the next read, so planting only the originals
 *  exercises that path rather than pre-baking the very thing the capture is
 *  meant to show the application producing -- `plantDemoCast`'s rule.
 *
 *  NEITHER COVER SUITS THE PAGE, deliberately. The front is the right shape and
 *  short of resolution and the back is neither, so one capture holds a
 *  one-sentence finding block and a two-sentence one. A pair that passed would
 *  photograph a panel with nothing on it to judge. */
function plantDemoCovers(path: string): void {
  const pictures = path.replace(/\.db$/, "") + ".pictures";
  mkdirSync(pictures, { recursive: true });
  const planted: Array<[string, string, string]> = [
    ["design.cover.front", "0198c0de-0000-7000-8000-0000000004f0.png", "demo-cover-front.png"],
    ["design.cover.back", "0198c0de-0000-7000-8000-0000000004f1.png", "demo-cover-back.png"],
  ];
  const db = new Database(path);
  try {
    for (const [key, stored, fixture] of planted) {
      copyFileSync(join(import.meta.dir, "..", "fixtures", fixture), join(pictures, stored));
      db.query(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, stored);
    }
  } finally {
    db.close();
  }
}

/** The two `meta` rows `chapter_style_set` would write, with all four options
 *  on.
 *
 *  THE VALUES ARE RESTATED, not imported from the host: these are two programs,
 *  the same rule the rigs follow for every gate threshold, and a rig that read
 *  the application's own spelling of a stored value could not tell a build that
 *  had changed it from one that had not. `design.rs` holds the other statement.
 */
function plantChapterStyle(path: string): void {
  const db = new Database(path);
  try {
    for (const [key, value] of [
      ["design.glyph", "asterism"],
      ["design.chapter", "new-page caps-title drop-cap"],
    ]) {
      db.query(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key as string, value as string);
    }
  } finally {
    db.close();
  }
}

function plantDemoCast(path: string, withFile: boolean): void {
  const db = new Database(path);
  const now = Date.now();
  const people: Array<[string, string, string, string, Array<[string, string]>]> = [
    [
      "c1",
      "character",
      "Ilse Vandermeer",
      "Keeps the letter she was told to burn, and has told nobody.",
      [
        ["accent", "flat northern"],
        ["wants", "to be believed"],
        ["the lie she believes", "that her father chose to leave"],
      ],
    ],
    ["c2", "character", "Ruben", "Her brother. Reads the weather better than people.", []],
    ["c3", "character", "The Harbourmistress of Vlissingen-under-Kelp", "", []],
    ["p1", "place", "The Kelp Quay", "Tar, salt, and the guild's flag over everything.", []],
    ["p2", "place", "The winter cafe", "", []],
    ["o1", "poi", "The burnt letter", "Not burnt.", []],
  ];
  // A PICTURE ON THE FIRST ENTRY, because the entry the capture opens on is the
  // first one and a photograph nobody can see is not evidence of anything.
  //
  // THE FILE IS PLANTED AND THE THUMBNAIL IS NOT. The host regenerates a missing
  // thumbnail from the original on the next read -- the cache is an optimization
  // and the original is the record -- so planting only the original exercises
  // that path rather than pre-baking the very thing the capture is meant to show
  // the application producing.
  //
  // The fixture is a SYNTHETIC harbour scene, not anybody's photograph: it
  // stays synthetic, and a picture of a person in a screenshot directory
  // would be the one file here nobody could explain.
  const pictures = projectPath.replace(/\.db$/, "") + ".pictures";
  const stored = "0198c0de-0000-7000-8000-00000000038a.png";
  mkdirSync(pictures, { recursive: true });
  if (withFile) {
    copyFileSync(
      join(import.meta.dir, "..", "fixtures", "demo-portrait.png"),
      join(pictures, stored),
    );
  }
  try {
    for (const [id, kind, name, summary, fields] of people) {
      db.query(
        "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at, picture_path) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
      ).run(id, kind, name, summary, now, id === "c1" ? stored : null);
      fields.forEach(([label, value], ordinal) => {
        db.query(
          "INSERT INTO cast_field (member_id, ordinal, label, value) VALUES (?1, ?2, ?3, ?4)",
        ).run(id, ordinal, label, value);
      });
    }
  } finally {
    db.close();
  }
}

/** Who appears where, planted: every scene in the walk carries somebody, and
 *  the FIRST CONTAINER carries somebody DIRECTLY.
 *
 *  THE DIRECT TAG IS THE POINT OF THE FIXTURE. A container's row in the map
 *  panel can carry two lines -- what the writer tagged on it and what arrived
 *  from the scenes below -- and a plant that only ever tagged scenes would
 *  photograph a panel where one of the two never appears. The map capture's
 *  whole subject is that a reader can tell them apart.
 *
 *  Written with bun:sqlite by hand rather than through the app's own command,
 *  exactly as plantDemoCast and plantDemoStates are: the harness does not
 *  import host source.
 *
 *  IT NEEDS plantDemoCast TO HAVE RUN: the ids below are that function's, and a
 *  tag naming a member that is not there would be refused by the store and
 *  silently invisible here, which is a picture that says the feature does not
 *  work. The caller runs them in that order and this asserts the rows arrived.
 */
function plantDemoAppearances(path: string): void {
  const db = new Database(path);
  try {
    const members = db.query("SELECT id FROM cast_member").all() as { id: string }[];
    if (members.length === 0) {
      throw new Error("--appears needs a cast: plantDemoCast must run before this");
    }
    const rows = db
      .query(
        `WITH RECURSIVE walk(id, parent_id, type, position, path) AS (
           SELECT id, parent_id, type, position, position FROM item WHERE parent_id IS NULL
           UNION ALL
           SELECT i.id, i.parent_id, i.type, i.position, w.path || '/' || i.position
             FROM item i JOIN walk w ON i.parent_id = w.id
         )
         SELECT id, type FROM walk ORDER BY path`,
      )
      .all() as { id: string; type: string }[];
    const scenes = rows.filter((r) => r.type === "scene").slice(0, 4);
    const container = rows.find((r) => r.type !== "scene" && r.type !== "trash");
    if (scenes.length === 0) {
      throw new Error("--appears found no scene in the fixture");
    }
    // A DIFFERENT SET PER SCENE, and one member in two of them, so the union a
    // chapter shows is visibly shorter than the sum of its scenes -- which is
    // the difference between this rollup and the word count's and is the one
    // thing a picture of it can say.
    const plan: Array<[string, string[]]> = [
      [scenes[0]?.id ?? "", ["c1", "p1"]],
      [scenes[1]?.id ?? "", ["c1", "c2", "o1"]],
      [scenes[2]?.id ?? "", ["c3", "p2"]],
      [scenes[3]?.id ?? "", ["c2"]],
    ].filter(([id]) => id !== "") as Array<[string, string[]]>;
    if (container !== undefined) plan.push([container.id, ["p1"]]);
    const known = new Set(members.map((m) => m.id));
    for (const [itemId, ids] of plan) {
      for (const memberId of ids) {
        if (!known.has(memberId)) continue;
        db.query(
          "INSERT OR IGNORE INTO appearance (item_id, cast_member_id) VALUES (?1, ?2)",
        ).run(itemId, memberId);
      }
    }
  } finally {
    db.close();
  }
}

function plantDemoDict(path: string, word: string): void {
  const db = new Database(path);
  try {
    db.query("INSERT INTO dict_word (word, created_at) VALUES (?1, ?2)").run(word, Date.now());
  } finally {
    db.close();
  }
}

if (options.historyDemo) plantDemoHistory(projectPath);
if (options.analyticsDemo) plantAnalyticsDemo(projectPath);
if (options.bibleFolders) {
  const db = new Database(projectPath);
  try {
    const root = db.query("SELECT id FROM item WHERE parent_id IS NULL AND type = 'bible'").get() as { id: string } | null;
    if (root === null) throw new Error("--bible-folders needs a bible root");
    const notes = db.query("SELECT id FROM item WHERE parent_id = ?1 AND type = 'note' ORDER BY position LIMIT 3").all(root.id) as { id: string }[];
    if (notes.length !== 3) throw new Error("--bible-folders needs three direct bible notes");
    db.transaction(() => {
      db.query("INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('shot-bible-folder-people', ?1, 'bible-folder', 'People', '!', 1)").run(root.id);
      db.query("INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('shot-bible-folder-allies', 'shot-bible-folder-people', 'bible-folder', 'Allies', '!', 1)").run();
      db.query("UPDATE item SET parent_id = 'shot-bible-folder-allies' WHERE id = ?1").run(notes[0]!.id);
      db.query("UPDATE item SET parent_id = 'shot-bible-folder-allies' WHERE id = ?1").run(notes[1]!.id);
      db.query("UPDATE item SET parent_id = 'shot-bible-folder-people' WHERE id = ?1").run(notes[2]!.id);
    })();
  } finally {
    db.close();
  }
}
if (options.outlineEmpty || options.outlineLongSynopsis) {
  const db = new Database(projectPath);
  try {
    if (options.outlineEmpty) {
      let bin = db.query("SELECT id FROM item WHERE parent_id IS NULL AND type = 'trash'").get() as { id: string } | null;
      if (bin === null) {
        db.query("INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('shot-outline-bin', NULL, 'trash', 'Trash', 'zzzz', 1)").run();
        bin = { id: "shot-outline-bin" };
      }
      db.query("UPDATE item SET parent_id = ?1 WHERE parent_id IS NULL AND type NOT IN ('trash', 'bible')").run(bin.id);
    }
    if (options.outlineLongSynopsis) {
      // The first scene in manuscript order where the book has part > chapter >
      // scene (tiny), so the clamped synopsis is on screen (242); any scene
      // otherwise, as before.
      const scene = (db.query("SELECT s.id FROM item s JOIN item c ON s.parent_id = c.id JOIN item p ON c.parent_id = p.id WHERE s.type = 'scene' AND p.parent_id IS NULL AND p.type = 'part' ORDER BY p.position, c.position, s.position LIMIT 1").get()
        ?? db.query("SELECT id FROM item WHERE type = 'scene' LIMIT 1").get()) as { id: string } | null;
      if (scene === null) throw new Error("--outline-long-synopsis needs a scene");
      const body = "She follows the map after the harbor lights go out. ".repeat(16).trim();
      db.query("INSERT INTO synopsis (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(item_id) DO UPDATE SET body = excluded.body, rev = synopsis.rev + 1, updated_at = excluded.updated_at").run(scene.id, body, Date.now());
    }
  } finally {
    db.close();
  }
}
if (options.statesDemo) plantDemoStates(projectPath);
if (options.revisionPlanning) plantRevisionPlanning(projectPath);
if (options.craftKnowledge || options.craftReports) plantCraftDemo(projectPath);
// COMMENTS FIRST, MARKS SECOND, and the order is load-bearing: both read the
// first paragraph's FIRST TEXT NODE, and splitting it into marked runs leaves
// that node six characters long. Run the other way round, --comments-demo
// refuses the fixture it was about to annotate. Positions are unmoved by the
// split, so the anchors planted here still cover the words they name.
if (options.commentsDemo) plantDemoComments(projectPath);
if (options.reviewDemo) plantDemoReview(projectPath);
// SUPPRESSED UNDER `sample` (094): that fixture carries a real cast already,
// and planting the demo one over it would bury the thing the capture is meant
// to show. The panel below still opens; it just paints what `sample` holds.
if (options.cast && !isSample) plantDemoCast(projectPath, !options.castMissing);
if (options.castDeleted) {
  const db = new Database(projectPath);
  try {
    const member = db.query("SELECT id FROM cast_member ORDER BY id LIMIT 1").get() as { id: string } | null;
    if (member === null) throw new Error("--cast-deleted needs a seeded cast member");
    db.query("UPDATE cast_member SET deleted_at = ?1 WHERE id = ?2").run(Date.now(), member.id);
  } finally { db.close(); }
}
// --covers-empty SUPPRESSES THE PLANT, which is --appears-empty's lever rather
// than a third flag: the empty state is the one every new book is in and it is
// a different picture, not a different panel.
if (options.covers) plantDemoCovers(projectPath);
// THE VAULT IS A FILE BESIDE settings.json, so it is planted into the isolated
// XDG_DATA_HOME this run already owns rather than into the project -- and the
// PIN is a `meta` row, planted the way --covers plants its two. Both routes are
// the ones the host itself writes, which is what keeps a capture a picture of
// the application rather than of the rig.
//
// --identities-empty SUPPRESSES THE PLANT, which is --covers-empty's lever: an
// empty vault is the state every library is in today and it is a different
// picture, not a different panel.
if (options.identities) plantDemoIdentities(appDataHome, projectPath, options.identitiesRepin);
if (options.warningHistory) {
  const db = new Database(projectPath);
  try {
    db.query("INSERT INTO meta (key, value) VALUES (?1, ?2)").run(
      "preflight.warning_reasons",
      JSON.stringify({ version: 1, entries: [{
        check: "identity_unset", format: "markdown", surface: "project",
        item_id: null, offset: null, fingerprint: "0".repeat(16),
        reason: "Shared without a byline for a private review.", at_ms: Date.UTC(2026, 8, 1),
      }] }),
    );
  } finally {
    db.close();
  }
}
// THE FOUR OPTIONS, written the way `chapter_style_set` would write them --
// two `meta` rows and no migration, exactly as --covers plants the two cover
// rows. The only route a writer has is the rail itself, and a capture that had
// to drive four presses to reach the state it is photographing would be
// photographing the presses.
if (options.previewStyled) plantChapterStyle(projectPath);
// THE CAST FIRST AND THE TAGS SECOND, and the order is load-bearing rather than
// tidy: an appearance names a cast member, and one planted before the member
// exists is a row the store would have refused and the panel cannot draw.
// --appears-empty SUPPRESSES THE PLANT for whichever panel is being opened,
// which is what makes it the lever for an empty state rather than a third flag
// per panel.
// SUPPRESSED UNDER `sample`, for the reason --cast's plant is: the fixture's
// own cast and appearances are the real thing, so nothing is planted over
// them and the map panel opens on what `sample` already holds.
if ((options.appears || options.appearsMap) && !options.appearsEmpty && !isSample) {
  plantDemoCast(projectPath, false);
  plantDemoAppearances(projectPath);
}
if (options.marksDemo) plantDemoMarks(projectPath);
if (options.dictWord !== null) plantDemoDict(projectPath, options.dictWord);

mkdirSync(dirname(options.out), { recursive: true });

try {
  console.log(
    `[2/3] booting the shell (desktop scheme ${options.scheme}, app theme ${options.theme})`,
  );
  await runShell<{ ready: boolean; error?: string; rows: number; startup_ms: number }>({
    mode: "virtual",
    soakMs: 0,
    staged: DIST,
    serverArgs: serverArgsFor(options.size),
    env: {
      APP_RUN: "interactive",
      // Omitted for --first-run: an empty data home with no APP_PROJECT is
      // the whole point of that capture -- the host's own starter scene,
      // rather than a seeded fixture. Omitted for --library/--library-empty/
      // --library-form too: those want NOTHING mounted so `start=home`'s own
      // screen shows, which an explicit APP_PROJECT would skip entirely.
      // --library-over-book is the one library flag that DOES want a book
      // open, so it is not in this list.
      ...(options.firstRun === null && !options.blank && !options.library && !options.libraryEmpty
        ? { APP_PROJECT: projectPath }
        : {}),
      GDK_BACKEND: "x11",
      // Passed through so a --projects capture can show real rows in the
      // import list. Unset it and the panel shows the empty-state line, which
      // is also worth capturing and is what a first-run reader sees.
      ...(process.env.APP_IMPORT_DIR === undefined
        ? {}
        : { APP_IMPORT_DIR: process.env.APP_IMPORT_DIR }),
      // The two levers, in this order. The portal wins whenever it can be
      // reached, so the bus has to go first or the GTK setting below is inert.
      //
      // NOT applied for a --projects capture. AT-SPI is on the same session bus
      // the portal is, so cutting it makes the Projects button unlocatable and
      // the run dies reporting "not exactly one matching application" — a
      // message about the probe that is really about this line. A panel capture
      // therefore takes the DESKTOP's scheme as it finds it and forces the
      // palette with --theme, which is the application's own preference and
      // needs no bus at all.
      // Keyed on "is a panel being opened", NOT on --projects alone. When
      // --prefs arrived, this condition still named the older flag and the bus
      // was cut for a capture that needed it, which failed as exit 4 from the
      // probe -- the same message, in the same place, that the paragraph above
      // exists to explain.
      // --cast-edit (096) added to the list for the reason --hover and
      // --status are on it: it takes an AT-SPI walk (the same mechanism
      // --press uses) and that walk is on this same bus. Its own validation
      // already refuses it alongside --scheme, but refusing the combination
      // does not put the bus back for the ordinary case where --scheme was
      // never asked for -- this line was still cutting it unconditionally,
      // which is the exit-4 "could not read widget geometry from AT-SPI"
      // this comment exists to explain for the older three. --press shared
      // the same gap from 077 until 111, recorded in the 096 write-back as a
      // pre-existing issue and finally on the list below: its walk is on
      // this bus like every other.
      // --synopsis-edit (097) added for the identical reason: it takes the
      // same AT-SPI walk `--cast-edit` does. --cast-card (098) too, though its
      // own walk reads the editable's text interface rather than a DOM id
      // (see the option's own comment below for why) -- it is still a walk on
      // this bus and needs it kept open the same way.
      // --projects and --prefs LEFT this list in 243. Both open by keystrokes
      // through the menu now (no walk), yet the bus stayed up for them, so the
      // portal answered with the operator's desktop scheme and `--scheme light
      // --prefs` photographed a dark page while the log said "desktop scheme
      // light" (237's 07-prefs-light). The rig, not the app.
      ...(options.outlineView !== null ||
      options.hover !== null ||
      options.press !== null ||
      options.craftKnowledge ||
      options.craftReports ||
      options.status ||
      options.castEdit ||
      options.castCard ||
      // --cast-alias (105) too, `--cast-card`'s own reason one narrower.
      options.castAlias ||
      options.synopsisEdit ||
      options.libraryForm ||
      options.warningHistory ||
      options.hostError ||
      options.analytics ||
      // --timeline, --timeline-card and --timeline-edit press Fit (and, for
      // the latter two, an event and Edit) by NAME, `--cast-edit`'s own
      // reason: a walk on this bus, so it must stay reachable. --timeline-
      // empty needs none of it -- New timeline is a menu press by id and
      // opening the fresh row is the same arithmetic bible-cli.ts uses for a
      // reserved-root child, no walk at all. --timeline-branch,
      // --timeline-swapped, --timeline-scale and --timeline-far (103) all
      // press Fit too, plus their own second press, so they join this list
      // for the same reason.
      options.timeline ||
      options.timelineCard ||
      options.timelineEdit ||
      options.timelineBranch ||
      options.timelineSwapped ||
      options.timelineScale ||
      options.timelineFar
        ? {}
        : { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" }),
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: appDataHome,
    },
    // A screenshot has nothing to say about the accessibility tree, and the
    // probe costs a ~12 s synchronous walk of the whole application.
    probeA11y: false,
    onReady: async ({ displayNum, rootPid }) => {
      if (displayNum === null) throw new Error("the screenshot rig requires a fixed X display");
      const display = `:${displayNum}`;
      const wid = findWindowId(display);
      // Read back what actually opened: nothing else falsifies that "window"
      // is the settings.json key the host reads, and a silent rename in
      // projects.rs would open every --size capture at the host's own
      // default under a filename claiming the size that was asked for. Read
      // unconditionally now (not only under --size): --press needs the same
      // geometry to know whether the point it is about to click actually
      // falls inside the window.
      const geometry = parseGeometry(xdo(display, ["getwindowgeometry", "--shell", wid]));
      if (options.size !== null && (geometry.width !== options.size.width || geometry.height !== options.size.height)) {
        throw new Error(
          `--size asked for ${options.size.width}x${options.size.height} but the window opened ` +
            `at ${geometry.width}x${geometry.height}: settings.json's window field was not honoured`,
        );
      }
      await Bun.sleep(PAINT_SETTLE_MS);

      // --projects and --prefs are in this list as of the retirement slice: they
      // send Alt+F now rather than clicking a located button, and a key send not
      // preceded by this guard is a key send with no evidence behind it. An
      // unfocused window swallows the chord, which reads exactly like the page
      // ignoring it.
      if (
        options.type !== null ||
        options.find !== null ||
        options.menu !== null ||
        options.shortcuts ||
        options.navContext ||
        options.menuItem !== null ||
        options.outlineView !== null ||
        options.continuous ||
        options.reference ||
        options.projects ||
        options.prefs ||
        options.compare ||
        options.comments ||
        options.synopsis !== null ||
        options.revisionPlanning ||
        options.craftKnowledge ||
        options.craftReports ||
        options.bookDesign ||
        options.covers ||
        options.coversEmpty ||
        options.identities ||
        options.identitiesEmpty ||
        options.warningHistory ||
        options.previewFormat !== null ||
        options.matterDemo ||
        options.timelineRow ||
        options.timeline ||
        options.timelineCard ||
        options.timelineEdit ||
        options.timelineEmpty ||
        options.timelineBranch ||
        options.timelineSwapped ||
        options.timelineScale ||
        options.timelineFar ||
        options.cast ||
        options.castEmpty ||
        options.appears ||
        options.appearsEmpty ||
        options.appearsMap ||
        options.stats ||
        options.analytics ||
        options.status ||
        options.selectWord ||
        options.libraryOverBook ||
        options.libraryForm ||
        options.firstRun !== null
      ) {
        // windowfocus / getwindowfocus, never windowactivate / getactivewindow:
        // the developer's XWayland does not answer EWMH active-window queries,
        // and typing into whatever happens to be focused once put test
        // sentences into the operator's live terminal.
        //
        // Hoisted out of the --find branch when --type arrived, so the guard
        // runs exactly once and covers all three. Two copies would be two
        // chances to drift, and the failure mode of the one that drifted is
        // keystrokes in somebody else's window.
        //
        // --menu was ADDED to this condition after its first capture came back
        // with the menu bar painted and no dropdown: Alt+F had been sent to an
        // unfocused window, which reads exactly like the page ignoring the
        // chord. A key send that is not preceded by this guard is a key send
        // with no evidence behind it.
        xdo(display, ["windowfocus", wid]);
        const focused = xdo(display, ["getwindowfocus"]);
        if (focused !== wid) {
          throw new Error(
            `refusing to type: keyboard focus is window ${focused}, not the app's ${wid}.`,
          );
        }
      }

      if (options.selectWord) {
        // The mount focuses the editor, so this needs no click, and this runs
        // BEFORE anything that could move focus off it (a menu, a panel), for
        // the reason the focus guard just ran: a chord sent to whatever
        // happens to be focused is a chord with no evidence behind it.
        // Ctrl+Shift+Right is ProseMirror's extend-by-word through
        // baseKeymap, so this selects the first run --marks-demo planted (or,
        // without that flag, just the fixture's first word) rather than
        // moving the caret.
        xdo(display, ["key", "--window", wid, "ctrl+shift+Right"]);
        // The bubble paints 250 ms after a selection comes to rest; this
        // sleeps past that with margin rather than the debounce's own length,
        // because a capture timed to the exact figure is the one most likely
        // to race a slow paint and come back with no bubble in it.
        await Bun.sleep(600);
      }

      if (options.type !== null) {
        // The mount focuses the editor, so this needs no click. Ctrl+a is
        // ProseMirror's selectAll through baseKeymap; the first paragraph then
        // REPLACES the seeded body rather than joining it.
        xdo(display, ["key", "--window", wid, "ctrl+a"]);
        await Bun.sleep(250);
        const paragraphs = options.type.split("\\n");
        for (const [i, paragraph] of paragraphs.entries()) {
          // Return between paragraphs, not inside the typed string: xdotool
          // would send it as a keystroke either way, but splitting here is what
          // lets the caller write \n in a shell argument without quoting games.
          if (i > 0) xdo(display, ["key", "--window", wid, "Return"]);
          xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), paragraph]);
        }
        await Bun.sleep(TYPE_SETTLE_MS);

        if (options.fade !== null) {
          // The fade arms 1500 ms after the first keystroke and runs 1000 ms;
          // TYPE_SETTLE_MS has already slept 2500 ms since the LAST one. Sleep
          // past the end with margin rather than to the figure, for the reason
          // --select-word gives: a capture timed to the exact number is the one
          // most likely to race it.
          await Bun.sleep(1500);
          if (options.fade === "woken") {
            // A displacement, not a position: the module ignores a mousemove at
            // the same coordinates (decision 2 of the 071 plan), so this moves
            // the pointer BY 40px from wherever the window mapped it. 400 ms is
            // the 120 ms wake with margin.
            xdo(display, ["mousemove_relative", "--", "40", "40"]);
            await Bun.sleep(400);
          }
        }

        if (options.selectLastWord) {
          // Backwards from the caret --type left at the line's end: the
          // last word typed, selected, and the bubble 250 ms later (same
          // margin --select-word gives).
          xdo(display, ["key", "--window", wid, "ctrl+shift+Left"]);
          await Bun.sleep(600);
        }
      }

      // NO AT-SPI WALK. Both panels used to be opened by locating a toggle in
      // the accessibility tree and clicking its centre, because each toggle sat
      // after elements whose width is data (the open project's name, the word
      // count) and no arithmetic finds them. The retirement slice deleted both
      // toggles, so the route is now the application menu - driven by
      // keystrokes, through the shared driver, which reads the item's index out
      // of menu-bar.ts rather than restating it.
      //
      // That is a straight gain, not merely a port. The walk was the ONLY reason
      // --projects and --prefs could not be combined with --scheme (--scheme
      // works by making the session bus unreachable, and AT-SPI is on that bus).
      // They compose now, exactly as --menu already did.
      const panelItem = options.projects
        ? "menu-project-open"
        : options.prefs
          ? "menu-preferences"
          : null;
      if (panelItem !== null) {
        await localizedMenuDriver(display, wid).activate(panelItem);
      }
      if (options.prefs && options.prefsScroll > 0) {
        // --preview-scroll's own mechanism: the real pointer and a bare wheel
        // click (a `--window` click is synthetic and WebKit ignores it for
        // scrolling). The point is inside #prefs-panel, restated from
        // style.css: 384px wide, 12px from the right of the default 1200px
        // window, hung below the 39px header.
        await Bun.sleep(PAINT_SETTLE_MS);
        xdo(display, ["mousemove", String(1200 - 12 - 192), "300"]);
        for (let n = 0; n < options.prefsScroll; n += 1) {
          xdo(display, ["click", "5"]);
          await Bun.sleep(20);
        }
        // Off the panel, so no row is photographed hovered.
        xdo(display, ["mousemove", "20", "780"]);
        await Bun.sleep(PAINT_SETTLE_MS);
      }

      if (options.status) {
        // ONE AT-SPI walk, the same one --hover takes and for the same reason:
        // the dot sits at the end of a strip whose earlier items are data, so
        // arithmetic cannot find it. It is a <button>, so `push button` in
        // nodes.ts's role set sees it.
        const node = locateNodes(rootPid).find((n) => n.id === "status-dot");
        if (node === undefined) {
          throw new Error("--status: no control with id status-dot in the accessibility tree");
        }
        const at = centreOf(node);
        // Move, then a bare `click`: a `click --window` is a synthetic event
        // the toolkit drops (the recorded rule every rig's press follows).
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(PAINT_SETTLE_MS);
      }

      if (options.compare) {
        // Through the shared driver, by ID: the route is read out of
        // menu-bar.ts, so an item inserted above History moves this capture
        // with it rather than opening whatever now sits at a restated index.
        await localizedMenuDriver(display, wid).activate("menu-history");
        await Bun.sleep(TYPE_SETTLE_MS);
        // The panel focuses the snapshot NAME FIELD when it opens, and the
        // field is the first focusable after the version list - so one
        // Shift+Tab lands on the last row's Compare button, which is the OLDEST
        // planted version and the one carrying different prose. No AT-SPI walk,
        // so --compare composes with --scheme; no coordinates, so it cannot
        // press a row the panel has scrolled out from under it.
        xdo(display, ["key", "--window", wid, "shift+Tab"]);
        await Bun.sleep(KEY_STEP_MS * 2);
        xdo(display, ["key", "--window", wid, "Return"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.comments) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above Comments moves this capture with
        // it rather than opening whatever now sits at a restated index.
        await localizedMenuDriver(display, wid).activate("menu-comments");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.synopsis !== null) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above Synopsis moves this capture with
        // it rather than opening whatever now sits at a restated index.
        await localizedMenuDriver(display, wid).activate("menu-synopsis");
        await Bun.sleep(TYPE_SETTLE_MS);
        // ONLY ON A ROW WITH NOTHING WRITTEN (097): an empty synopsis opens
        // straight into Edit with the caret already in the field, which is
        // what lets this type with no click and no coordinate. A row that
        // HAS one -- `sample`'s scenes, the only fixture that plants any --
        // opens in READ instead, so there is no caret here to type into; the
        // suppression below already keeps this branch off that fixture, and
        // an empty string on any other fixture types nothing and captures the
        // empty state.
        if (options.synopsis !== "" && !isSample) {
          xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), options.synopsis]);
          await Bun.sleep(TYPE_SETTLE_MS);
        }
        if (options.synopsisEdit) {
          // ONE AT-SPI WALK, `--cast-edit`'s own reason: Read is the panel's
          // default on a row that has anything written, and `#synopsis-edit`
          // is what shows the field underneath it. `--press`'s own mechanism,
          // reused directly, and subject to the same rule its validation
          // above enforces: last, and alone in the window.
          const node = nodeToPress(
            locateNodes(rootPid),
            parsePressSelector("id:synopsis-edit"),
            "--synopsis-edit",
          );
          const at = pressPoint(node, geometry);
          xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
          xdo(display, ["click", "1"]);
          await Bun.sleep(PRESS_SETTLE_MS);
        }
      }

      if (options.matterDemo) {
        // FOUR REAL PRESSES, not a plant. Every other section in this
        // application is created by pressing the item that makes it, and the
        // whole point of this capture is what the navigator looks like
        // AFTERWARDS -- which is a fact about the create path as much as about
        // the stylesheet. Each press builds its section on the first of its
        // kind and reuses it on the second, so four presses make two sections
        // holding two pages each.
        //
        // By ID through the shared driver, which reads each item's index out of
        // menu-bar.ts: four restated indices would be four ways to press the
        // wrong item silently.
        const driver = localizedMenuDriver(display, wid);
        for (const itemId of [
          "menu-new-dedication",
          "menu-new-foreword",
          "menu-new-acknowledgements",
          "menu-new-afterword",
        ]) {
          await driver.activate(itemId);
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.timelineRow) {
        // ONE REAL PRESS, `matterDemo`'s own argument: the create path
        // builds the bible root the first time nothing is there, so the
        // picture is of what New timeline actually produces, not of a row
        // this rig invented by writing SQL. Nothing in the navigator starts
        // collapsed (see the flag's own comment), so the freshly made bible
        // root and its one timeline are both on screen the moment this
        // settles -- no expand, no AT-SPI walk.
        await localizedMenuDriver(display, wid).activate("menu-new-timeline");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      // OPENED THROUGH QUICK OPEN, NOT A COMPUTED ROW COORDINATE. Every
      // other capture that needs a SPECIFIC navigator row open (unlike a
      // fresh create, which the boot's own selection or `--timeline-row`'s
      // press already puts on screen) reaches it by keyboard: Ctrl+P, the
      // title, Return -- the same route a writer takes, and one that does
      // not drift with the navigator's row height or the bible's own
      // position among the reserved roots. TAKES THE TITLE AS AN ARGUMENT,
      // NOT A FIXED "Timeline" (review, RIG-FOUND): the sample fixture's own
      // bible already holds a note titled "Timeline of Events", a title
      // match ties with by matchItems' own prefix rule (both start with
      // "Timeline"), and the two then rank by walk order -- which put the
      // pre-existing note ahead of the freshly planted timeline on every
      // rig run, so Fit was never found ("no control with name Fit") on the
      // row that actually opened. `--timeline-empty` presses `menu-new-
      // timeline` itself (`timeline.untitled` in the selected catalog) and
      // stays on that word -- `tiny`, its own fixture, holds nothing
      // whose title so much as CONTAINS "timeline" (checked against
      // lab/fixtures/out/tiny's own project.json, records.ndjson and
      // scenes.ndjson), so nothing there can tie with it the way sample's
      // note does.
      const openTimelineByQuickOpen = async (title: string): Promise<void> => {
        xdo(display, ["key", "--window", wid, "ctrl+p"]);
        await Bun.sleep(TYPE_SETTLE_MS);
        xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), title]);
        await Bun.sleep(TYPE_SETTLE_MS);
        xdo(display, ["key", "--window", wid, "Return"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      };

      if (options.timeline || options.timelineCard || options.timelineEdit) {
        await openTimelineByQuickOpen(timelineTitle);

        // Fit, so the whole planted document (12 events) is framed --
        // pressed by NAME, one AT-SPI walk.
        const fitNodes = locateNodes(rootPid);
        const fitBtn = nodeToPress(fitNodes, parsePressSelector("name:Fit"), "--timeline");
        const fitAt = pressPoint(fitBtn, geometry);
        xdo(display, ["mousemove", "--window", wid, String(fitAt.x), String(fitAt.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(TYPE_SETTLE_MS);

        if (options.timelineCard || options.timelineEdit) {
          // The corpus's first event, by its generated title. A SECOND
          // walk: --timeline-card and --timeline-edit both refuse --press,
          // --hover, --status and --scheme for the same "one walk per
          // capture" reason --cast-edit does, and are not held to it
          // themselves precisely because they need this second one.
          const eventNodes = locateNodes(rootPid);
          const eventBtn = nodeToPress(eventNodes, parsePressSelector(`name:${timelineFirstEventTitle}`), "--timeline-card");
          const eventAt = pressPoint(eventBtn, geometry);
          xdo(display, ["mousemove", "--window", wid, String(eventAt.x), String(eventAt.y)]);
          xdo(display, ["click", "1"]);
          await Bun.sleep(TYPE_SETTLE_MS);

          if (options.timelineEdit) {
            // A THIRD walk, `nodeToPress` finding Edit on the now-open
            // card. Refused alongside --press et al. below for the same
            // "one walk" rule those flags already enforce for two; a third
            // capture mode paying a third walk is the ceiling this file's
            // own gotcha names, not a new one.
            const cardNodes = locateNodes(rootPid);
            const editBtn = nodeToPress(cardNodes, parsePressSelector("name:Edit"), "--timeline-edit");
            const editAt = pressPoint(editBtn, geometry);
            xdo(display, ["mousemove", "--window", wid, String(editAt.x), String(editAt.y)]);
            xdo(display, ["click", "1"]);
            await Bun.sleep(TYPE_SETTLE_MS);
          }
        }
      }

      if (options.timelineBranch || options.timelineSwapped) {
        // 103's own two: the seed plants ONE branch ("Danse wins", forked
        // at 0) with one event on it (see the seed's own comment above).
        await openTimelineByQuickOpen(timelineTitle);

        const fitNodes = locateNodes(rootPid);
        const fitBtn = nodeToPress(fitNodes, parsePressSelector("name:Fit"), "--timeline-branch");
        const fitAt = pressPoint(fitBtn, geometry);
        xdo(display, ["mousemove", "--window", wid, String(fitAt.x), String(fitAt.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(TYPE_SETTLE_MS);

        if (options.timelineSwapped) {
          // A SECOND walk, `--timeline-card`'s own reason: this picture is
          // of the swap having ALREADY HAPPENED (the design's own "a branch
          // as the one being written"), not of the button that starts it.
          const writeNodes = locateNodes(rootPid);
          const writeBtn = nodeToPress(
            writeNodes,
            parsePressSelector("name:Make this the one I am writing"),
            "--timeline-swapped",
          );
          const writeAt = pressPoint(writeBtn, geometry);
          xdo(display, ["mousemove", "--window", wid, String(writeAt.x), String(writeAt.y)]);
          xdo(display, ["click", "1"]);
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.timelineScale) {
        // --timeline's own seed and Fit, then a SECOND walk pressing "Edit
        // scale…" so the scale panel (103) is what the capture shows.
        await openTimelineByQuickOpen(timelineTitle);

        const fitNodes = locateNodes(rootPid);
        const fitBtn = nodeToPress(fitNodes, parsePressSelector("name:Fit"), "--timeline-scale");
        const fitAt = pressPoint(fitBtn, geometry);
        xdo(display, ["mousemove", "--window", wid, String(fitAt.x), String(fitAt.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(TYPE_SETTLE_MS);

        const scaleNodes = locateNodes(rootPid);
        const editScaleBtn = nodeToPress(scaleNodes, parsePressSelector("name:Edit scale…"), "--timeline-scale");
        const editScaleAt = pressPoint(editScaleBtn, geometry);
        xdo(display, ["mousemove", "--window", wid, String(editScaleAt.x), String(editScaleAt.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.timelineFar) {
        // --timeline's own seed and Fit, then repeated presses of the SAME
        // located Zoom out button -- its position does not move while only
        // the lanes repaint, so this stays a single AT-SPI walk regardless
        // of how many presses it takes to collapse the planted cluster
        // into dots ("far-out with collapsed dots", design section 5).
        await openTimelineByQuickOpen(timelineTitle);

        const fitNodes = locateNodes(rootPid);
        const fitBtn = nodeToPress(fitNodes, parsePressSelector("name:Fit"), "--timeline-far");
        const fitAt = pressPoint(fitBtn, geometry);
        xdo(display, ["mousemove", "--window", wid, String(fitAt.x), String(fitAt.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(TYPE_SETTLE_MS);

        const zoomOutNodes = locateNodes(rootPid);
        const zoomOutBtn = nodeToPress(zoomOutNodes, parsePressSelector("name:Zoom out"), "--timeline-far");
        const zoomOutAt = pressPoint(zoomOutBtn, geometry);
        xdo(display, ["mousemove", "--window", wid, String(zoomOutAt.x), String(zoomOutAt.y)]);
        const ZOOM_OUT_PRESSES = 12;
        xdo(display, ["click", "--repeat", String(ZOOM_OUT_PRESSES), "--delay", "80", "1"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.timelineEmpty) {
        // --timeline-row's own press: a fresh timeline, no ndjson, no
        // tracks, no events -- `EMPTY_TIMELINE_BODY`'s shape. This is what
        // `--timeline-row` alone never does: open what it just created, so
        // the empty state ("No events yet…") is actually on screen. STAYS
        // ON `timeline.untitled` from the selected catalog: the menu press
        // cannot be given a different title, and nothing in the tiny fixture
        // collides with it -- see openTimelineByQuickOpen's own comment.
        await localizedMenuDriver(display, wid).activate("menu-new-timeline");
        await Bun.sleep(TYPE_SETTLE_MS);
        await openTimelineByQuickOpen(timelineUntitled);
      }

      if (options.firstRun !== null) {
        // Whatever menu ids were named (the default two, or none), in order,
        // on the fresh empty data home this run already booted. 1200 ms
        // between presses is the settle the standalone first-run capture
        // this flag folds into (079) used.
        const driver = localizedMenuDriver(display, wid);
        for (const itemId of options.firstRun) {
          await driver.activate(itemId);
          await Bun.sleep(1200);
        }
      }

      if (options.bookDesign) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above Book design moves this capture
        // with it rather than opening whatever now sits at a restated index.
        //
        // NOTHING IS TYPED AND NOTHING IS CLICKED. The panel takes focus itself
        // and paints from the host the moment it opens, so this capture needs
        // no coordinate and no second AT-SPI walk -- which is what lets it
        // compose with --scheme.
        await localizedMenuDriver(display, wid).activate("menu-book-design");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.covers || options.coversEmpty) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above Covers moves this capture with it
        // rather than opening whatever now sits at a restated index.
        //
        // NOTHING IS TYPED AND NOTHING IS CLICKED, exactly as --book-design
        // does it: the panel takes focus itself and paints from the host the
        // moment it opens, so this capture needs no coordinate and no second
        // AT-SPI walk -- which is what lets it compose with --scheme.
        await localizedMenuDriver(display, wid).activate("menu-covers");
        await Bun.sleep(TYPE_SETTLE_MS);
        if (options.coversFull) {
          // The panel focuses ITSELF and is not a tab stop, so Tab reaches the
          // first control in it (Change cover…) and a second reaches View full
          // size. Counted keystrokes rather than a located coordinate, for the
          // reason --cast sends three Tabs: a walk would cost this capture its
          // ability to compose with --scheme.
          for (const key of ["Tab", "Tab", "Return"]) {
            xdo(display, ["key", "--window", wid, key]);
            await Bun.sleep(KEY_STEP_MS);
          }
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.identities || options.identitiesEmpty || options.warningHistory) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts, exactly as --covers does: an item inserted above this one
        // moves the capture with it rather than opening whatever now sits at a
        // restated index.
        await localizedMenuDriver(display, wid).activate("menu-identities");
        await Bun.sleep(TYPE_SETTLE_MS);
        if (options.identitiesReport || options.warningHistory) {
          // The panel focuses ITSELF and is not a tab stop, and its two list
          // controls are ABOVE the list precisely so their position does not
          // depend on how many pen names the library holds -- which is what
          // makes a counted Tab safe here where it would not be below the list.
          // Tab 1 is New pen name, Tab 2 is the report.
          for (const key of ["Tab", "Tab", "Return"]) {
            xdo(display, ["key", "--window", wid, key]);
            await Bun.sleep(KEY_STEP_MS);
          }
          await Bun.sleep(TYPE_SETTLE_MS);
          if (options.warningHistory) {
            const nodes = locateNodes(rootPid);
            if (!nodes.some((node) => node.id === "preflight-close") ||
                !nodes.some((node) => node.id === "preflight-reason-record-0")) {
              mkdirSync(dirname(options.out), { recursive: true });
              Bun.spawnSync(["import", "-window", wid, options.out + ".failed.png"], { env: { ...process.env, DISPLAY: display } });
              throw new Error("--warning-history did not open a current warning with a reason control: " + nodes.map((node) => node.id).filter(Boolean).join(", "));
            }
          }
        }
        if (options.identitiesEdit || options.identitiesRepin) {
          // New, report, first row name, then its pin and Update controls. The panel
          // keeps list controls above rows, so the route is stable here.
          const keys = options.identitiesEdit
            ? ["Tab", "Tab", "Tab", "Return"]
            : ["Tab", "Tab", "Tab", "Tab", "Tab", "Return"];
          for (const key of keys) {
            xdo(display, ["key", "--window", wid, key]);
            await Bun.sleep(KEY_STEP_MS);
          }
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.libraryOverBook) {
        // The screen as a view over an open book: a normal seeded
        // boot (APP_PROJECT is set for this flag, unlike the other three
        // library ones), then File > Library… over it.
        await localizedMenuDriver(display, wid).activate("menu-library");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.hostError) {
        const node = nodeToPress(locateNodes(rootPid), parsePressSelector("id:library-membership-open"), "--host-error");
        const at = pressPoint(node, geometry);
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(PRESS_SETTLE_MS);
      }

      if (options.libraryForm) {
        // `--library` already booted straight into the screen (`start=home`,
        // no APP_PROJECT); this presses "New pen name…" by name through the
        // same located-node route `--synopsis-edit` uses, so the inline form
        // is what the picture holds.
        const node = nodeToPress(
          locateNodes(rootPid),
          parsePressSelector("id:library-new-pen-name"),
          "--library-form",
        );
        const at = pressPoint(node, geometry);
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(PRESS_SETTLE_MS);
      }

      if (options.previewFormat !== null) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: this item sits BELOW the exports, which is where 043 put
        // it so the debounce window `export-cli` spends walking down to Export
        // is unchanged -- and reading the index rather than restating it is
        // what makes that safe to have done.
        //
        // NOTHING IS TYPED AND NOTHING IS CLICKED. The rail takes focus itself
        // and renders from the host the moment it opens, so this capture needs
        // no coordinate and no second AT-SPI walk -- which is what lets it
        // compose with --scheme.
        await localizedMenuDriver(display, wid).activate(`menu-${options.previewFormat}-preview`);
        // A WHOLE EPUB RENDER, not a repaint. The rail drains the flush
        // scheduler and then renders the book; at the `tiny` fixture that is
        // tens of milliseconds, and this waits for the settle the other panels
        // wait for plus one, because a capture taken mid-render photographs an
        // empty frame and reads as a broken feature.
        // A WHOLE RENDER, not a repaint, and a PROOF costs more than an
        // archive: the host loads the book into a second web view, that
        // document's own script cuts it into leaves, and only then does the
        // rail get anything to paint. A capture taken mid-render photographs
        // an empty frame and reads as a broken feature.
        await Bun.sleep(TYPE_SETTLE_MS * (options.previewFormat === "pdf" ? 8 : 2));
        if (options.previewScroll > 0) {
          // A WHEEL AND NOT A KEY. The rail takes focus itself and Page Down
          // would scroll whichever of the two scrollers has it; the pointer
          // says which box to move without depending on focus at all.
          //
          // THE COORDINATE IS THE RAIL'S OWN WIDTH SUBTRACTED FROM THE
          // WINDOW'S, and both numbers are restated here rather than measured:
          // `#preview-rail` is 380px in style.css and the shell opens at
          // 1200x800. A walk would cost this capture its ability to compose
          // with --scheme, which is the same trade --cast and --covers make
          // when they count keystrokes instead of locating a control.
          const x = 1200 - 190;
          const y = 500;
          // NO `--window`, unlike every click in this file. `xdotool click
          // --window` sends a SYNTHETIC button event, and WebKit's scroll
          // handling ignores one: the first attempt at this capture came back
          // with the preview still at the top of the book. Moving the real
          // pointer and clicking is what a wheel actually is, and under Xvfb
          // there is no other window for it to land in.
          xdo(display, ["mousemove", String(x), String(y)]);
          for (let n = 0; n < options.previewScroll; n += 1) {
            xdo(display, ["click", "5"]);
            await Bun.sleep(20);
          }
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.cast || options.castEmpty) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above Cast moves this capture with it
        // rather than opening whatever now sits at a restated index.
        //
        // NOTHING IS TYPED AND NOTHING IS CLICKED. The panel reads the store
        // when it opens, and the rows it paints were planted before the process
        // started -- so this capture needs no coordinate and no second AT-SPI
        // walk, which is what lets it compose with --scheme.
        await localizedMenuDriver(display, wid).activate("menu-cast");
        await Bun.sleep(TYPE_SETTLE_MS);
        if (options.cast) {
          // ONE TAB AND A RETURN (096, down from three before it). The panel
          // now takes focus ON ITSELF rather than on `#cast-new-name`, because
          // 096 collapsed the add row by default -- it used to sit open above
          // the list, which is what the old three-tab count crossed (name,
          // kind, the button). With it collapsed, the very first Tab from the
          // panel reaches the FIRST entry directly, regardless of how many the
          // open cast holds, which is what lets this compose with `sample`'s
          // real cast as well as the demo one below. A button answers Return
          // with a click, so this selects the first entry and opens it in
          // Read -- 096's default -- painting the sheet beside the list.
          xdo(display, ["key", "--window", wid, "Tab"]);
          await Bun.sleep(KEY_STEP_MS);
          xdo(display, ["key", "--window", wid, "Return"]);
          await Bun.sleep(TYPE_SETTLE_MS);
        }
        if (options.castEdit) {
          // ONE AT-SPI WALK, taken here rather than more keyboard: how many
          // Tabs separate the selected entry from `#cast-edit` depends on how
          // many siblings the open cast has (each remaining entry is one more
          // stop, then the foot-of-list Add… toggle, then the sheet), and
          // `sample`'s real cast and the demo one above plant different
          // counts -- a fixed number would be right for one and silently
          // wrong for the other. `--press`'s own mechanism, reused directly
          // rather than re-implemented, and subject to the same rule its
          // validation above enforces: last, and alone in the window.
          const node = nodeToPress(locateNodes(rootPid), parsePressSelector("id:cast-edit"), "--cast-edit");
          const at = pressPoint(node, geometry);
          xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
          xdo(display, ["click", "1"]);
          await Bun.sleep(PRESS_SETTLE_MS);
        }
      }

      if ((options.appears || options.appearsEmpty) && !options.appearsMap) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above this one moves the capture with
        // it rather than opening whatever now sits at a restated index.
        //
        // NOTHING IS TYPED AND NOTHING IS CLICKED, and unlike --cast nothing is
        // TABBED either: this panel takes focus itself and paints its whole
        // surface from the store the moment it opens. So the capture needs no
        // coordinate and no second AT-SPI walk, which is what lets it compose
        // with --scheme.
        await localizedMenuDriver(display, wid).activate("menu-appears");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.appearsMap) {
        await localizedMenuDriver(display, wid).activate("menu-appears-map");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.stats) {
        // By ID through the shared driver, which reads the item's index out of
        // menu-bar.ts: an item inserted above Statistics moves this capture with
        // it rather than opening whatever now sits at a restated index.
        await localizedMenuDriver(display, wid).activate("menu-statistics");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.analytics) {
        await localizedMenuDriver(display, wid).activate("menu-analytics");
        await Bun.sleep(TYPE_SETTLE_MS);
        const close = locateNodes(rootPid).find((node) => node.id === "analytics-close");
        if (!close || close.w <= 0 || close.h <= 0 || close.y < 0 || close.y >= geometry.height) {
          throw new Error("Analytics did not open visibly; refusing a mislabeled capture");
        }
      }

      if (options.revisionPlanning) {
        await localizedMenuDriver(display, wid).activate("menu-revision-state");
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.craftKnowledge || options.craftReports) {
        await localizedMenuDriver(display, wid).activate(options.craftKnowledge ? "menu-knowledge" : "menu-craft-reports");
        await Bun.sleep(TYPE_SETTLE_MS);
        if (options.press === null) {
          const expected = options.craftKnowledge ? "craft-import-file" : "craft-run-report";
          if (!locateNodes(rootPid).some((node) => node.id === expected)) {
            throw new Error(`--craft: ${expected} is not exposed after menu activation`);
          }
        }
      }

      if (options.menu !== null) {
        const id = MENU_IDS.get(options.menu);
        if (id === undefined) throw new Error(`no id for menu ${options.menu}`);
        xdo(display, ["key", "--window", wid, menuChord(id, undefined, localeCatalog)]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.menuItem !== null) {
        const [name = "", index = "0"] = options.menuItem.split(":");
        const id = MENU_IDS.get(name);
        if (id === undefined) throw new Error(`no id for menu ${name}`);
        xdo(display, ["key", "--window", wid, menuChord(id, undefined, localeCatalog)]);
        await Bun.sleep(TYPE_SETTLE_MS);
        // Opening a menu focuses item 0, so index N is N presses of Down.
        for (let i = 0; i < Number(index); i++) {
          xdo(display, ["key", "--window", wid, "Down"]);
          await Bun.sleep(150);
        }
        xdo(display, ["key", "--window", wid, "Return"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.outlineView !== null) {
        await localizedMenuDriver(display, wid).activate(`menu-view-${options.outlineView}`);
        await Bun.sleep(TYPE_SETTLE_MS);
      }
      if (options.reference) {
        await localizedMenuDriver(display, wid).activate("menu-open-reference");
        await Bun.sleep(TYPE_SETTLE_MS);
      }
      if (options.continuous) {
        await localizedMenuDriver(display, wid).activate("menu-view-continuous");
        await Bun.sleep(TYPE_SETTLE_MS);
        if (options.continuousNext) {
          xdo(display, ["key", "--window", wid, "alt+Next"]);
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.shortcuts) {
        // Help has exactly one item, so opening the menu already focuses it and
        // Return activates it. No Down, and no coordinates: the panel is the
        // only surface in the application that says what its own chords are,
        // and a capture is the only way to look at it.
        xdo(display, ["key", "--window", wid, menuChord("menu-help", undefined, localeCatalog)]);
        await Bun.sleep(TYPE_SETTLE_MS);
        xdo(display, ["key", "--window", wid, "Return"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.navContext) {
        // Shift+Tab, not a click: the mount focuses the editor, #nav is the
        // element immediately before #editor in the document and carries
        // tabIndex 0, so one Shift+Tab lands on the tree. That keeps this route
        // KEYSTROKES ONLY - no AT-SPI walk to find a row - which is what lets
        // the flag compose with --scheme.
        //
        // The row the menu opens on is therefore the boot selection, which is
        // the scene already on screen. That is the ordinary case a capture
        // should show.
        xdo(display, ["key", "--window", wid, "shift+Tab"]);
        await Bun.sleep(KEY_STEP_MS * 2);
        xdo(display, ["key", "--window", wid, "shift+F10"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.find !== null) {
        xdo(display, ["key", "--window", wid, "ctrl+f"]);
        await Bun.sleep(500);
        xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), options.find]);
        xdo(display, ["key", "--window", wid, "Return"]);
        await Bun.sleep(TYPE_SETTLE_MS);
      }

      if (options.hover !== null) {
        // ONE AT-SPI WALK, and it is the last thing before the capture:
        // several walks in one window kill the application outright, cleanly,
        // taking the X server with them. The control is found by its DOM id
        // rather than by arithmetic because everything before it in the strip
        // is data.
        //
        // `toggle button` is in nodes.ts's role set for the recorded reason:
        // aria-pressed changes the ATK role, and these three controls carry it.
        const wanted = options.hover;
        const node = locateNodes(rootPid).find((n) => n.id === wanted);
        if (node === undefined) {
          throw new Error(`--hover: no control with id ${wanted} in the accessibility tree`);
        }
        const at = centreOf(node);
        // mousemove --window and NO click. The recorded rule is the other way
        // round for pressing (a synthesized button event is dropped by the
        // toolkit while the pointer still MOVES, so a click needs a bare
        // `click`); here the move is the whole point.
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        // The tip appears on `mouseenter`, which the pointer motion above
        // generates -- but WebKitGTK delivers it on its own schedule and a
        // capture taken immediately catches the frame before it.
        await Bun.sleep(PAINT_SETTLE_MS);
      }

      if (options.castCard || options.castAlias) {
        // EXTRACTED TO `cast-hover.ts` (105), used by shot-cli.ts and
        // bible-cli.ts alike: the AT-SPI walk that finds the leftmost cast
        // match's screen rect and confirms the card appeared over it. See
        // that file's own header for why this reads the entry's TEXT
        // INTERFACE rather than a DOM id.
        //
        // --cast-card ACCEPTS THE FIRST MATCH FOUND (105): the leftmost cast
        // match in the prose, whichever family it comes from -- a card that
        // never opens or names the alias is exactly the shape the alias
        // slice's own matcher change could get wrong, and this flag's whole
        // point predates that change. --cast-alias NARROWS TO A MATCH THE
        // MATCHER'S OWN ALGORITHM GIVES TO AN ALIAS, not merely a candidate
        // string that happens to be one: "Roland Vetch" is an alias AND a
        // whole-word match inside every occurrence of "Harbour Master
        // Roland Vetch", so an alias-only TEXT list would let this flag
        // hover a span the page actually marked as the full NAME.
        // `locateCastHoverRect`'s "alias-only" mode is what tells the two
        // apart at the same winning position.
        const flagName = options.castAlias ? "--cast-alias" : "--cast-card";
        const candidates = castHoverCandidates(projectPath);
        const rect = locateCastHoverRect(
          rootPid,
          candidates,
          flagName,
          options.castAlias ? "alias-only" : "any",
        );
        const at = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        // LONGER THAN --hover's OWN SETTLE, and that is the whole difference
        // between the two mechanisms: a tooltip shows on `mouseenter` alone,
        // and this card is timer-driven -- 450ms after the pointer arrives,
        // by the design record's own number -- so this constant clears it
        // with margin rather than relying on a shared settle sized for a
        // different surface.
        await Bun.sleep(CAST_CARD_SETTLE_MS);
        confirmCastCardShown(rootPid, flagName);
      }

      if (options.press !== null) {
        // ONE AT-SPI WALK, the same rule --hover and --status follow: taken
        // as the LAST thing before the capture, because several walks in one
        // window kill the application outright.
        const nodes = locateNodes(rootPid);
        if (options.craftReports && !nodes.some((candidate) => candidate.id === "craft-run-report")) {
          throw new Error("--craft-reports did not expose the report panel before its press");
        }
        const node = nodeToPress(nodes, options.press);
        const at = pressPoint(node, geometry);
        // Move, then a bare `click`: a `click --window` is a synthetic event
        // the toolkit drops (the recorded rule every rig's press follows).
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        xdo(display, ["click", "1"]);
        // What a press starts may be host work with no page-side notice to
        // poll for -- an archive written to disk -- and there is no second
        // walk available to watch for it finishing.
        await Bun.sleep(PRESS_SETTLE_MS);

        if (options.typeAfter !== null) {
          // End first: the press left the bubble's selection standing, and
          // typing into it would replace the word the picture is about.
          xdo(display, ["key", "--window", wid, "End"]);
          xdo(display, ["type", "--window", wid, "--delay", String(TYPE_DELAY_MS), options.typeAfter]);
          await Bun.sleep(TYPE_SETTLE_MS);
        }
      }

      if (options.craftKnowledge || (options.craftReports && options.press?.value === "craft-run-report")) {
        // Show the retained links or generated findings below the long forms.
        // Use the panel edge so its nested result scroller does not absorb the wheel.
        xdo(display, ["mousemove", "--window", wid, String(geometry.width - 24), "700"]);
        xdo(display, ["click", "--repeat", "24", "--delay", "40", "5"]);
        if (options.craftReports) {
          xdo(display, ["mousemove", "--window", wid, String(geometry.width - 100), String(geometry.height - 100)]);
          xdo(display, ["click", "--repeat", "16", "--delay", "40", "5"]);
        }
        await Bun.sleep(PAINT_SETTLE_MS);
      }

      if (options.librarySeries && options.press?.value === "library-summary-toggle") {
        // The focused toggle consumes Ctrl+End without scrolling the library.
        // Wheel over its scroll surface so the result below the shelf is visible.
        xdo(display, ["mousemove", "--window", wid, "700", "700"]);
        xdo(display, ["click", "--repeat", "12", "--delay", "60", "5"]);
        await Bun.sleep(PAINT_SETTLE_MS);
      }

      if (options.outlineView !== null) {
        const probe = Bun.spawnSync(["python3", "-c", PY_OUTLINE_VIEW, pidListArg(rootPid)], {
          stdout: "pipe", stderr: "pipe",
        });
        if (probe.exitCode !== 0) {
          throw new Error(`--outline-view ${options.outlineView}: could not inspect the visible view (AT-SPI exit ${probe.exitCode}): ${probe.stderr.toString().trim()}`);
        }
        const title = catalogText(options.outlineView === "reading" ? "reading.title" : `outline-view.${options.outlineView}`, localeCatalog);
        try {
          const parsed = JSON.parse(probe.stdout.toString()) as unknown;
          assertOutlineViewShown(parsed, options.outlineView, title);
          if (options.outlineAct !== null) {
            // Pointer input at the probed geometry: the grip is aria-hidden
            // (its keyboard route is Alt+Arrow and Move), so it is found as
            // the start of its row's first cell, past the cell's padding.
            const rows = outlineRows(parsed, 6);
            const centre = (box: OutlineBox): [string, string] => [String(Math.round(box[0] + box[2] / 2)), String(Math.round(box[1] + box[3] / 2))];
            if (options.outlineAct === "move-menu") {
              xdo(display, ["mousemove", "--window", wid, ...centre(rows[3]!.move)]);
              xdo(display, ["click", "1"]);
            } else {
              const from = rows[3]!.first;
              const to = rows[5]!.row;
              xdo(display, ["mousemove", "--window", wid, String(from[0] + 12), String(from[1] + 18)]);
              xdo(display, ["mousedown", "1"]);
              for (const step of [0.25, 0.5, 0.75, 1]) {
                const y = from[1] + 18 + (to[1] + to[3] * 0.75 - from[1] - 18) * step;
                xdo(display, ["mousemove", "--window", wid, String(from[0] + 12), String(Math.round(y))]);
                await Bun.sleep(80);
              }
            }
            await Bun.sleep(PAINT_SETTLE_MS);
          }
        } catch (error) {
          const failed = `${options.out}.failed.png`;
          const diagnostic = Bun.spawnSync(["import", "-display", display, "-window", wid, failed], {
            stdout: "inherit", stderr: "inherit",
          });
          console.error(diagnostic.exitCode === 0 ? `failed-view diagnostic: ${failed}` : "failed-view diagnostic capture also failed");
          throw error;
        }
      }

      console.log(`[3/3] capturing to ${options.out}`);
      const shot = Bun.spawnSync(["import", "-display", display, "-window", wid, options.out], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (shot.exitCode !== 0) throw new Error("import failed to capture the window");
    },
  });
  console.log(`wrote ${options.out}`);
} finally {
  cleanup();
}
