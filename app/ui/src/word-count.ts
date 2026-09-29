// app/ui/src/word-count.ts
// Two numbers in the project bar: the open scene's live count, and the whole
// project's SAVED count.
//
// The project figure lags, by construction. It is the sum over what the store
// holds, and the flush debounce is a second, so the number a writer sees is
// always at least one debounce behind the keystroke they just made. A trailing
// number with no explanation reads as a broken count, so the word "saved" is
// part of the label rather than a nicety - it is the only thing that makes the
// lag legible.
//
// A failed count is an em dash and NOTHING else. No banner: the manuscript is
// unaffected by a count that could not be taken, and raising the persistence
// banner would tell a writer their work is not being saved, which would be a
// lie. The failure is also NOT latched - the opposite of raiseFailure - because
// the next answer is as likely to arrive as this one was to fail.
//
// EXPOSURE. The element carries a role and an accessible name because without
// them it was invisible to assistive technology: a full AT-SPI walk of the
// running app showed `document web` with four children and neither #project-bar
// nor #word-count among them, so a writer using a screen reader could not read
// their own word count. Accessibility is a stated product value here, so that
// was a defect, not a polish item.
//
// The name carries BOTH figures rather than a bare "Word count", because the
// two spans below are plain generic nodes that WebKitGTK is free to prune - and
// does. The name is the only channel that is certain to survive, so it is where
// the numbers live, "saved" qualifier included.
//
// It is also FORMATTED SEPARATELY from the visible text, from the same held
// figures. For one slice the name was built by reading the spans' textContent
// back out of the DOM, and that made the bar's wording load-bearing for
// accessibility: shortening the display string would have shortened what is
// announced, and taken the "saved" qualifier with it. The bar wants brevity next
// to five controls; a screen reader user has no bar, no adjacency and no layout,
// and needs the sentence. Those are different requirements and they now have
// different strings.
//
// LIVE-REGION BEHAVIOUR IS THE TRAP, and the reason the role is what it is. The
// scene figure repaints several times a second while someone is typing, so a
// role announcing its updates would read the count aloud continuously - worse
// than not exposing it at all. Throttling it did not make this safe: four
// announcements a second is still unusable.
//
// Both candidates were measured against the running app under Xvfb, and BOTH
// are exposed:
//
//   role="group"                    -> ATK `panel`, name from aria-label,
//                                      attributes: xml-roles:group;
//                                      computed-role:group;id:word-count.
//                                      NO live/container-live attribute at all.
//   role="status" aria-live="off"   -> ATK `status bar`, same name, attributes:
//                                      live:off;container-live:off;atomic:true;
//                                      container-atomic:true;
//                                      container-live-role:status;
//                                      relevant:additions text.
//
// group wins on the second column. `aria-live="off"` on role="status" is an
// override of an implicit polite, and the override demonstrably took - but the
// whole live-region apparatus is still attached to the node, including
// `container-live-role:status`, and a client keying off the role rather than
// the computed `live` value would still announce. role="group" has no
// live-region semantics to override: there is nothing to switch off because
// nothing is wired up. A guarantee by construction beats one by override.

// THE SCENE FIGURE IS OFF THE KEYSTROKE PATH. Recomputed synchronously from the
// editor's onChange - once per document-changing transaction, so once per
// keystroke - it put a whole-document textBetween plus a Unicode regex scan
// inside every typed character. A count that updates four times a second is
// indistinguishable to a human from one that updates sixty times a second, so
// the repaint is throttled: leading edge, so the first edit after an idle
// moment shows immediately and the number never reads as stuck, then at most
// one recomputation per window. The trailing repaint is MANDATORY - a
// leading-only throttle drops whatever the writer typed last in the window and
// leaves a permanently wrong number on screen the moment they stop.
//
// WHAT THIS BOUGHT, AND WHAT IT DID NOT. Measured, both graded 5-minute stress
// runs, against the build before this change as the baseline:
//
//   dispatch p95   1 ms -> 2 ms with the synchronous count -> 1 ms with this.
//                  The per-keystroke work is real and it is gone.
//   frames 40-100  0 -> 111 (hierarchy) / 116 (persistence) -> 120 / 103.
//                  UNCHANGED. This throttle did not touch that tail.
//
// So the 40-100 ms frame tail this slice introduced was NOT the scene count,
// and a reader must not take this throttle for its fix. It was the PROJECT
// figure: `project_word_count` scanned every document in the manuscript, fired
// from the flush closure in project.ts, and flushes land about once a second
// while someone types. That scan is ~58 ms at the stress fixture, measured over
// 15,200 documents - which is one to two frames, once a second, forever.
//
// IT IS FIXED IN THE HOST, not here. The host now keeps a per-document word
// index, built once at open and adjusted by the delta of each accepted flush,
// so the command is O(1); the same two graded stress runs record 0 frames in
// the 40-100 ms bucket and frame p99 33-34 ms, the pre-slice baseline. Nothing
// in this file changed for that, and nothing in this file needs to throttle the
// project figure: a throttle would have been a band-aid, because a scan run
// less often is still a scan of the whole manuscript.

import { formatNumber, plural, t } from "./i18n";
import { type DailyTarget, progressDisplay, progressSpoken, targetWords } from "./goals";

/** Saved manuscript words and signed typing-only progress; null means the
 * source statistics are unavailable rather than a day with no work.
 * `collecting` false means saves are not being measured, so `today` is frozen. */
export interface Progress {
  total: number;
  today: number | null;
  collecting: boolean;
}

/** The throttle window. Four repaints a second at most while typing. */
export const SCENE_COALESCE_MS = 250;

/** Not counted yet. Distinct from the em dash on purpose: "no answer has come
 *  back" and "the host could not answer" are different states, and collapsing
 *  them would make a display that never asks indistinguishable from one whose
 *  every ask failed. */
const PENDING = "…";
const FAILED = "—";

/** What the container advertises itself as. A container role with no
 *  live-region semantics, so an update cannot announce. */
export const WORD_COUNT_ROLE = "group";
/** Prefix on the accessible name, so the name says what the numbers are before
 *  it says them. */
const LABEL_PREFIX = t("words.label.prefix");

export interface WordCountDeps {
  container: HTMLElement;
  /** The live open scene's count. NOT cheap: it walks the whole open document.
   *  Called at most once per SCENE_COALESCE_MS while typing, which is what
   *  keeps it off the keystroke path. */
  sceneWords: () => number;
  /** The whole project's saved count AND today's share of it, from ONE call.
   *  Two calls would let the bar show a total and a day's progress read at
   *  different instants, and the gap between them is exactly the figure a
   *  writer is watching. Rejects if the host cannot answer. */
  projectProgress: () => Promise<Progress>;
  /** What the writer is aiming for, or `off`. */
  dailyTarget: DailyTarget;
  /** Told the open scene's count every time this view recomputes it, which is
   *  at most once per SCENE_COALESCE_MS. Optional because the corpus path has
   *  no session to measure. It must not compute anything: the number is already
   *  in hand, and the whole reason this hook is here rather than on `onChange`
   *  is that `onChange` is the keystroke path. */
  onSceneWords?: (words: number) => void;
  /** Injected so the throttle is testable with a hand-driven clock rather than
   *  by sleeping, the same contract `createFlushScheduler` takes for its
   *  debounce. */
  coalesceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** #goal-bar: a sibling of the count, aria-hidden, with one child that is
   *  the fill. Optional because the count is also built under APP_RUN=measure
   *  with no footer. The name already says "340 of 500 today"; the bar is
   *  the same figure for the eye. */
  goalBar?: HTMLElement;
}

export interface WordCountView {
  /** Ask for the scene figure to reflect the document as it is now. Call on
   *  every edit: THROTTLED, so a burst of keystrokes costs one `sceneWords()`
   *  per SCENE_COALESCE_MS - the first one immediately, and one more after the
   *  burst so the number the writer stops on is the right one. */
  refreshScene(): void;
  /** Repaint the scene figure NOW, cancelling any pending throttled repaint.
   *  For a document switch, which is not a keystroke: it happens once, it is
   *  the moment the whole figure becomes about a different scene, and a stale
   *  number sitting under a newly opened document for a quarter second reads as
   *  the previous scene's count. */
  refreshSceneNow(): void;
  /** Re-ask the host for the project figure. Call on open, switch, mutation,
   *  flush. Coalesced: a call made while a scan is running does not start a
   *  second one, it books a single trailing ask for when that one lands. Never
   *  rejects. */
  refreshProject(): Promise<void>;
  /** The writer chose a different daily goal. Repaints against it immediately
   *  from the figure already held: today's count does not depend on the target,
   *  so asking the host again would be a round trip for a number that cannot
   *  have changed. */
  setDailyTarget(target: DailyTarget): void;
  destroy(): void;
}

// TWO STATEMENTS OF THE SAME TWO NUMBERS, NEITHER DERIVED FROM THE OTHER.
//
// The accessible name used to be built by reading the spans' textContent back
// out of the DOM, which wired the two together: the display string could not be
// made shorter without silently shortening what a screen reader announces, and
// the "saved" qualifier - the only thing that makes the project figure's lag
// legible - would have gone with it. Presentation and accessibility had one
// string doing both jobs, and the accessibility half was the one with no slack.
//
// So the numbers are held as state and formatted twice. The bar gets a compact
// form; the name gets the sentence, which is what a screen reader has to work
// with because it has no bar to look at and no layout to infer from.
//
// THE COST, AND ITS GUARD: two statements can now disagree. Nothing in this file
// can catch that, because both come from the same variables here - it is a
// wording drift, not a data drift. a11y_word_count_agrees in the words rig reads
// the FIGURES out of both channels off the live accessibility tree and fails
// when they differ.

/** The bar. Compact: it sits beside five controls in a strip whose height three
 *  rigs restate, and at the sentence length it dominated a readout's worth of
 *  space. "in the book" was replaced: "2,000 saved" beside the save indicator read
 *  as a save state. The name below keeps "saved", which is where the lag
 *  behind the keystroke is still said. */
const sceneDisplay = (words: number): string =>
  plural("words.scene", words, { count: formatNumber(words) });

const projectDisplay = (figure: string): string => t("words.project", { figure });

/** The accessible name. The full sentence, unchanged from before the display was
 *  shortened: a screen reader user gets no layout, no adjacency and no bar, so
 *  "47 words" and "2,000 saved" read aloud in sequence do not say which is
 *  which. */
const sceneSpoken = (words: number): string =>
  t("words.scene.spoken", { display: sceneDisplay(words) });

const projectSpoken = (figure: string): string =>
  t("words.project.spoken", { figure });

export function createWordCount(deps: WordCountDeps): WordCountView {
  const {
    container,
    coalesceMs = SCENE_COALESCE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  } = deps;
  container.replaceChildren();
  container.setAttribute("role", WORD_COUNT_ROLE);

  // The figures themselves, held rather than recovered from the DOM. What makes
  // the display and the accessible name two independent renderings of one pair
  // of numbers instead of one string parsed back out of the other.
  let sceneWords = deps.sceneWords();
  let projectFigure = PENDING;
  let dailyTarget = deps.dailyTarget;
  /** null until an answer lands, and again if one fails. Distinct from 0, which
   *  is a real reading and the one every day starts on. */
  let today: number | null = null;
  /** A paused book's daily figure is frozen, so it is not shown as progress. */
  let paused = false;

  const scene = document.createElement("span");
  scene.id = "word-count-scene";
  scene.textContent = sceneDisplay(sceneWords);

  // Punctuation between two figures, with no meaning of its own; a screen
  // reader announcing "vertical line" between them is noise.
  const separator = document.createElement("span");
  separator.id = "word-count-separator";
  separator.setAttribute("aria-hidden", "true");
  separator.textContent = " · ";

  const project = document.createElement("span");
  project.id = "word-count-project";
  project.textContent = projectDisplay(projectFigure);

  // A GAP, NOT A SECOND MIDDLE DOT: one dot per line at most, and the
  // day's figure is a different thought from the two counts before it. The
  // space keeps the text's word break; the stylesheet draws the gap.
  const todaySeparator = document.createElement("span");
  todaySeparator.id = "word-count-today-separator";
  todaySeparator.setAttribute("aria-hidden", "true");
  todaySeparator.textContent = " ";

  const todayFigure = document.createElement("span");
  todayFigure.id = "word-count-today";

  container.append(scene, separator, project, todaySeparator, todayFigure);

  /** Keep the accessible name in step with the figures. Called after every
   *  paint, both figures every time: a name rebuilt from only the half that
   *  changed would drift from the other half.
   *
   *  Built from the STATE above, never from `scene.textContent`. Reading the
   *  spans back is what tied the announced sentence to the displayed string and
   *  made the display unshortenable. The separator is a comma rather than the
   *  visible middle dot - punctuation read aloud between two figures is noise,
   *  which is also why the visible one is aria-hidden. */
  const relabel = (): void => {
    // The third figure is omitted from the name entirely while it is unknown,
    // rather than announced as an ellipsis or a dash. A screen reader user
    // arrowing onto the bar during the first round trip would otherwise hear a
    // punctuation mark read as a word where a number belongs.
    const progress = paused
      ? t("words.progress.spoken", { progress: t("goals.spoken.paused") })
      : today === null
        ? ""
        : t("words.progress.spoken", { progress: progressSpoken(today, dailyTarget) });
    container.setAttribute(
      "aria-label",
      t("words.label", {
        prefix: LABEL_PREFIX,
        scene: sceneSpoken(sceneWords),
        project: projectSpoken(projectFigure),
        progress,
      }),
    );
  };

  /** The visible third figure. Its separator hides with it, so a bar waiting on
   *  its first answer is not a bar with a trailing middle dot. */
  const paintToday = (): void => {
    const known = today !== null;
    todaySeparator.hidden = !known && !paused;
    todayFigure.textContent = paused ? t("goals.paused") : known ? progressDisplay(today as number, dailyTarget) : "";
  };

  /** The bar shows only when there is a target AND a reading; its fill is
   *  today over the target, clamped: a day of cuts is an empty bar, a day
   *  past the target is a full one. */
  const paintGoalBar = (): void => {
    const bar = deps.goalBar;
    if (bar === undefined) return;
    const target = targetWords(dailyTarget);
    const shown = target !== null && today !== null && !paused;
    bar.hidden = !shown;
    const fill = bar.firstElementChild;
    if (!shown || !(fill instanceof HTMLElement)) return;
    const ratio = Math.min(1, Math.max(0, (today as number) / (target as number)));
    const percent = Math.round(ratio * 100);
    fill.style.width = `${percent}%`;
  };

  paintToday();
  paintGoalBar();
  relabel();

  let destroyed = false;

  /** One ask, answered and painted. Never rejects: every caller fires this from
   *  a place that has nowhere to report to, and an unhandled rejection is the
   *  one outcome that would reach the console instead of the em dash. */
  const ask = async (): Promise<void> => {
    let figure: string;
    let progress: number | null;
    let frozen = false;
    try {
      const answer = await deps.projectProgress();
      figure = formatNumber(answer.total);
      progress = answer.today;
      frozen = answer.collecting === false;
    } catch {
      figure = FAILED;
      // Back to unknown rather than left at the last good reading. A stale
      // number beside a live one is the worse of the two failures: the em dash
      // says the count could not be taken, a frozen figure says the writer
      // stopped writing.
      progress = null;
    }
    // An answer landing after teardown would write into the element the NEXT
    // project has already mounted into - the defect this slice's predecessor
    // shipped.
    if (destroyed) return;
    projectFigure = figure;
    today = progress;
    paused = frozen;
    project.textContent = projectDisplay(projectFigure);
    paintToday();
    paintGoalBar();
    relabel();
  };

  // COALESCING, and it is about the HOST's work, not the display's. The host
  // side of this is a full scan of every document in the manuscript; the page
  // fires a refresh after every successful flush, and flushes land about once a
  // second while someone is typing. Without this, a stress-fixture session
  // queues one whole-manuscript scan per second, each one competing with the
  // save path for the store.
  //
  // Drop-and-retrail rather than a queue: a queue of asks answers a question
  // nobody has any more (every ask returns the same figure, the CURRENT one), so
  // the only ask worth keeping is one final one that observes everything that
  // happened while the scan ran. Hence exactly two invocations for any burst
  // during one scan - the one in flight, and one trailing.
  let inFlight: Promise<void> | null = null;
  let trailing = false;

  const refreshProject = (): Promise<void> => {
    // Joins the ask already running instead of starting a second one. The
    // returned promise still resolves only once the display reflects work that
    // happened at or after this call, because of the trailing ask below.
    if (inFlight !== null) {
      trailing = true;
      return inFlight;
    }
    const run = (async (): Promise<void> => {
      await ask();
      // A loop, not an `if`: a refresh arriving during the TRAILING ask is in
      // exactly the position the first one was, and dropping it would leave the
      // display permanently one edit behind. It cannot spin - only a caller
      // sets the flag.
      while (trailing && !destroyed) {
        trailing = false;
        await ask();
      }
      inFlight = null;
    })();
    inFlight = run;
    return run;
  };

  // The one place `sceneWords()` is called, so the cost is accounted for in one
  // place too.
  const paintScene = (): void => {
    sceneWords = deps.sceneWords();
    scene.textContent = sceneDisplay(sceneWords);
    relabel();
    // The one figure in the application that is recomputed off the keystroke
    // path and describes the document being typed into, so it is also the only
    // place the session accumulator can be fed without paying per keystroke.
    // It is handed the number this function already computed, never asked for
    // another: a second `sceneWords()` here would restore exactly the cost the
    // throttle above exists to remove.
    deps.onSceneWords?.(sceneWords);
  };

  // Throttle state. `throttleWindow` is armed for coalesceMs after a paint and
  // means "a paint has already happened recently"; `pending` means "something
  // changed during that window and has not been shown yet".
  let throttleWindow: unknown = null;
  let pending = false;

  const windowClosed = (): void => {
    throttleWindow = null;
    if (destroyed || !pending) return;
    // The trailing paint, and it re-arms: a writer typing continuously keeps
    // arriving here, and each arrival is worth exactly one repaint. It cannot
    // run away - the next close with nothing pending stops the chain, so an
    // idle display holds no timer.
    pending = false;
    paintScene();
    throttleWindow = setTimer(windowClosed, coalesceMs);
  };

  const cancelWindow = (): void => {
    if (throttleWindow !== null) {
      clearTimer(throttleWindow);
      throttleWindow = null;
    }
    pending = false;
  };

  return {
    refreshScene(): void {
      if (destroyed) return;
      if (throttleWindow !== null) {
        pending = true;
        return;
      }
      paintScene();
      throttleWindow = setTimer(windowClosed, coalesceMs);
    },

    refreshSceneNow(): void {
      if (destroyed) return;
      cancelWindow();
      paintScene();
    },

    refreshProject,

    setDailyTarget(target: DailyTarget): void {
      if (destroyed) return;
      dailyTarget = target;
      paintToday();
      paintGoalBar();
      relabel();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // Before anything else. A timer surviving teardown holds a callback into
      // a destroyed editor's document and paints a dead project's figure into
      // the element the next mount has already taken over - the defect a flush
      // scheduler and an outline operation have each shipped here once.
      cancelWindow();
      container.replaceChildren();
      // The container is the page shell's, not this view's: a project switch
      // hands the same element to the next mount. Leaving the role behind would
      // advertise an empty group, and leaving the name behind would have the
      // NEW manuscript's bar answer with the OLD one's figures until the first
      // repaint.
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
    },
  };
}
