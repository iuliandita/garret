// app/ui/src/banner.ts
// The one banner surface, factored out of project.ts (099) so the empty
// workspace can raise the same notices with nothing mounted: `mountEmpty`
// needs `raiseNotice` / `raiseFailure` / `announce` into the SAME container a
// mounted project uses, so a switch from empty to a book tears one surface
// down through one `destroy()` rather than two that happen to look alike.
import { splitHostDetail } from "./command-error";
import { t } from "./i18n";
import { createIcon } from "./icons";

/** How a message is meant to be taken.
 *
 *  SUCCESS AND FAILURE SHARED ONE RED role="alert" BAR until this was split,
 *  and it was the failure surface they shared: "Exported to <path>" was
 *  announced as an alert, painted in the same red as a save failure, and left
 *  across the top of the application with no way to dismiss it for the rest of
 *  the session. A writer who exported once had a permanent emergency on
 *  screen. Three shipped features reported success that way.
 *
 *  `success` (236) is a completed action: the neutral surface of `info` plus a
 *  check mark, and it goes away on its own. `info` is news that is not an
 *  outcome ("nothing earlier to go back to"). */
export type Tone = "info" | "success" | "problem" | "failure";

/** How long a piece of good news stays on screen.
 *
 *  Long enough to read a path in it, which is the longest thing it ever
 *  carries, and short enough that a writer who has read it does not have to act
 *  to make it go away. */
const INFO_BANNER_MS = 6000;

export interface Banner {
  /** `detail` is what goes behind the Details disclosure. Absent, a host
   *  diagnostic `command-error.ts` wrote into `text` is lifted out of it, so
   *  the headline stays one plain sentence. */
  raise(id: string, text: string, tone: Tone, detail?: string): void;
  /** Tear down every banner this instance raised: its timers, then its
   *  elements, in that order (a timer left running holds a live callback into
   *  a torn-down mount and its element is prepended to `<body>` rather than to
   *  anything the mount owns, so it would fire after the NEXT mount and remove
   *  whatever that one raised under the same id). `ids` is every id this
   *  caller ever raises, since nothing here tracks which are on screen. */
  destroy(ids: string[]): void;
}

/** One banner surface. Each caller (a mounted project, the empty workspace)
 *  holds its own instance, so a switch between them cannot leave a timer
 *  raised by one removing an element the other just raised under the same id. */
export function createBanner(): Banner {
  /** PER BANNER ID, not one shared timer.
   *
   *  A single shared one was cleared on EVERY raise, including a raise for a
   *  different id - so a failure arriving while a piece of good news was still
   *  counting down took that news's timer away and left it on screen until the
   *  project was destroyed. A smaller version of the defect the tones were
   *  introduced to fix: a success message that will not go away. */
  const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The height the banners take off the top of the window, as `--banner-h`
   *  on the root (238). Every banner is fixed at top 0, so it is the tallest
   *  one. The Library is a fixed region too and starts below it rather than
   *  under it; the book's own chrome keeps the banner over it, as before. */
  function publishHeight(): void {
    let height = 0;
    for (const el of document.querySelectorAll<HTMLElement>(".app-banner")) {
      height = Math.max(height, el.getBoundingClientRect().height);
    }
    document.documentElement.style.setProperty("--banner-h", `${Math.ceil(height)}px`);
  }

  function remove(el: HTMLElement): void {
    el.remove();
    publishHeight();
  }

  function raise(id: string, message: string, tone: Tone, explicitDetail?: string): void {
    const split = explicitDetail === undefined ? splitHostDetail(message) : { headline: message, detail: explicitDetail };
    const text = split.headline;
    const detail = split.detail === null || split.detail.trim() === "" ? null : split.detail;
    // Replace, never stack. A failure is latched by the caller so it can only
    // fire once, but a notice is not: two failed opens in a row would
    // otherwise leave duplicate elements sharing one id, which is invalid DOM.
    const previous = document.getElementById(id);
    if (previous !== null) remove(previous);
    const pending = noticeTimers.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      noticeTimers.delete(id);
    }
    const el = document.createElement("div");
    // POLITE for anything that is not a failure. An alert interrupts whatever a
    // screen reader is saying, which is right for "editing is paused" and wrong
    // for "exported to <path>" - the second is news, not an emergency.
    el.setAttribute("role", tone === "failure" ? "alert" : "status");
    el.id = id;
    el.dataset.tone = tone;
    el.className = "app-banner";
    // THE MESSAGE, AS THE ACCESSIBLE NAME TOO, and not belt-and-braces.
    // Measured by the replace rig: once the text moved into a child <span> to
    // make room for the dismiss button, a full AT-SPI subtree walk of this
    // element yielded ONLY "dismiss this message" - WebKitGTK prunes untyped
    // generic containers, so the span carrying the news was dropped and a
    // screen-reader user got a live region announcing the control and not the
    // content. Same reason #word-count carries its figures in an aria-label:
    // the accessible name is the channel certain to survive.
    el.setAttribute("aria-label", text);
    if (tone === "success") {
      const mark = document.createElement("span");
      mark.className = "app-banner-icon";
      mark.append(createIcon("circle-check"));
      el.append(mark);
    }
    const label = document.createElement("span");
    label.className = "app-banner-text";
    label.textContent = text;
    el.append(label);
    // THE RAW DIAGNOSTIC, BEHIND A DISCLOSURE. It is what a writer passes on
    // when asking for help, so it is kept, but it is SQLite's or the OS's
    // English and never the headline. A native <details>: its summary is a
    // keyboard stop with no script, which a failure banner must stay usable
    // with because it cannot be dismissed.
    if (detail !== null) {
      const more = document.createElement("details");
      more.className = "app-banner-details";
      const summary = document.createElement("summary");
      summary.textContent = t("banner.details");
      const raw = document.createElement("code");
      raw.textContent = detail;
      more.append(summary, raw);
      // Opening the details makes the banner taller.
      more.addEventListener("toggle", publishHeight);
      el.append(more);
    }
    // A FAILURE CANNOT BE DISMISSED. It means editing is paused, and a writer
    // who waves it away has hidden the one thing telling them their work is not
    // being saved. Everything else gets a way out, because a message with no
    // way out is what made the old surface so bad.
    if (tone !== "failure") {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "app-banner-dismiss";
      close.setAttribute("aria-label", t("banner.dismiss"));
      close.textContent = "×";
      close.addEventListener("click", () => remove(el));
      el.append(close);
    }
    document.body.prepend(el);
    publishHeight();
    if (tone === "info" || tone === "success") {
      // Good news goes away on its own. A problem does not: the writer has to
      // read it, and may need it while they work out what happened.
      noticeTimers.set(
        id,
        setTimeout(() => {
          remove(el);
          noticeTimers.delete(id);
        }, INFO_BANNER_MS),
      );
    }
  }

  function destroy(ids: string[]): void {
    for (const timer of noticeTimers.values()) clearTimeout(timer);
    noticeTimers.clear();
    for (const id of ids) document.getElementById(id)?.remove();
    publishHeight();
  }

  return { raise, destroy };
}
