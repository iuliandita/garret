import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createWordCount,
  SCENE_COALESCE_MS,
  WORD_COUNT_ROLE,
  type WordCountView,
} from "../src/word-count";
import { DEFAULT_DAILY_TARGET, type DailyTarget } from "../src/goals";

interface Rig {
  container: HTMLElement;
  view: WordCountView;
  /** How many times the host was asked for the project total. */
  asks: () => number;
  setScene: (words: number) => void;
  /** How many times the open scene was actually counted. THE COST THE THROTTLE
   *  EXISTS TO BOUND: in the app this walks the whole document. */
  counts: () => number;
  /** Fire the throttle window's timer, if one is armed. Nothing sleeps: the
   *  view takes setTimer/clearTimer for the same reason createFlushScheduler
   *  does. */
  closeWindow: () => void;
  /** A timer is armed right now. `false` after teardown is the whole claim of
   *  the leak test. */
  armed: () => boolean;
  /** Run the last callback the view ever armed, EVEN IF IT WAS CLEARED. A timer
   *  that has already fired cannot be recalled, so this is the one thing
   *  clearTimer cannot protect against and the callback has to be inert on its
   *  own. */
  fireLastWindow: () => void;
  /** Every window the view has ever asked for, in ms. */
  delays: () => number[];
}

interface RigOptions {
  scene?: number;
  /** The total alone, for the tests that predate the day's figure and are about
   *  the throttle, the coalescing or the teardown rather than about progress.
   *  Today reads 0 through this door, which is a real reading and the one every
   *  day starts on. */
  projectWords?: () => Promise<number>;
  projectProgress?: () => Promise<{ total: number; today: number | null; collecting?: boolean }>;
  dailyTarget?: DailyTarget;
  onSceneWords?: (words: number) => void;
  /** #goal-bar, undefined in the tests that predate it, exactly as the page
   *  passes it in: absent under APP_RUN=measure's footerless mount. */
  goalBar?: HTMLElement;
}

let open: Rig | null = null;

function mount(options: RigOptions = {}): Rig {
  const container = document.createElement("span");
  document.body.appendChild(container);
  let scene = options.scene ?? 1234;
  let asks = 0;
  let counts = 0;
  // One slot, because the view arms at most one window at a time; a second
  // arrival while one is live would overwrite it silently, so it throws.
  let pending: (() => void) | null = null;
  let lastArmed: (() => void) | null = null;
  const delays: number[] = [];
  const view = createWordCount({
    container,
    sceneWords: () => {
      counts++;
      return scene;
    },
    dailyTarget: options.dailyTarget ?? DEFAULT_DAILY_TARGET,
    onSceneWords: options.onSceneWords,
    goalBar: options.goalBar,
    projectProgress: () => {
      asks++;
      if (options.projectProgress !== undefined) {
        return options.projectProgress().then((answer) => ({ collecting: true, ...answer }));
      }
      if (options.projectWords !== undefined) {
        return options.projectWords().then((total) => ({ total, today: 0, collecting: true }));
      }
      return Promise.resolve({ total: 45678, today: 0, collecting: true });
    },
    setTimer: (fn, ms) => {
      if (pending !== null) throw new Error("the view armed a second window over a live one");
      delays.push(ms);
      pending = fn;
      lastArmed = fn;
      return fn;
    },
    clearTimer: (handle) => {
      if (handle === pending) pending = null;
    },
  });
  const rig: Rig = {
    container,
    view,
    asks: () => asks,
    setScene: (words) => {
      scene = words;
    },
    counts: () => counts,
    closeWindow: () => {
      const fire = pending;
      pending = null;
      fire?.();
    },
    armed: () => pending !== null,
    fireLastWindow: () => {
      if (lastArmed === null) throw new Error("no window was ever armed");
      pending = null;
      lastArmed();
    },
    delays: () => [...delays],
  };
  open = rig;
  return rig;
}

afterEach(() => {
  open?.view.destroy();
  open?.container.remove();
  open = null;
});

const text = (rig: Rig, id: string): string => {
  const found = rig.container.querySelector(`#${id}`);
  if (found === null) throw new Error(`${id} is not in the word count`);
  return found.textContent ?? "";
};

/** A promise a test resolves by hand, so two asks can be answered out of the
 *  order they were made. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Several ticks: refreshProject awaits the host and then paints. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("word count rendering", () => {
  test("renders both figures with thousands separators", async () => {
    const rig = mount({ scene: 1234, projectWords: () => Promise.resolve(45678) });
    await rig.view.refreshProject();

    expect(text(rig, "word-count-scene")).toBe("1,234 words");
    // "in the book": "saved" beside the save indicator read as a save
    // state. The lag is still said, in the name.
    expect(text(rig, "word-count-project")).toBe("45,678 in the book");
  });

  test("one word is not '1 words'", async () => {
    const rig = mount({ scene: 1 });
    expect(text(rig, "word-count-scene")).toBe("1 word");
    await rig.view.refreshProject();
  });

  test("the project figure starts pending, not at zero and not failed", async () => {
    // Zero would be a lie about an unasked question, and an em dash would make
    // a display that never asks indistinguishable from one whose asks failed.
    const rig = mount();
    expect(text(rig, "word-count-project")).toBe("… in the book");
    expect(rig.asks()).toBe(0);
    await rig.view.refreshProject();
  });
});

describe("word count exposure", () => {
  // The defect these pin: before this markup existed, a full AT-SPI walk of the
  // running app showed `document web` with four children and #word-count among
  // none of them. WebKitGTK prunes untyped generic nodes, so an unroled span
  // holding two numbers is simply not there for a screen reader.
  test("the container advertises a role and is named", async () => {
    const rig = mount({ scene: 1234 });
    await rig.view.refreshProject();

    expect(rig.container.getAttribute("role")).toBe(WORD_COUNT_ROLE);
    expect(rig.container.getAttribute("aria-label")).toBe(
      "Word count: 1,234 words in this scene, 45,678 saved in the project, 0 words typed today",
    );
  });

  test("the role has no live-region semantics", async () => {
    // Not decoration. The scene figure repaints on every keystroke, so a role
    // that announced its updates would read the count aloud continuously while
    // the writer types. `group` has nothing to announce with; a role that did
    // would need an aria-live="off" override, and this asserts none is relied
    // on.
    const rig = mount();
    expect(rig.container.hasAttribute("aria-live")).toBe(false);
    await rig.view.refreshProject();
    expect(rig.container.hasAttribute("aria-live")).toBe(false);
  });

  test("the accessible name carries both figures, 'saved' included", async () => {
    // The two spans are generic nodes the platform may prune, so the name is
    // the only channel certain to survive - and the project figure's lag is
    // only legible because the word "saved" qualifies it.
    const rig = mount({ scene: 7, projectWords: () => Promise.resolve(2000) });
    await rig.view.refreshProject();

    const label = rig.container.getAttribute("aria-label") ?? "";
    expect(label).toContain("7 words in this scene");
    expect(label).toContain("2,000 saved in the project");
    // The visible separator is punctuation with no meaning; read aloud between
    // two figures it is noise, which is also why the visible one is aria-hidden.
    expect(label).not.toContain("·");
  });

  test("the name keeps its sentence while the bar shows the short form", async () => {
    // THE INVARIANT THE TWO FORMATTERS EXIST FOR, asserted in one place so the
    // reason survives.
    //
    // The name used to be built by reading these spans' textContent back out of
    // the DOM. That tied the announced sentence to the displayed string: the bar
    // could not be shortened without shortening what a screen reader hears, and
    // the "saved" qualifier - the only thing making the project figure's lag
    // legible - would have gone with it. A bar beside five controls wants
    // brevity; a listener with no layout, no adjacency and no bar needs to be
    // told which figure is which. Those are different requirements.
    //
    // Restoring the old `relabel` (reading scene.textContent) fails this and the
    // exposure tests above, because the label collapses to the short form.
    const rig = mount({ scene: 7, projectWords: () => Promise.resolve(2000) });
    await rig.view.refreshProject();

    expect(text(rig, "word-count-scene")).toBe("7 words");
    expect(text(rig, "word-count-project")).toBe("2,000 in the book");
    expect(rig.container.getAttribute("aria-label")).toBe(
      "Word count: 7 words in this scene, 2,000 saved in the project, 0 words typed today",
    );
  });

  test("the name tracks both figures as each repaints", async () => {
    let answer = 100;
    const rig = mount({ scene: 5, projectWords: () => Promise.resolve(answer) });
    await rig.view.refreshProject();

    rig.setScene(6);
    rig.view.refreshScene();
    // A name rebuilt from only the half that changed would drop the other half.
    expect(rig.container.getAttribute("aria-label")).toBe(
      "Word count: 6 words in this scene, 100 saved in the project, 0 words typed today",
    );

    answer = 250;
    await rig.view.refreshProject();
    expect(rig.container.getAttribute("aria-label")).toBe(
      "Word count: 6 words in this scene, 250 saved in the project, 0 words typed today",
    );
  });

  test("a failed count is named as such, not as a number", async () => {
    const rig = mount({
      scene: 3,
      projectWords: () => Promise.reject(new Error("store is closed")),
    });
    await rig.view.refreshProject();

    expect(rig.container.getAttribute("aria-label")).toBe(
      "Word count: 3 words in this scene, — saved in the project",
    );
  });

  test("destroy takes the role and the name with it", async () => {
    // The container belongs to the page shell, not to this view: a project
    // switch hands the same element to the next mount. A name left behind would
    // have the NEW manuscript's bar answer with the OLD one's figures.
    const rig = mount();
    await rig.view.refreshProject();
    expect(rig.container.hasAttribute("aria-label")).toBe(true);

    rig.view.destroy();

    expect(rig.container.hasAttribute("role")).toBe(false);
    expect(rig.container.hasAttribute("aria-label")).toBe(false);
  });
});

describe("word count refresh", () => {
  test("refreshScene repaints from sceneWords and does not ask the host", async () => {
    const rig = mount({ scene: 10 });
    await rig.view.refreshProject();
    const asksAfterMount = rig.asks();
    expect(text(rig, "word-count-scene")).toBe("10 words");

    rig.setScene(11);
    rig.view.refreshScene();

    expect(text(rig, "word-count-scene")).toBe("11 words");
    // The scene figure is repainted on every keystroke. A repaint that asked
    // the host would put a full scan of every document on the typing path.
    expect(rig.asks()).toBe(asksAfterMount);
  });

  test("refreshProject repaints the project figure and leaves the scene alone", async () => {
    let answer = 100;
    const rig = mount({ scene: 7, projectWords: () => Promise.resolve(answer) });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-project")).toBe("100 in the book");

    answer = 2000;
    await rig.view.refreshProject();

    expect(text(rig, "word-count-project")).toBe("2,000 in the book");
    expect(text(rig, "word-count-scene")).toBe("7 words");
  });
});

// THE MEASURED REGRESSION THIS THROTTLE EXISTS FOR. Counting the scene
// synchronously from the editor's onChange - once per document-changing
// transaction, so once per keystroke - put a whole-document textBetween and a
// Unicode scan inside every typed character. Both graded 5-minute stress runs
// went from LITERALLY ZERO frames in the 40-100 ms bucket to 111 and 116, with
// frame p99 34 -> 43 ms, and neither p95 nor the stall gate could see it.
describe("word count scene throttling", () => {
  test("a burst costs one count, not one per keystroke", () => {
    const rig = mount({ scene: 10 });
    const atMount = rig.counts();

    for (let i = 0; i < 50; i++) rig.view.refreshScene();

    // One for the leading edge of the burst. The other 49 keystrokes cost
    // nothing at all; without the throttle they cost 49 whole-document scans.
    expect(rig.counts()).toBe(atMount + 1);
  });

  test("the window is the exported one, so the constant is not decorative", () => {
    const rig = mount();
    rig.view.refreshScene();
    expect(rig.delays()).toEqual([SCENE_COALESCE_MS]);
  });

  test("the trailing repaint lands after the writer stops", () => {
    // MANDATORY, and the reason this is a throttle rather than a leading-only
    // one: whatever was typed last in a window is not on screen when the window
    // opens, so without a trailing repaint the count a writer stops on is
    // permanently wrong.
    const rig = mount({ scene: 10 });
    rig.view.refreshScene();
    expect(text(rig, "word-count-scene")).toBe("10 words");

    rig.setScene(11);
    rig.view.refreshScene(); // Coalesced: nothing on screen yet.
    expect(text(rig, "word-count-scene")).toBe("10 words");

    rig.closeWindow();

    expect(text(rig, "word-count-scene")).toBe("11 words");
  });

  test("an idle window closes without arming another", () => {
    // The trailing repaint re-arms, so a writer typing continuously keeps
    // paying one count per window and no more. It has to stop when they do:
    // a chain that re-armed unconditionally would count a document nobody is
    // editing, forever.
    const rig = mount();
    rig.view.refreshScene();
    rig.setScene(2);
    rig.view.refreshScene();

    rig.closeWindow(); // Trailing repaint - re-arms, because more may come.
    expect(rig.armed()).toBe(true);
    const counted = rig.counts();

    rig.closeWindow(); // Nothing pending this time.

    expect(rig.armed()).toBe(false);
    expect(rig.counts()).toBe(counted);
  });

  test("refreshSceneNow paints immediately and cancels the pending repaint", () => {
    // A document switch is not a keystroke. It happens once, and it is the
    // moment the figure stops being about the scene it names.
    const rig = mount({ scene: 10 });
    rig.view.refreshScene();
    rig.setScene(11);
    rig.view.refreshScene(); // Booked, not shown.

    rig.setScene(400);
    rig.view.refreshSceneNow();

    expect(text(rig, "word-count-scene")).toBe("400 words");
    // And the booked repaint is gone with the window, rather than waiting to
    // repaint the incoming scene with a count taken for the outgoing one.
    expect(rig.armed()).toBe(false);
  });

  test("the accessible name follows the throttled repaint, not only the visible text", () => {
    const rig = mount({ scene: 10 });
    rig.view.refreshScene();
    rig.setScene(11);
    rig.view.refreshScene();
    rig.closeWindow();

    expect(rig.container.getAttribute("aria-label")).toContain("11 words in this scene");
  });
});

describe("word count failure", () => {
  test("a rejected count is an em dash, with no banner and a live scene figure", async () => {
    const rig = mount({
      scene: 42,
      projectWords: () => Promise.reject(new Error("store is closed")),
    });

    // Must not reject: every caller fires this from a place with nowhere to
    // report to, so a rejection would reach the console instead of the bar.
    await rig.view.refreshProject();

    expect(text(rig, "word-count-project")).toBe("— in the book");
    // The manuscript is unaffected by a count that could not be taken. Raising
    // the persistence banner would tell a writer their work is not being saved.
    expect(document.querySelectorAll('[role="alert"]').length).toBe(0);
    expect(document.getElementById("persist-error")).toBeNull();
    // And the half that needs no host keeps working.
    rig.setScene(43);
    rig.view.refreshScene();
    expect(text(rig, "word-count-scene")).toBe("43 words");
  });

  test("a failure is not latched: the next answer replaces the em dash", async () => {
    // The opposite of raiseFailure, deliberately. A count that failed once is
    // not evidence the next one will, and the number is informational.
    let fail = true;
    const rig = mount({
      projectWords: () => (fail ? Promise.reject(new Error("busy")) : Promise.resolve(9001)),
    });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-project")).toBe("— in the book");

    fail = false;
    await rig.view.refreshProject();

    expect(text(rig, "word-count-project")).toBe("9,001 in the book");
  });
});

describe("word count ordering and teardown", () => {
  test("an answer that lands after destroy touches nothing", async () => {
    // The element reference is captured BEFORE the teardown on purpose.
    // Asserting on the container would be vacuous: destroy() detaches the
    // spans, so a late paint would write into a node the container no longer
    // holds and an empty-container assertion would pass with the latch gone.
    const pending = deferred<number>();
    const rig = mount({ projectWords: () => pending.promise });
    const projectEl = rig.container.querySelector("#word-count-project");
    if (projectEl === null) throw new Error("the project figure is not mounted");
    const before = projectEl.textContent;

    const inFlight = rig.view.refreshProject();
    rig.view.destroy();
    pending.resolve(777);
    await inFlight;
    await settle();

    expect(projectEl.textContent).toBe(before);
    expect(projectEl.textContent).not.toContain("777");
  });

  test("a burst during one scan costs exactly one trailing ask", async () => {
    // The host side of an ask is a full scan of every document, and the page
    // fires one after every successful flush - about once a second while
    // someone types. Two refreshes arriving during one scan must cost two scans
    // in total, not three: the one running, and one trailing that observes both
    // of them. Overlapping them instead would queue a whole-manuscript scan per
    // flush against the store the save path needs.
    const first = deferred<number>();
    const rest = deferred<number>();
    let asked = 0;
    const rig = mount({
      projectWords: () => {
        asked++;
        return asked === 1 ? first.promise : rest.promise;
      },
    });

    const inFlight = rig.view.refreshProject();
    expect(asked).toBe(1);
    // Both land while the first scan is still running.
    void rig.view.refreshProject();
    void rig.view.refreshProject();
    expect(asked).toBe(1);

    first.resolve(1111);
    await settle();
    // One trailing ask for the pair, not one each.
    expect(asked).toBe(2);

    rest.resolve(2222);
    await inFlight;
    await settle();
    expect(text(rig, "word-count-project")).toBe("2,222 in the book");
    expect(asked).toBe(2);
  });

  test("a refresh after the trailing ask starts is not dropped", async () => {
    // A refresh arriving during the TRAILING scan is in exactly the position
    // the first burst was, so dropping it would leave the display permanently
    // one edit behind whatever the writer last did.
    const answers = [deferred<number>(), deferred<number>(), deferred<number>()];
    let asked = 0;
    const rig = mount({
      projectWords: () => {
        const promise = answers[asked]?.promise ?? Promise.resolve(0);
        asked++;
        return promise;
      },
    });

    const inFlight = rig.view.refreshProject();
    void rig.view.refreshProject();
    answers[0]?.resolve(1);
    await settle();
    expect(asked).toBe(2);

    // Now, mid-trailing-scan.
    void rig.view.refreshProject();
    answers[1]?.resolve(2);
    await settle();
    expect(asked).toBe(3);

    answers[2]?.resolve(3333);
    await inFlight;
    await settle();
    expect(text(rig, "word-count-project")).toBe("3,333 in the book");
  });

  test("destroy disarms the throttle rather than leaving a timer holding the view", () => {
    // THIS EXACT CLASS OF DEFECT HAS SHIPPED HERE TWICE: a flush scheduler that
    // survived teardown with its debounce armed, holding a callback into a
    // store whose rows its item ids no longer described; and an outline
    // operation that resolved after destroy() and wrote a dead project's row
    // index into the live navigator. The container here belongs to the page
    // shell, so a surviving repaint would count a destroyed editor's document
    // into the NEXT manuscript's bar.
    const rig = mount({ scene: 10 });
    rig.view.refreshScene();
    rig.setScene(11);
    rig.view.refreshScene(); // A repaint is now booked.
    expect(rig.armed()).toBe(true);

    rig.view.destroy();

    // The handle is gone, not merely ignored: the timer was cleared.
    expect(rig.armed()).toBe(false);
  });

  test("a window that fires anyway after destroy counts nothing and paints nothing", () => {
    // Belt and braces, and not vacuous: `armed()` above proves clearTimer was
    // called, this proves the callback is inert if the platform ran it anyway -
    // a fired-but-not-yet-run timer cannot be recalled. The element reference is
    // captured before teardown because destroy() detaches the spans, so
    // asserting on the container would pass with the guard deleted.
    const rig = mount({ scene: 10 });
    const sceneEl = rig.container.querySelector("#word-count-scene");
    if (sceneEl === null) throw new Error("the scene figure is not mounted");
    rig.view.refreshScene();
    rig.setScene(11);
    rig.view.refreshScene();
    const before = sceneEl.textContent;
    const counted = rig.counts();

    rig.view.destroy();
    rig.fireLastWindow();

    expect(rig.counts()).toBe(counted);
    expect(sceneEl.textContent).toBe(before);
  });

  test("destroy clears what it added and is idempotent", async () => {
    const rig = mount();
    await rig.view.refreshProject();
    expect(rig.container.childElementCount).toBe(5);

    rig.view.destroy();
    expect(rig.container.childElementCount).toBe(0);

    // A second teardown must neither throw nor undo anything.
    rig.view.destroy();
    expect(rig.container.childElementCount).toBe(0);
  });
});

describe("word count: today's progress", () => {
  const progress = (total: number, today: number) => () => Promise.resolve({ total, today });

  test("the third figure is absent until an answer lands, separator and all", () => {
    // Not "0 typed today" and not an ellipsis. A bar waiting on its first round trip
    // must not read as a day with nothing written in it, and must not carry a
    // trailing middle dot with nothing after it.
    const rig = mount({ dailyTarget: "500" });
    expect(text(rig, "word-count-today")).toBe("");
    const separator = rig.container.querySelector("#word-count-today-separator");
    expect((separator as HTMLElement).hidden).toBe(true);
    // The name omits it too: a screen reader arriving here would otherwise hear
    // punctuation read as a word where a number belongs.
    expect(rig.container.getAttribute("aria-label")).not.toContain("today");
  });

  test("an answer paints both the figure and the separator", async () => {
    const rig = mount({ dailyTarget: "500", projectProgress: progress(2000, 320) });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toBe("320 of 500 typed today");
    const separator = rig.container.querySelector("#word-count-today-separator");
    expect((separator as HTMLElement).hidden).toBe(false);
    expect(rig.container.getAttribute("aria-label")).toContain(
      "320 words typed today of a 500 word target",
    );
  });

  test("unavailable attribution preserves the manuscript count and hides the goal", async () => {
    const rig = mount({ dailyTarget: "500", projectProgress: () => Promise.resolve({ total: 2000, today: null }) });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-project")).toBe("2,000 in the book");
    expect(text(rig, "word-count-today")).toBe("");
    expect(rig.container.getAttribute("aria-label")).not.toContain("today");
  });

  test("the total and the day come from ONE answer", async () => {
    // Two calls would let the bar show a total read at one instant against a
    // day's progress read at another, and the gap between them is the figure
    // the writer is watching.
    const rig = mount({ projectProgress: progress(2000, 320) });
    await rig.view.refreshProject();
    expect(rig.asks()).toBe(1);
    expect(text(rig, "word-count-project")).toBe("2,000 in the book");
    expect(text(rig, "word-count-today")).toBe("320 typed today");
  });

  test("a failed ask takes the day's figure back to unknown, not to a stale one", async () => {
    let fail = false;
    const rig = mount({
      dailyTarget: "500",
      projectProgress: () =>
        fail ? Promise.reject(new Error("store is closed")) : Promise.resolve({ total: 9, today: 4 }),
    });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toBe("4 of 500 typed today");

    fail = true;
    await rig.view.refreshProject();
    // A frozen figure says the writer stopped writing; the em dash beside it
    // says the count could not be taken. Only one of those is true.
    expect(text(rig, "word-count-project")).toBe("— in the book");
    expect(text(rig, "word-count-today")).toBe("");
    expect(rig.container.getAttribute("aria-label")).not.toContain("today");
  });

  test("changing the goal repaints from the figure already held", async () => {
    const rig = mount({ dailyTarget: "off", projectProgress: progress(2000, 320) });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toBe("320 typed today");

    const asked = rig.asks();
    rig.view.setDailyTarget("500");
    expect(text(rig, "word-count-today")).toBe("320 of 500 typed today");
    expect(rig.container.getAttribute("aria-label")).toContain("of a 500 word target");
    // Today's count does not depend on the target, so asking the host again
    // would be a round trip for a number that cannot have changed.
    expect(rig.asks()).toBe(asked);
  });

  test("a goal set before the first answer is honoured when it lands", async () => {
    const rig = mount({ dailyTarget: "off", projectProgress: progress(2000, 320) });
    rig.view.setDailyTarget("1000");
    // Nothing to paint yet, and nothing painted.
    expect(text(rig, "word-count-today")).toBe("");
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toBe("320 of 1,000 typed today");
  });

  test("a goal set after teardown paints nothing", () => {
    // The panel outlives the project: a switch destroys this view while the
    // panel that calls setDailyTarget stays mounted. Writing here would paint
    // into the element the NEXT project has already taken over.
    const rig = mount({ projectProgress: progress(2000, 320) });
    rig.view.destroy();
    rig.view.setDailyTarget("500");
    expect(rig.container.childElementCount).toBe(0);
    expect(rig.container.hasAttribute("aria-label")).toBe(false);
  });

  test("a day spent cutting reaches both channels", async () => {
    const rig = mount({ dailyTarget: "500", projectProgress: progress(1100, -900) });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toBe("−900 of 500 typed today");
    expect(rig.container.getAttribute("aria-label")).toContain("900 words cut today");
  });
});

describe("the session hook", () => {
  test("every recomputation reports the count it just made", () => {
    // The session accumulator's ONLY view of the open document. Without this
    // call the panel reports a manuscript that nobody wrote in, and every other
    // test in this file still passes: the bar is unaffected.
    const seen: number[] = [];
    const rig = mount({ scene: 10, onSceneWords: (words) => seen.push(words) });
    // The mount reads sceneWords() in its initializer rather than through the
    // painting path, so nothing is reported yet.
    expect(seen).toEqual([]);
    rig.view.refreshScene();
    rig.setScene(14);
    rig.view.refreshScene();
    rig.closeWindow();
    expect(seen).toEqual([10, 14]);
  });

  test("it is reported once per throttle window, not once per keystroke", () => {
    // The whole reason the hook lives here rather than on onChange. If this
    // ever fires per keystroke it has put a document walk back on the typing
    // path, which is the recorded regression.
    const seen: number[] = [];
    const rig = mount({ scene: 3, onSceneWords: (words) => seen.push(words) });
    rig.view.refreshScene();
    rig.view.refreshScene();
    rig.view.refreshScene();
    expect(seen).toEqual([3]);
    // One report per COUNT, and the extra count is the mount's own initializer
    // read - the one that deliberately does not report.
    expect(rig.counts()).toBe(seen.length + 1);
  });

  test("a switch reports immediately, because it is not a keystroke", () => {
    const seen: number[] = [];
    const rig = mount({ scene: 3, onSceneWords: (words) => seen.push(words) });
    rig.setScene(400);
    rig.view.refreshSceneNow();
    expect(seen).toEqual([400]);
  });

  test("the bar works with no hook at all, which is the corpus path", () => {
    const rig = mount({ scene: 7 });
    rig.view.refreshScene();
    expect(text(rig, "word-count-scene")).toContain("7");
  });
});

describe("the goal bar", () => {
  const progress = (total: number, today: number) => () => Promise.resolve({ total, today });

  /** #goal-bar as the footer builds it: aria-hidden, one child that is the
   *  fill. Not appended into the container - the real markup has it beside
   *  #word-count, not inside it. */
  const buildGoalBar = (): { goalBar: HTMLElement; fill: HTMLElement } => {
    const goalBar = document.createElement("span");
    const fill = document.createElement("span");
    goalBar.append(fill);
    goalBar.hidden = true;
    return { goalBar, fill };
  };

  test("hidden while the target is off, and while today is unknown", async () => {
    const { goalBar, fill } = buildGoalBar();
    const rig = mount({ dailyTarget: "500", goalBar, projectProgress: progress(100, 200) });
    // today unknown, before the first answer lands.
    expect(goalBar.hidden).toBe(true);
    await rig.view.refreshProject();
    expect(goalBar.hidden).toBe(false);
    expect(fill.style.width).toBe("40%");

    rig.view.setDailyTarget("off");
    expect(goalBar.hidden).toBe(true);
  });

  test("the fill clamps at both ends", async () => {
    const { goalBar, fill } = buildGoalBar();
    let today = 900;
    const rig = mount({
      dailyTarget: "500",
      goalBar,
      projectProgress: () => Promise.resolve({ total: 100, today }),
    });
    await rig.view.refreshProject();
    expect(fill.style.width).toBe("100%");

    today = -40;
    await rig.view.refreshProject();
    expect(fill.style.width).toBe("0%");
  });

  test("a failed refresh hides the bar again", async () => {
    const { goalBar, fill } = buildGoalBar();
    let fail = false;
    const rig = mount({
      dailyTarget: "500",
      goalBar,
      projectProgress: () =>
        fail ? Promise.reject(new Error("store is closed")) : Promise.resolve({ total: 9, today: 200 }),
    });
    await rig.view.refreshProject();
    expect(goalBar.hidden).toBe(false);
    expect(fill.style.width).toBe("40%");

    fail = true;
    await rig.view.refreshProject();
    // today goes back to null on a failed ask, same as the third figure it
    // is painted from.
    expect(goalBar.hidden).toBe(true);
  });

  test("without a goalBar dep nothing is painted and nothing throws", async () => {
    const rig = mount({ dailyTarget: "500", projectProgress: progress(100, 200) });
    await rig.view.refreshProject();
  });
});

describe("a paused book", () => {
  test("the bar says typing is not counted, the goal fill hides, and resuming restores both", async () => {
    const goalBar = document.createElement("span");
    const fill = document.createElement("span");
    goalBar.append(fill);
    const answer = { total: 100, today: 200, collecting: false };
    const rig = mount({ dailyTarget: "500", goalBar, projectProgress: () => Promise.resolve({ ...answer }) });
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toBe("typing not counted");
    expect(rig.container.getAttribute("aria-label")).toContain("typed words are not being counted");
    expect(goalBar.hidden).toBe(true);

    answer.collecting = true;
    await rig.view.refreshProject();
    expect(text(rig, "word-count-today")).toContain("200");
    expect(goalBar.hidden).toBe(false);
    expect(fill.style.width).toBe("40%");
  });
});
