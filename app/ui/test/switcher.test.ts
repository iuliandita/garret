import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createSwitcher,
  folderName,
  lossesNotice,
  registrationNotice,
  type ImportLosses,
  type ImportOutcome,
  type LegacyProtection,
  type ProjectSummary,
  type PendingRegistration,
  type Switcher,
} from "../src/switcher";
import type { MirrorPreview, MirrorReport } from "../src/switcher";
import type { RecoveryPoint } from "../src/recovery-indicator";
import type { Archive, ArchiveReport } from "../src/archive-indicator";
import { DE, createMessages, t } from "../src/i18n";

/** Every loss kind at 0 -- what a Markdown import always reports, and the
 *  fixture value every test not itself about the loss notice uses. */
const ZERO_LOSSES: ImportLosses = {
  tables: 0,
  pictures: 0,
  notes: 0,
  comments: 0,
  links: 0,
  fields: 0,
  lists: 0,
  revisions: 0,
};

const PROJECTS: ProjectSummary[] = [
  { path: "/p/one.mss", name: "One", modified_at: 3 },
  { path: "/p/two.mss", name: "Two", modified_at: 2 },
  { path: "/p/broken.mss", name: "Broken", modified_at: 1, error: "database is locked" },
  { path: "/moved/gone.mss", name: "gone", modified_at: 0, error: "unable to open database file", missing: true },
];

const NOW = 1_700_000_000_000;

const POINTS: RecoveryPoint[] = [
  { id: "2026-08-21T09-00-00Z", mtime_ms: NOW - 60_000, bytes: 102_400, hash: "a", verified: true, verified_at: NOW - 60_000 },
  { id: "2026-08-20T09-00-00Z", mtime_ms: NOW - 26 * 3_600_000, bytes: 101_000, hash: "b", verified: true, verified_at: NOW - 26 * 3_600_000 },
];

const ARCHIVE_DIR = "/home/w/.local/share/cc.local.app/recovery/one/archives";
const IMPORT_DIR = "/home/w/.local/share/cc.local.app/imports";
const NEW_DIR = "/home/w/.local/share/cc.local.app/projects";

/** OFF, which is the DEFAULT and not an error or an empty state. Enabling is a
 *  deliberate act because writing the whole manuscript somewhere new is not
 *  something to start by itself. */
const MIRROR_OFF: MirrorReport = {
  enabled: false,
  dir: "/data/mirror/one",
  files: 0,
  generated_at: null,
  last_ok: true,
  last_error: null,
  last_run_ms: null,
  paused: 0,
  updating: false,
  finding: null,
  identity_check: "clear",
};

const MIRROR_ON: MirrorReport = {
  ...MIRROR_OFF,
  enabled: true,
  files: 3,
  generated_at: 5_000,
};

const MIRROR_PREVIEW: MirrorPreview = {
  token: "preview-token",
  dir: MIRROR_OFF.dir,
  check_state: "ran",
  pin_state: "pinned",
  findings: [],
  files: 3,
  scope: ["destination", "project_name", "markdown", "wordlist"],
  limits: ["known_names", "excluded", "external"],
};

const LEGACY_PROTECTION: LegacyProtection[] = [
  { surface: "recovery", dir: "/legacy/recovery/one" },
  { surface: "mirror", dir: "/legacy/mirror/one" },
];

const ARCHIVES: Archive[] = [
  {
    id: "one-2026-08-21T09-00-00Z",
    file: "one-2026-08-21T09-00-00Z.db",
    manifest: "manifest.json",
    bytes: 102_400,
    at_ms: NOW - 60_000,
    verified: true,
    verified_at: NOW - 60_000,
  },
];

interface Calls {
  forgotten: string[];
  moved: number;
  list: number;
  created: string[];
  /** Names sent through the CHOOSE-A-FOLDER route, kept apart from `created`:
   *  the two are different acts and a test that could not tell them apart
   *  would pass against a build that wired the button to the wrong one. */
  createdIn: string[];
  newDir: number;
  switched: string[];
  notices: string[];
  dones: string[];
  listedImports: number;
  imported: string[];
  dismissed: number;
  listedPoints: number;
  listedLegacy: number;
  restored: string[];
  listedArchives: number;
  archived: number;
  renamed: string[];
  /** Every `enableMirror` argument, in order. The ARGUMENT and not a count:
   *  a toggle that sent `true` twice is the failure worth catching. */
  mirrored: boolean[];
  mirrorTokens: Array<string | undefined>;
  mirrorPreviews: number;
  checked: number;
  /** How many times the header's cast button ran its dep. */
  openCast: number;
}

interface Rig {
  container: HTMLElement;
  switcher: Switcher;
  calls: Calls;
}

interface RigOptions {
  listProjects?: () => Promise<ProjectSummary[]>;
  listPendingRegistrations?: () => Promise<PendingRegistration[]>;
  retryRegistration?: (token: string) => Promise<ProjectSummary>;
  createProject?: (name: string) => Promise<ProjectSummary>;
  createProjectIn?: (name: string) => Promise<ProjectSummary | null>;
  newDir?: () => Promise<string>;
  /** The FILES only. The rig wraps them in the report shape with `importDir`,
   *  so a test that is about the list does not have to restate a path. */
  currentName?: () => string;
  renameProject?: (name: string) => Promise<ProjectSummary>;
  forgetProject?: (path: string) => Promise<void>;
  moveProject?: () => Promise<ProjectSummary | null>;
  currentPath?: () => string;
  listImports?: () => Promise<string[]>;
  importDir?: string;
  importProject?: (filename: string) => Promise<ImportOutcome>;
  listRecoveryPoints?: () => Promise<RecoveryPoint[]>;
  legacyProtection?: () => Promise<LegacyProtection[]>;
  restorePoint?: (id: string, allowPictureGaps?: boolean) => Promise<ProjectSummary>;
  listArchives?: () => Promise<Archive[]>;
  archiveStatus?: () => Promise<ArchiveReport>;
  makeArchive?: () => Promise<Archive>;
  generateArchiveKey?: () => Promise<{ recipient: string } | null>;
  encryptedBackupDestination?: () => Promise<string | null>;
  chooseEncryptedBackupDestination?: () => Promise<string | null>;
  makeEncryptedArchive?: () => Promise<{ file: string; recipient: string; encrypted: true } | null>;
  verifyEncryptedArchive?: () => Promise<{ file: string; encrypted: true } | null>;
  restoreEncryptedArchive?: () => Promise<ProjectSummary | null>;
  canReportArchive?: () => Promise<boolean>;
  currentGeneration?: () => number;
  mirrorStatus?: () => Promise<MirrorReport>;
  previewMirror?: () => Promise<MirrorPreview>;
  enableMirror?: (on: boolean, token?: string) => Promise<MirrorReport>;
  checkMirror?: () => Promise<{ entries: number; hashed: number; changed: number; deleted: number }>;
  openCast?: () => void;
  copiesNeedAttention?: () => boolean;
}

function mount(options: RigOptions = {}): Rig {
  let mirrored: MirrorReport = MIRROR_OFF;
  const calls: Calls = {
    forgotten: [],
    moved: 0,
    mirrored: [],
    mirrorTokens: [],
    mirrorPreviews: 0,
    checked: 0,
    list: 0,
    created: [],
    createdIn: [],
    newDir: 0,
    switched: [],
    notices: [],
    dones: [],
    listedImports: 0,
    imported: [],
    dismissed: 0,
    listedPoints: 0,
    listedLegacy: 0,
    restored: [],
    listedArchives: 0,
    archived: 0,
    renamed: [],
    openCast: 0,
  };
  const container = document.createElement("header");
  document.body.appendChild(container);
  // The strip above the outline. A real id, because the switcher paints the
  // book's name into it and several tests read it back by id the way the page
  // does -- which is exactly why any LEFTOVER one has to go first. The suite
  // shares one document, `getElementById` answers with the FIRST match, and a
  // stale empty header from a previous mount made six of these tests fail
  // together while each passed alone.
  document.querySelectorAll("#nav-header").forEach((stale) => stale.remove());
  const nameContainer = document.createElement("div");
  nameContainer.id = "nav-header";
  document.body.appendChild(nameContainer);
  const switcher = createSwitcher({
    container,
    nameContainer,
    listProjects: () => {
      calls.list++;
      return options.listProjects?.() ?? Promise.resolve(PROJECTS);
    },
    listPendingRegistrations: options.listPendingRegistrations,
    retryRegistration: options.retryRegistration,
    createProject: (name) => {
      calls.created.push(name);
      return (
        options.createProject?.(name) ??
        Promise.resolve({ path: `/p/${name}.mss`, name, modified_at: 9 })
      );
    },
    createProjectIn: (name) => {
      calls.createdIn.push(name);
      return (
        options.createProjectIn?.(name) ??
        Promise.resolve({ path: `/chosen/${name}.db`, name, modified_at: 9 })
      );
    },
    newDir: () => {
      calls.newDir++;
      return options.newDir?.() ?? Promise.resolve(NEW_DIR);
    },
    listImports: () => {
      calls.listedImports++;
      return (options.listImports?.() ?? Promise.resolve([])).then((files) => ({
        dir: options.importDir ?? IMPORT_DIR,
        files,
      }));
    },
    importProject: (filename) => {
      calls.imported.push(filename);
      return (
        options.importProject?.(filename) ??
        Promise.resolve({
          summary: { path: `/p/${filename}.mss`, name: filename, modified_at: 9 },
          losses: ZERO_LOSSES,
        })
      );
    },
    listRecoveryPoints: () => {
      calls.listedPoints++;
      return options.listRecoveryPoints?.() ?? Promise.resolve([]);
    },
    legacyProtection: () => {
      calls.listedLegacy++;
      return options.legacyProtection?.() ?? Promise.resolve([]);
    },
    restorePoint: (id, allowPictureGaps) => {
      calls.restored.push(id);
      return (
        options.restorePoint?.(id, allowPictureGaps) ??
        Promise.resolve({ path: `/p/${id}-recovered.mss`, name: "One (recovered)", modified_at: 9 })
      );
    },
    listArchives: () => {
      calls.listedArchives++;
      return options.listArchives?.() ?? Promise.resolve([]);
    },
    archiveStatus: () =>
      options.archiveStatus?.() ??
      Promise.resolve({
        slug: "one",
        dir: ARCHIVE_DIR,
        newest_verified_ms: null,
        archives: 0,
      }),
    makeArchive: () => {
      calls.archived++;
      return options.makeArchive?.() ?? Promise.resolve(ARCHIVES[0]!);
    },
    generateArchiveKey: options.generateArchiveKey,
    encryptedBackupDestination: options.encryptedBackupDestination,
    chooseEncryptedBackupDestination: options.chooseEncryptedBackupDestination,
    makeEncryptedArchive: options.makeEncryptedArchive,
    verifyEncryptedArchive: options.verifyEncryptedArchive,
    restoreEncryptedArchive: options.restoreEncryptedArchive,
    canReportArchive: options.canReportArchive,
    currentGeneration: options.currentGeneration,
    // STATEFUL, because the toggle repaints from `mirrorStatus` after
    // `enableMirror` resolves. A fake that always answered OFF would report the
    // mirror off immediately after turning it on, and the test would be
    // asserting the fake's forgetfulness rather than the page's behaviour.
    mirrorStatus: () => options.mirrorStatus?.() ?? Promise.resolve(mirrored),
    previewMirror: () => {
      calls.mirrorPreviews++;
      return options.previewMirror?.() ?? Promise.resolve(MIRROR_PREVIEW);
    },
    enableMirror: (on, token) => {
      calls.mirrored.push(on);
      calls.mirrorTokens.push(token);
      if (options.enableMirror) return options.enableMirror(on, token);
      mirrored = {
        ...MIRROR_OFF,
        enabled: on,
        files: on ? 3 : 0,
        generated_at: on ? 5_000 : null,
      };
      return Promise.resolve(mirrored);
    },
    checkMirror: () => {
      calls.checked++;
      return options.checkMirror?.() ?? Promise.resolve({ entries: 3, hashed: 3, changed: 0, deleted: 0 });
    },
    switchTo: (path) => {
      calls.switched.push(path);
      return Promise.resolve();
    },
    currentPath: () => options.currentPath?.() ?? "/p/one.mss",
    currentName: () => options.currentName?.() ?? "One",
    renameProject: (next) => {
      calls.renamed.push(next);
      return (
        options.renameProject?.(next) ??
        Promise.resolve({ path: "/p/one.mss", name: next, modified_at: 9 })
      );
    },
    forgetProject: (path) => {
      calls.forgotten.push(path);
      return options.forgetProject?.(path) ?? Promise.resolve();
    },
    moveProject: () => {
      calls.moved++;
      return options.moveProject?.() ?? Promise.resolve(null);
    },
    copiesNeedAttention: options.copiesNeedAttention,
    openCast: () => {
      calls.openCast++;
      options.openCast?.();
    },
    onNotice: (message) => calls.notices.push(message),
    onDone: (message) => calls.dones.push(message),
    onDismiss: () => {
      calls.dismissed++;
    },
  });
  return { container, switcher, calls };
}

/** Lets the promise chain behind a dispatched click settle. Deliberately
 *  several ticks: the handlers await a call and then repaint. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const el = (container: HTMLElement, id: string): HTMLElement => {
  const found = container.querySelector(`#${id}`);
  if (found === null) throw new Error(`${id} is not in the switcher`);
  return found as HTMLElement;
};

const optionFor = (container: HTMLElement, path: string): HTMLElement => {
  const found = container.querySelector(`[data-project-path="${path}"]`);
  if (found === null) throw new Error(`no option for ${path}`);
  return found as HTMLElement;
};

const click = (target: HTMLElement): void => {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

/** The panel has exactly one route in now: the File menu, through open(). */
async function open(rig: Rig, focus: "list" | "create" | "import" | "copies" | "backups" | "restore" = "list"): Promise<void> {
  rig.switcher.open(focus);
  await settle();
}

function teardown(rig: Rig): void {
  rig.switcher.destroy();
  rig.container.remove();
  document.getElementById("nav-header")?.remove();
}

describe("switcher structure", () => {
  test("the strip is a banner, and the name is no longer in it", () => {
    // The name moved to #nav-header. The banner role stays: the
    // strip is still the page's chrome landmark.
    const rig = mount();
    expect(rig.container.getAttribute("role")).toBe("banner");
    expect(rig.container.querySelectorAll("#project-name").length).toBe(0);
    teardown(rig);
  });

  test("the panel starts hidden", () => {
    const rig = mount();
    expect((el(rig.container, "project-panel") as HTMLElement).hidden).toBe(true);
    teardown(rig);
  });

  test("the bar carries no control that opens the panel", () => {
    // The retirement slice deleted #project-toggle: the application menu is the
    // only route in. Two routes to one panel is the duplication the slice
    // removed, so re-adding a button here must fail rather than pass quietly.
    // Scoped to DIRECT children, because the panel itself legitimately holds a
    // Create button.
    const rig = mount();
    // Counts and ids, never the elements themselves: a failing toBe on a
    // happy-dom node prints the whole node, which is what once made a live
    // mutation read as a survivor by timing its own runner out.
    expect(rig.container.querySelectorAll("#project-toggle").length).toBe(0);
    expect(rig.container.querySelectorAll(":scope > button").length).toBe(0);
    expect([...rig.container.children].map((child) => child.id)).toEqual(["project-panel"]);
    teardown(rig);
  });

  test("the panel is a non-modal dialog", () => {
    // aria-modal="false" is the honest answer: nothing here traps focus.
    const rig = mount();
    const panel = el(rig.container, "project-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.getAttribute("aria-label")).toBe(t("switcher.title"));
    expect(el(rig.container, "project-list").getAttribute("aria-label")).toBe(t("switcher.title"));
    teardown(rig);
  });

  test("new book creation has a heading after Move and before the name field", () => {
    const rig = mount();
    const heading = el(rig.container, "project-new-heading");
    expect(heading.getAttribute("role")).toBe("heading");
    expect(heading.getAttribute("aria-level")).toBe("3");
    expect(heading.textContent).toBe(t("switcher.new.heading"));
    expect(heading.getAttribute("aria-label")).toBe(t("switcher.new.heading"));
    expect(heading.previousElementSibling?.id).toBe("project-move");
    const field = el(rig.container, "project-new-name") as HTMLInputElement;
    field.value = "Dracula";
    expect(heading.nextElementSibling?.contains(field)).toBe(true);
    expect(field.labels?.[0]?.textContent).toBe(t("switcher.name.label"));
    teardown(rig);
  });

  test("refresh repaints the current project name", () => {
    const rig = mount();
    rig.switcher.refresh("Renamed");
    expect((document.getElementById("nav-header") as HTMLElement).textContent).toContain(
      "Renamed",
    );
    teardown(rig);
  });
});

describe("switcher opening", () => {
  test("open shows the panel and lists projects", async () => {
    const rig = mount();
    await open(rig);
    expect((el(rig.container, "project-panel") as HTMLElement).hidden).toBe(false);
    expect(rig.calls.list).toBe(1);
    expect(rig.container.querySelectorAll("[data-project-path]").length).toBe(4);
    teardown(rig);
  });

  test("each open re-lists, so a project created elsewhere appears", async () => {
    // open() is idempotent by design - the menu item says "open", so a second
    // request from a writer already looking at the panel must not close it, and
    // must re-read a library that may have changed.
    const rig = mount();
    await open(rig);
    await open(rig);
    expect(rig.calls.list).toBe(2);
    expect((el(rig.container, "project-panel") as HTMLElement).hidden).toBe(false);
    teardown(rig);
  });

  test("same-named healthy books show their distinct paths while unique names stay name-only", async () => {
    const rig = mount({
      listProjects: () => Promise.resolve([
        { path: "/one/draft.db", name: "Draft", modified_at: 3 },
        { path: "/two/draft.db", name: "Draft", modified_at: 2 },
        { path: "/three/harbour.db", name: "Harbour", modified_at: 1 },
      ]),
    });
    await open(rig);

    const first = optionFor(rig.container, "/one/draft.db");
    const second = optionFor(rig.container, "/two/draft.db");
    const unique = optionFor(rig.container, "/three/harbour.db");
    expect(first.textContent).toBe("Draft/one/draft.db");
    expect(second.textContent).toBe("Draft/two/draft.db");
    expect(first.querySelector(".switcher-project-path")?.textContent).toBe(
      "/one/draft.db",
    );
    expect(second.querySelector(".switcher-project-path")?.textContent).toBe(
      "/two/draft.db",
    );
    expect(first.getAttribute("aria-label")).toBe("Draft, /one/draft.db");
    expect(second.getAttribute("aria-label")).toBe("Draft, /two/draft.db");
    expect(unique.textContent).toBe("Harbour");
    expect(unique.querySelector(".switcher-project-path")).toBeNull();
    expect(unique.getAttribute("aria-label")).toBeNull();
    teardown(rig);
  });

  test("open(create) puts the caret in the name field", async () => {
    const rig = mount();
    await open(rig, "create");
    expect(document.activeElement).toBe(el(rig.container, "project-new-name"));
    teardown(rig);
  });

  test("open(list) advances to the current book and open(import) focuses its list", async () => {
    const rig = mount();
    await open(rig, "list");
    expect(document.activeElement?.className).toBe("switcher-open");
    expect((document.activeElement?.parentElement as HTMLElement)?.dataset.projectPath).toBe("/p/one.mss");
    await open(rig, "import");
    expect(document.activeElement?.id).toBe("project-imports");
    teardown(rig);
  });

  test("the listbox shows a loading row until the list resolves", async () => {
    let release: (value: ProjectSummary[]) => void = () => {};
    const pending = new Promise<ProjectSummary[]>((resolve) => {
      release = resolve;
    });
    const rig = mount({ listProjects: () => pending });
    rig.switcher.open("list");
    const listbox = el(rig.container, "project-list");
    expect(listbox.getAttribute("role")).toBe("list");
    expect(listbox.childElementCount).toBe(1);
    expect(listbox.textContent).toContain("Loading");
    release(PROJECTS);
    await settle();
    expect(rig.container.querySelectorAll("[data-project-path]").length).toBe(4);
    teardown(rig);
  });

  test("a reload that resolves after destroy does not repaint a detached listbox", async () => {
    // The generation guard in reload() and its bump in destroy() are the only
    // things stopping a late listProjects from rendering rows into a listbox
    // that is no longer in the document - and, worse, from those rows carrying
    // click handlers into a switcher that has been torn down.
    let release: (value: ProjectSummary[]) => void = () => {};
    const pending = new Promise<ProjectSummary[]>((resolve) => {
      release = resolve;
    });
    const rig = mount({ listProjects: () => pending });
    rig.switcher.open("list");
    const listbox = el(rig.container, "project-list");
    expect(listbox.textContent).toContain("Loading");

    rig.switcher.destroy();
    release(PROJECTS);
    await settle();

    expect(listbox.querySelectorAll("[data-project-path]").length).toBe(0);
    expect(rig.container.childElementCount).toBe(0);
    rig.container.remove();
  });

  test("exactly one row carries aria-current", async () => {
    const rig = mount();
    await open(rig);
    const marked = rig.container.querySelectorAll("[aria-current]");
    expect(marked.length).toBe(1);
    expect((marked[0] as HTMLElement).dataset.projectPath).toBe("/p/one.mss");
    teardown(rig);
  });

  test("a rejecting listProjects reaches onNotice and does not throw", async () => {
    const rig = mount({ listProjects: () => Promise.reject(new Error("no projects dir")) });
    await open(rig);
    expect(rig.calls.notices).toEqual(["no projects dir"]);
    teardown(rig);
  });
});

describe("Books initial focus", () => {
  test("the current book owns focus when the project listing arrives", async () => {
    const rig = mount();
    try {
      await open(rig);
      expect((document.activeElement?.parentElement as HTMLElement)?.dataset.projectPath).toBe("/p/one.mss");
    } finally { teardown(rig); }
  });

  test("without a current listed book the first available row owns focus", async () => {
    const rig = mount({ currentPath: () => "/outside/book.db" });
    try {
      await open(rig);
      expect((document.activeElement?.parentElement as HTMLElement)?.dataset.projectPath).toBe("/p/one.mss");
    } finally { teardown(rig); }
  });

  test("a delayed listing cannot take focus from the name field", async () => {
    let release!: (projects: ProjectSummary[]) => void;
    const rig = mount({ listProjects: () => new Promise((resolve) => { release = resolve; }) });
    try {
      rig.switcher.open("list");
      el(rig.container, "project-new-name").focus();
      release(PROJECTS);
      await settle();
      expect(document.activeElement?.id).toBe("project-new-name");
    } finally { teardown(rig); }
  });
});

describe("switcher activation", () => {
  test("clicking an option switches to that row's path and closes the panel", async () => {
    // Dispatched, not by calling a handler directly: a test that invokes the
    // handler passes with no listener installed at all.
    const rig = mount();
    await open(rig);
    click(optionFor(rig.container, "/p/two.mss"));
    await settle();
    expect(rig.calls.switched).toEqual(["/p/two.mss"]);
    expect((el(rig.container, "project-panel") as HTMLElement).hidden).toBe(true);
    teardown(rig);
  });

  test("clicking the current project only closes the panel", async () => {
    const rig = mount();
    await open(rig);
    click(optionFor(rig.container, "/p/one.mss"));
    await settle();
    expect(rig.calls.switched).toEqual([]);
    expect((el(rig.container, "project-panel") as HTMLElement).hidden).toBe(true);
    teardown(rig);
  });

  test("clicking an errored option reports the error and switches nothing", async () => {
    // An unreadable manuscript must be visible and inert, not absent.
    const rig = mount();
    await open(rig);
    click(optionFor(rig.container, "/p/broken.mss"));
    await settle();
    expect(rig.calls.switched).toEqual([]);
    expect(rig.calls.notices).toEqual(["database is locked"]);
    // Inert means the panel is still there to try something else in.
    expect((el(rig.container, "project-panel") as HTMLElement).hidden).toBe(false);
    teardown(rig);
  });

  test("a missing book says where it was looked for and offers Forget; no other row does", async () => {
    const rig = mount();
    await open(rig);
    const gone = optionFor(rig.container, "/moved/gone.mss");
    expect(gone.getAttribute("role")).toBe("listitem");
    expect(gone.hasAttribute("aria-disabled")).toBe(false);
    expect(gone.textContent).toContain("gone - not found at /moved/gone.mss");
    const button = gone.querySelector<HTMLButtonElement>("[data-forget-path]");
    expect(button?.dataset.forgetPath).toBe("/moved/gone.mss");
    expect(button?.getAttribute("aria-label")).toBe("Forget gone");
    // The SQLite text is not the sentence a writer needs, so it is not shown.
    expect(gone.textContent).not.toContain("unable to open");
    expect(rig.container.querySelectorAll("[data-forget-path]").length).toBe(1);
    teardown(rig);
  });

  test("clicking a missing row itself explains, switches nothing and forgets nothing", async () => {
    const rig = mount();
    await open(rig);
    click(optionFor(rig.container, "/moved/gone.mss"));
    await settle();
    expect(rig.calls.switched).toEqual([]);
    expect(rig.calls.forgotten).toEqual([]);
    expect(rig.calls.notices[0]).toContain("There is no file at /moved/gone.mss");
    teardown(rig);
  });

  test("Forget asks the host for that path, then re-lists, and never switches", async () => {
    const rig = mount();
    await open(rig);
    const before = rig.calls.list;
    const button = optionFor(rig.container, "/moved/gone.mss").querySelector<HTMLElement>("[data-forget-path]");
    click(button as HTMLElement);
    await settle();
    expect(rig.calls.forgotten).toEqual(["/moved/gone.mss"]);
    expect(rig.calls.list).toBe(before + 1);
    expect(rig.calls.switched).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("the panel says where the open book is", async () => {
    const rig = mount();
    await open(rig);
    // The folder's name, the whole path on hover.
    const here = rig.container.querySelector<HTMLElement>("#project-here");
    expect(here?.textContent).toBe("This book is in p");
    expect(here?.title).toBe("/p/one.mss");
    expect(rig.container.querySelector<HTMLButtonElement>("#project-move")?.textContent).toBe("Move this book\u2026");
    teardown(rig);
  });

  test("Move asks the host, then repaints the path from the caller's copy and re-lists", async () => {
    let path = "/p/one.mss";
    const rig = mount({
      currentPath: () => path,
      moveProject: () => {
        path = "/elsewhere/one.mss";
        return Promise.resolve({ path, name: "One", modified_at: 0 });
      },
    });
    await open(rig);
    const before = rig.calls.list;
    click(rig.container.querySelector("#project-move") as HTMLElement);
    await settle();
    expect(rig.calls.moved).toBe(1);
    expect(rig.calls.list).toBe(before + 1);
    expect(rig.container.querySelector("#project-here")?.textContent).toBe("This book is in elsewhere");
    expect(rig.container.querySelector<HTMLElement>("#project-here")?.title).toBe("/elsewhere/one.mss");
    expect(rig.calls.switched).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("a cancelled move re-lists nothing and says nothing", async () => {
    const rig = mount();
    await open(rig);
    const before = rig.calls.list;
    click(rig.container.querySelector("#project-move") as HTMLElement);
    await settle();
    expect(rig.calls.moved).toBe(1);
    expect(rig.calls.list).toBe(before);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("a move the host refuses reaches the writer and the list is not re-read", async () => {
    const rig = mount({ moveProject: () => Promise.reject(new Error("another drive")) });
    await open(rig);
    const before = rig.calls.list;
    click(rig.container.querySelector("#project-move") as HTMLElement);
    await settle();
    expect(rig.calls.notices).toEqual(["another drive"]);
    expect(rig.calls.list).toBe(before);
    teardown(rig);
  });

  test("a refusal from the host reaches the writer and the list is not re-read", async () => {
    const rig = mount({ forgetProject: () => Promise.reject(new Error("still there")) });
    await open(rig);
    const before = rig.calls.list;
    const button = optionFor(rig.container, "/moved/gone.mss").querySelector<HTMLElement>("[data-forget-path]");
    click(button as HTMLElement);
    await settle();
    expect(rig.calls.notices).toEqual(["still there"]);
    expect(rig.calls.list).toBe(before);
    teardown(rig);
  });

  test("a rejecting switchTo reaches onNotice", async () => {
    const calls: string[] = [];
    const container = document.createElement("header");
    document.body.appendChild(container);
    const nameContainer = document.createElement("div");
    document.body.appendChild(nameContainer);
    const switcher = createSwitcher({
      container,
      nameContainer,
      listProjects: () => Promise.resolve(PROJECTS),
      createProject: (name) => Promise.resolve({ path: "/p/x", name, modified_at: 0 }),
      createProjectIn: (name) => Promise.resolve({ path: "/p/x", name, modified_at: 0 }),
      newDir: () => Promise.resolve(NEW_DIR),
      listImports: () => Promise.resolve({ dir: IMPORT_DIR, files: [] }),
      importProject: (filename) =>
        Promise.resolve({
          summary: { path: "/p/x", name: filename, modified_at: 0 },
          losses: ZERO_LOSSES,
        }),
      listRecoveryPoints: () => Promise.resolve([]),
      restorePoint: (id) => Promise.resolve({ path: "/p/x", name: id, modified_at: 0 }),
      listArchives: () => Promise.resolve([]),
      archiveStatus: () =>
        Promise.resolve({ slug: "one", dir: ARCHIVE_DIR, newest_verified_ms: null, archives: 0 }),
      makeArchive: () => Promise.resolve(ARCHIVES[0]!),
      mirrorStatus: () => Promise.resolve(MIRROR_OFF),
      previewMirror: () => Promise.resolve(MIRROR_PREVIEW),
      enableMirror: () => Promise.resolve(MIRROR_OFF),
      checkMirror: () => Promise.resolve({ entries: 0, hashed: 0, changed: 0, deleted: 0 }),
      switchTo: () => Promise.reject(new Error("busy")),
      currentPath: () => "/p/one.mss",
      currentName: () => "One",
      renameProject: (next) => Promise.resolve({ path: "/p/x", name: next, modified_at: 0 }),
      forgetProject: () => Promise.resolve(),
      moveProject: () => Promise.resolve(null),
      openCast: () => {},
      onNotice: (message) => calls.push(message),
      onDone: () => {},
      onDismiss: () => {},
    });
    switcher.open("list");
    await settle();
    click(container.querySelector('[data-project-path="/p/two.mss"]') as HTMLElement);
    await settle();
    expect(calls).toEqual(["busy"]);
    switcher.destroy();
    container.remove();
  });

  test("Escape on the panel closes it and hands focus back to the page once", async () => {
    // Listened for on the panel, never on document: an Escape meant for the
    // editor must not be swallowed by a closed switcher. The unit no longer
    // owns a focus-return target of its own, so it asks the page for one -
    // exactly once, or a second caller would fight over where focus lands.
    const rig = mount();
    await open(rig);
    const panel = el(rig.container, "project-panel");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect((panel as HTMLElement).hidden).toBe(true);
    expect(rig.calls.dismissed).toBe(1);
    teardown(rig);
  });

  test("a key that is not Escape neither closes the panel nor dismisses", async () => {
    // Without this, an onDismiss called for every keystroke satisfies the test
    // above just as well.
    const rig = mount();
    await open(rig);
    const panel = el(rig.container, "project-panel");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await settle();
    expect((panel as HTMLElement).hidden).toBe(false);
    expect(rig.calls.dismissed).toBe(0);
    teardown(rig);
  });
});

describe("switcher creation: where the book goes", () => {
  // The product spec has required "one canonical portable atomic
  // project file in a user-chosen location" since 2026-07-22 and the library
  // path was hardcoded until now.

  test("the panel says where new books go, before anything is created", async () => {
    // For its reason: the resolved destination is the thing
    // being consented to. This is also the line that catches a book about to
    // land in a folder the writer syncs.
    const rig = mount();
    await open(rig, "create");
    // The folder's name in the sentence, the whole path on hover.
    expect(el(rig.container, "project-new-where").textContent).toContain(folderName(NEW_DIR, false));
    expect(el(rig.container, "project-new-where").title).toBe(NEW_DIR);
    expect(rig.calls.newDir).toBeGreaterThan(0);
    teardown(rig);
  });

  test("a destination that cannot be read says SO rather than showing the library", async () => {
    // Painting the library would tell the writer a place their book is not
    // going to, which is worse than saying the answer is unavailable.
    const rig = mount({ newDir: () => Promise.reject(new Error("nope")) });
    await open(rig, "create");
    const where = el(rig.container, "project-new-where").textContent ?? "";
    expect(where).toContain("Cannot read");
    expect(where).not.toContain(NEW_DIR);
    teardown(rig);
  });

  test("Choose a folder sends the typed name through the DIALOG route", async () => {
    const rig = mount();
    await open(rig, "create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "  The Harbour  ";
    click(el(rig.container, "project-new-choose"));
    await settle();
    expect(rig.calls.createdIn).toEqual(["The Harbour"]);
    // NOT the other route. The two are different acts, and a build that wired
    // the button to `createProject` would put the book in the library while
    // telling the writer they had chosen.
    expect(rig.calls.created).toEqual([]);
    expect((el(rig.container, "project-new-name") as HTMLInputElement).value).toBe("");
    teardown(rig);
  });

  test("cancelling the folder dialog keeps the typed name and says nothing", async () => {
    // The writer did exactly what they intended. Clearing the name would make
    // them retype a book they were half way through naming, and a notice would
    // report their own decision as a problem.
    const rig = mount({ createProjectIn: () => Promise.resolve(null) });
    await open(rig, "create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "The Harbour";
    click(el(rig.container, "project-new-choose"));
    await settle();
    expect(rig.calls.notices).toEqual([]);
    expect((el(rig.container, "project-new-name") as HTMLInputElement).value).toBe("The Harbour");
    teardown(rig);
  });

  test("Choose a folder with no name refuses, exactly as Create does", async () => {
    const rig = mount();
    await open(rig, "create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "   ";
    click(el(rig.container, "project-new-choose"));
    await settle();
    expect(rig.calls.createdIn).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("a refusal from the host reaches the writer", async () => {
    // The stem collision is the one a writer will actually meet: two books
    // cannot share a file name even in different folders.
    const rig = mount({
      createProjectIn: () => Promise.reject(new Error("draft.db is already used by /elsewhere/draft.db")),
    });
    await open(rig, "create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "Draft";
    click(el(rig.container, "project-new-choose"));
    await settle();
    expect(rig.calls.notices.join(" ")).toContain("draft.db");
    teardown(rig);
  });
});

describe("switcher creation", () => {
  test("Create with blank whitespace does nothing", async () => {
    const rig = mount();
    await open(rig, "create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "   ";
    click(el(rig.container, "project-create"));
    await settle();
    expect(rig.calls.created).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("Create with a name creates, clears the input and does not switch", async () => {
    const rig = mount();
    await open(rig, "create");
    const input = el(rig.container, "project-new-name") as HTMLInputElement;
    input.value = "  Third  ";
    click(el(rig.container, "project-create"));
    await settle();
    expect(rig.calls.created).toEqual(["Third"]);
    expect(rig.calls.switched).toEqual([]);
    expect(input.value).toBe("");
    expect(rig.calls.list).toBe(2);
    teardown(rig);
  });

  test("a rejecting createProject reaches onNotice", async () => {
    const rig = mount({ createProject: () => Promise.reject(new Error("name taken")) });
    await open(rig, "create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "Third";
    click(el(rig.container, "project-create"));
    await settle();
    expect(rig.calls.notices).toEqual(["name taken"]);
    teardown(rig);
  });
});

describe("Books creation feedback", () => {
  for (const route of ["project-create", "project-new-choose"] as const) {
    test(`${route} announces the returned name without switching`, async () => {
      const result = { path: "/new/book.db", name: "Returned name", modified_at: 9 };
      const rig = mount({ createProject: async () => result, createProjectIn: async () => result });
      try {
        await open(rig, "create");
        (el(rig.container, "project-new-name") as HTMLInputElement).value = "Requested name";
        click(el(rig.container, route));
        await settle();
        expect(rig.calls.dones).toEqual([t("switcher.done.created", { name: result.name })]);
        expect(rig.calls.switched).toEqual([]);
      } finally { teardown(rig); }
    });

    test(`${route} preserves a newer draft while reporting completed creation`, async () => {
      let release!: (project: ProjectSummary) => void;
      const pending = new Promise<ProjectSummary>((resolve) => { release = resolve; });
      const rig = mount({ createProject: () => pending, createProjectIn: () => pending });
      try {
        await open(rig, "create");
        const input = el(rig.container, "project-new-name") as HTMLInputElement;
        input.value = "Requested name";
        click(el(rig.container, route));
        input.value = "Next book";
        release({ path: "/new/book.db", name: "Returned name", modified_at: 9 });
        await settle();
        expect(input.value).toBe("Next book");
        expect(rig.calls.dones).toEqual([t("switcher.done.created", { name: "Returned name" })]);
      } finally { teardown(rig); }
    });

    test(`${route} stays serialized through its pending privacy check`, async () => {
      let release!: (allowed: boolean) => void;
      const pending = new Promise<boolean>((resolve) => { release = resolve; });
      const result = { path: "/new/book.db", name: "Returned name", modified_at: 9 };
      const rig = mount({ createProject: async () => result, createProjectIn: async () => result, canReportArchive: () => pending });
      try {
        await open(rig, "create");
        const input = el(rig.container, "project-new-name") as HTMLInputElement;
        input.value = "Requested name";
        click(el(rig.container, route));
        await settle();
        input.value = "Next book";
        click(el(rig.container, route));
        expect(rig.calls.created.length + rig.calls.createdIn.length).toBe(1);
        release(true);
        await settle();
        expect(input.value).toBe("Next book");
        expect(rig.calls.dones).toHaveLength(1);
      } finally { teardown(rig); }
    });

    test(`${route} rechecks context after a pending privacy check`, async () => {
      let release!: (allowed: boolean) => void;
      const pending = new Promise<boolean>((resolve) => { release = resolve; });
      const result = { path: "/new/book.db", name: "Returned name", modified_at: 9 };
      const rig = mount({ createProject: async () => result, createProjectIn: async () => result, canReportArchive: () => pending });
      try {
        await open(rig, "create");
        const input = el(rig.container, "project-new-name") as HTMLInputElement;
        input.value = "Requested name";
        click(el(rig.container, route));
        await settle();
        await open(rig, "create");
        input.value = "Next book";
        release(true);
        await settle();
        expect(input.value).toBe("Next book");
        expect(rig.calls.dones).toEqual([t("switcher.done.created", { name: result.name })]);
      } finally { teardown(rig); }
    });

    for (const departure of ["close", "reopen", "project", "generation", "privacy", "destroy"] as const) {
      test(`${route} reports same-workspace outcomes after ${departure} without clearing stale drafts`, async () => {
        let release!: (project: ProjectSummary) => void;
        const pending = new Promise<ProjectSummary>((resolve) => { release = resolve; });
        let path = "/p/one.mss";
        let generation = 1;
        let reportAllowed = true;
        const rig = mount({ createProject: () => pending, createProjectIn: () => pending,
          currentPath: () => path, currentGeneration: () => generation, canReportArchive: async () => reportAllowed });
        try {
          await open(rig, "create");
          const input = el(rig.container, "project-new-name") as HTMLInputElement;
          input.value = "Requested name";
          click(el(rig.container, route));
          if (departure === "close") el(rig.container, "project-panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          if (departure === "reopen") await open(rig, "create");
          if (departure === "project") path = "/p/two.mss";
          if (departure === "generation") generation++;
          if (departure === "privacy") reportAllowed = false;
          if (departure === "destroy") rig.switcher.destroy();
          input.value = "New draft";
          const listings = rig.calls.list;
          release({ path: "/new/book.db", name: "Returned name", modified_at: 9 });
          await settle();
          expect(rig.calls.dones).toEqual(departure === "close" || departure === "reopen"
            ? [t("switcher.done.created", { name: "Returned name" })] : []);
          expect(input.value).toBe("New draft");
          expect(rig.calls.list).toBe(listings);
        } finally { teardown(rig); }
      });
    }
  }

  test("the ordinary empty state remains when no book is open", async () => {
    const rig = mount({ currentPath: () => "", listProjects: async () => [] });
    try { await open(rig); expect(el(rig.container, "project-list").textContent).toBe(t("switcher.empty")); }
    finally { teardown(rig); }
  });
});

describe("switcher teardown", () => {
  test("destroy empties the container and a detached row does nothing", async () => {
    const rig = mount();
    await open(rig);
    const row = optionFor(rig.container, "/p/two.mss");
    rig.switcher.destroy();
    expect(rig.container.childElementCount).toBe(0);
    click(row);
    await settle();
    expect(rig.calls.switched).toEqual([]);
    rig.container.remove();
  });

  test("destroy removes the create listener", async () => {
    const rig = mount();
    await open(rig, "create");
    const create = el(rig.container, "project-create");
    (el(rig.container, "project-new-name") as HTMLInputElement).value = "Third";
    rig.switcher.destroy();
    click(create);
    await settle();
    expect(rig.calls.created).toEqual([]);
    rig.container.remove();
  });

  test("destroy removes the panel's Escape listener", async () => {
    const rig = mount();
    await open(rig);
    const panel = el(rig.container, "project-panel");
    rig.switcher.destroy();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(rig.calls.dismissed).toBe(0);
    rig.container.remove();
  });
});

describe("switcher import", () => {
  function importRows(rig: Rig): string[] {
    return [...rig.container.querySelectorAll("[data-import-file]")].map(
      (row) => (row as HTMLElement).dataset.importFile ?? "",
    );
  }

  test("opening the panel lists the importable files", async () => {
    const rig = mount({ listImports: () => Promise.resolve(["a.md", "b.md"]) });
    await open(rig, "import");
    expect(rig.calls.listedImports).toBe(1);
    expect(importRows(rig)).toEqual(["a.md", "b.md"]);
    teardown(rig);
  });

  test("an empty drop directory says where to put a file", async () => {
    // "Nothing to import" is not actionable: a writer who has not put a file
    // anywhere needs to be told there is a somewhere.
    const rig = mount({ listImports: () => Promise.resolve([]) });
    await open(rig, "import");
    const list = rig.container.querySelector("#project-imports") as HTMLElement;
    expect(importRows(rig)).toEqual([]);
    expect(list.textContent).toContain("import folder");
    teardown(rig);
  });

  test("the drop directory is named, whether or not anything is in it", async () => {
    // The finding this slice was written for: the panel told a writer to put a
    // file in "the import folder" and named no folder, while the archive and
    // mirror sections beside it both named theirs. Asserted on the EMPTY case
    // because that is the one a first run meets.
    const rig = mount({ listImports: () => Promise.resolve([]) });
    await open(rig, "import");
    const where = rig.container.querySelector("#project-import-where") as HTMLElement;
    expect(where.textContent).toContain(IMPORT_DIR);
    teardown(rig);
  });

  test("the directory shown is the one the host reported", async () => {
    // Not composed here. `imports_dir` honours APP_IMPORT_DIR, so a page that
    // built the path from a data home would be right everywhere except where
    // the override is used - which is every rig run.
    const elsewhere = "/tmp/somewhere-else/imports";
    const rig = mount({ listImports: () => Promise.resolve(["book.md"]), importDir: elsewhere });
    await open(rig, "import");
    const where = rig.container.querySelector("#project-import-where") as HTMLElement;
    expect(where.textContent).toContain(elsewhere);
    expect(where.textContent).not.toContain(IMPORT_DIR);
    teardown(rig);
  });

  test("clicking a file imports it", async () => {
    const rig = mount({ listImports: () => Promise.resolve(["book.md"]) });
    await open(rig, "import");
    click(rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement);
    await settle();
    expect(rig.calls.imported).toEqual(["book.md"]);
    teardown(rig);
  });

  test("an import does NOT switch to what it imported", async () => {
    // Same rule as Create, and it is the reason import is safe: bringing a
    // manuscript in never disturbs the one being written.
    const rig = mount({ listImports: () => Promise.resolve(["book.md"]) });
    await open(rig, "import");
    click(rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement);
    await settle();
    expect(rig.calls.switched).toEqual([]);
    teardown(rig);
  });

  test("a completed import repaints both lists", async () => {
    // The new project has to appear in the list above, or the writer has no
    // sign the import happened at all.
    const rig = mount({ listImports: () => Promise.resolve(["book.md"]) });
    await open(rig, "import");
    const listed = rig.calls.list;
    const listedImports = rig.calls.listedImports;
    click(rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement);
    await settle();
    expect(rig.calls.list).toBe(listed + 1);
    expect(rig.calls.listedImports).toBe(listedImports + 1);
    teardown(rig);
  });

  test("a completed import with no losses raises no loss notice", async () => {
    // A Markdown import always reports zero losses, and this is
    // that claim as a page-level test rather than only a host-level one.
    const rig = mount({ listImports: () => Promise.resolve(["book.md"]) });
    await open(rig, "import");
    click(rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement);
    await settle();
    expect(rig.calls.dones).toEqual([]);
    teardown(rig);
  });

  test("an omitted derived contents section is disclosed even without DOCX losses", async () => {
    const rig = mount({
      listImports: () => Promise.resolve(["book.md"]),
      importProject: (filename) => Promise.resolve({
        summary: { path: `/p/${filename}`, name: filename, modified_at: 0 },
        losses: ZERO_LOSSES,
        derived_contents: "My contents",
      }),
    });
    await open(rig, "import");
    click(rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement);
    await settle();
    expect(rig.calls.dones).toEqual([
      'The opening contents list "My contents" was omitted. Exports regenerate it from the outline; the source file is unchanged.',
    ]);
    teardown(rig);
  });

  test("a completed DOCX import with losses names them, in order, on the good-news channel", async () => {
    const rig = mount({
      listImports: () => Promise.resolve(["book.docx"]),
      importProject: (filename) =>
        Promise.resolve({
          summary: { path: `/p/${filename}`, name: filename, modified_at: 0 },
          losses: { ...ZERO_LOSSES, tables: 2, links: 1 },
        }),
    });
    await open(rig, "import");
    click(rig.container.querySelector('[data-import-file="book.docx"]') as HTMLElement);
    await settle();
    expect(rig.calls.dones).toHaveLength(1);
    const notice = rig.calls.dones[0] ?? "";
    // Tables named before links -- the fixed order the plan states -- and a
    // loss this run did NOT have (pictures) is absent from the sentence.
    expect(notice.indexOf("table")).toBeGreaterThanOrEqual(0);
    expect(notice.indexOf("link")).toBeGreaterThan(notice.indexOf("table"));
    expect(notice).not.toContain("picture");
    teardown(rig);
  });

  test("a DOCX import with tracked edits discloses authors and the review source", async () => {
    const rig = mount({
      listImports: () => Promise.resolve(["review.docx"]),
      importProject: (filename) => Promise.resolve({
        summary: { path: `/p/${filename}`, name: filename, modified_at: 0 },
        losses: { ...ZERO_LOSSES, revisions: 2 },
      }),
    });
    await open(rig, "import");
    click(rig.container.querySelector('[data-import-file="review.docx"]') as HTMLElement);
    await settle();
    expect(rig.calls.dones).toHaveLength(1);
    expect(rig.calls.dones[0]).toContain("2 tracked revisions");
    expect(rig.calls.dones[0]).toContain("authors were not retained");
    expect(rig.calls.dones[0]).toContain("Keep the original DOCX for review");
    teardown(rig);
  });

  test("the German revision notice names the missing authors and original DOCX", () => {
    const de = createMessages(DE, "de");
    expect(de.plural("import.loss.revisions", 2)).toBe("2 nachverfolgte Änderungen");
    expect(de.t("import.loss.revisions.warning")).toContain("Verfasser wurden nicht übernommen");
    expect(de.t("import.loss.revisions.warning")).toContain("ursprüngliche DOCX-Datei");
  });

  test("a rejecting import reaches onNotice and repaints nothing", async () => {
    const rig = mount({
      listImports: () => Promise.resolve(["book.md"]),
      importProject: () => Promise.reject(new Error("already exists")),
    });
    await open(rig, "import");
    const listed = rig.calls.list;
    click(rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement);
    await settle();
    expect(rig.calls.notices).toEqual(["already exists"]);
    expect(rig.calls.list).toBe(listed);
    teardown(rig);
  });

  test("a second click while an import is running is ignored", async () => {
    // Not cosmetic: the second call would fail on the name collision and report
    // "already exists", which is an error message about the reader's mouse
    // rather than about their manuscript.
    let release = (): void => {};
    const rig = mount({
      listImports: () => Promise.resolve(["book.md"]),
      importProject: (filename) =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({
              summary: { path: `/p/${filename}`, name: filename, modified_at: 0 },
              losses: ZERO_LOSSES,
            });
        }),
    });
    await open(rig, "import");
    const row = rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement;
    click(row);
    await settle();
    click(row);
    await settle();
    expect(rig.calls.imported).toEqual(["book.md"]);
    release();
    await settle();
    teardown(rig);
  });

  test("a failed listing leaves the section usable rather than empty", async () => {
    const rig = mount({ listImports: () => Promise.reject(new Error("no such directory")) });
    await open(rig, "import");
    expect(rig.calls.notices).toEqual(["no such directory"]);
    const list = rig.container.querySelector("#project-imports") as HTMLElement;
    expect(list.textContent).toContain("import folder");
    teardown(rig);
  });

  test("destroy stops a click from reaching the import handler", async () => {
    const rig = mount({ listImports: () => Promise.resolve(["book.md"]) });
    await open(rig, "import");
    const row = rig.container.querySelector('[data-import-file="book.md"]') as HTMLElement;
    rig.switcher.destroy();
    click(row);
    await settle();
    expect(rig.calls.imported).toEqual([]);
    rig.container.remove();
  });
});

describe("an empty library says so", () => {
  test("a library with no books renders a message, not a blank listbox", async () => {
    // A listbox that paints nothing is indistinguishable from one that failed to
    // paint. The import half of this panel has always carried an empty state;
    // the project half did not, and a screenshot caught the blank gap - every
    // capture runs with the open project outside the library, which is the
    // configuration that reaches this branch.
    const rig = mount({ listProjects: () => Promise.resolve([]) });
    try {
      await open(rig);
      const list = el(rig.container, "project-list") as HTMLElement;
      expect(list.children.length).toBe(1);
      expect(list.textContent ?? "").toBe(t("switcher.empty.open"));
      // Not an option: there is nothing to activate, and a row carrying
      // role=option would be a listbox entry a keyboard user can land on and
      // press Return against for no effect.
      expect(list.querySelectorAll("[role='option']").length).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("the empty message points at the field below it, not above", async () => {
    // The message sits inside the listbox, and the field it sends the writer
    // to is `#project-new-name`, appended AFTER the listbox in the panel. A
    // word pointing "above" would send the writer to nothing; pin the word to
    // the actual document order so a reorder or a reverted wording both fail.
    const rig = mount({ listProjects: () => Promise.resolve([]) });
    try {
      await open(rig);
      const list = el(rig.container, "project-list") as HTMLElement;
      const message = list.children[0] as HTMLElement;
      const input = el(rig.container, "project-new-name") as HTMLElement;
      expect(
        message.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const text = message.textContent ?? "";
      expect(text).toMatch(/below/);
      expect(text).not.toMatch(/above/);
    } finally {
      teardown(rig);
    }
  });

  test("a library with projects renders rows and no message", async () => {
    // The failing direction. Without it the message could be painted every time,
    // above the rows, and the test above would still pass.
    const rig = mount();
    try {
      await open(rig);
      const list = el(rig.container, "project-list") as HTMLElement;
      expect(list.querySelectorAll("[role='listitem']").length).toBeGreaterThan(0);
      expect(list.textContent ?? "").not.toMatch(/No projects in the library yet/);
    } finally {
      teardown(rig);
    }
  });
});

describe("the two listings are cancelled together", () => {
  test("reloadImports rides reload's generation bump, so open() must call reload FIRST", async () => {
    // `reloadImports` reads `generation` without bumping it. That is correct as
    // written and it is ORDER-DEPENDENT in a way a reader could break by
    // swapping two lines in open(). Nothing tested the ordering.
    //
    // A source parse, because the effect of getting it wrong is a stale import
    // listing repainting under a newer one - which needs two overlapping opens
    // with different results to observe, and the panel reloads both lists from
    // the same call.
    const src = await Bun.file("app/ui/src/switcher.ts").text();
    const openBody = src.slice(src.indexOf("    open(focus): void {"));
    const first = openBody.indexOf("const projectsLoaded = reload();");
    const second = openBody.indexOf("        reloadImports(),");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);

    // And the asymmetry itself: exactly one of them bumps.
    const reloadBody = src.slice(src.indexOf("async function reload("), src.indexOf("function renderImports("));
    expect(reloadBody).toContain("++generation");
    const importsBody = src.slice(src.indexOf("async function reloadImports("));
    expect(importsBody.slice(0, 200)).toContain("const mine = generation;");
    expect(importsBody.slice(0, 200)).not.toContain("++generation");
  });
});

describe("restoring from a recovery point", () => {
  const pointRow = (container: HTMLElement, id: string): HTMLElement => {
    const found = container.querySelector(`[data-point-id="${id}"]`);
    if (found === null) throw new Error(`no row for point ${id}`);
    return found as HTMLElement;
  };

  test("opening the panel lists the verified recovery points", async () => {
    const rig = mount({ listRecoveryPoints: () => Promise.resolve(POINTS) });
    await open(rig);
    expect(rig.calls.listedPoints).toBe(1);
    const rows = rig.container.querySelectorAll("[data-point-id]");
    expect(rows.length).toBe(2);
    teardown(rig);
  });

  test("a point row names when it was taken", async () => {
    // Reuses the indicator's `formatWhen` rather than adding a FOURTH copy of
    // the relative-time shape. A row that showed a raw epoch would be a number
    // a writer cannot compare against their own memory of the afternoon.
    const rig = mount({ listRecoveryPoints: () => Promise.resolve(POINTS) });
    await open(rig);
    const row = pointRow(rig.container, POINTS[0]!.id);
    expect(row.textContent).not.toBe("");
    expect(row.textContent).not.toContain(String(POINTS[0]!.mtime_ms));
    teardown(rig);
  });

  test("no recovery points paints an honest empty state", async () => {
    const rig = mount({ listRecoveryPoints: () => Promise.resolve([]) });
    await open(rig);
    const list = el(rig.container, "project-recovery-points");
    expect(list.querySelectorAll("[data-point-id]").length).toBe(0);
    expect(list.textContent).not.toBe("");
    teardown(rig);
  });

  test("a recovery list that cannot be read does not paint the empty state", async () => {
    // `reloadImports`'s recorded defect, not repeated: a catch that renders the
    // designed empty state tells the writer there is nothing there when the
    // truth is that it could not be read, and the confident sentence in the
    // list is the one they act on.
    const empty = mount({ listRecoveryPoints: () => Promise.resolve([]) });
    await open(empty);
    const emptyText = el(empty.container, "project-recovery-points").textContent;
    teardown(empty);

    const rig = mount({ listRecoveryPoints: () => Promise.reject(new Error("cannot read")) });
    await open(rig);
    const list = el(rig.container, "project-recovery-points");
    expect(list.textContent).not.toBe(emptyText);
    expect(rig.calls.notices).toContain("cannot read");
    teardown(rig);
  });

  test("clicking a point restores it", async () => {
    const rig = mount({ listRecoveryPoints: () => Promise.resolve(POINTS) });
    await open(rig);
    click(pointRow(rig.container, POINTS[1]!.id));
    await settle();
    expect(rig.calls.restored).toEqual([POINTS[1]!.id]);
    teardown(rig);
  });

  test("a picture-incomplete point needs a labeled second action", async () => {
    let allowed: boolean | undefined;
    const partial: RecoveryPoint = { ...POINTS[0]!, verified: false, database_verified: true, bundle: true };
    const rig = mount({
      listRecoveryPoints: () => Promise.resolve([partial]),
      restorePoint: async (_id, allowPictureGaps) => {
        allowed = allowPictureGaps;
        return { path: "/p/partial.db", name: "Partial", modified_at: 1 };
      },
    });
    await open(rig);
    const row = pointRow(rig.container, partial.id);
    click(row);
    await settle();
    expect(rig.calls.restored).toEqual([]);
    expect(rig.calls.notices.some((message) => message.includes("pictures"))).toBe(true);
    const confirm = row.querySelector("[data-restore-with-gaps]");
    expect(confirm).not.toBeNull();
    click(confirm as HTMLElement);
    await settle();
    expect(rig.calls.restored).toEqual([partial.id]);
    expect(allowed).toBe(true);
    expect(rig.calls.dones.some((message) => message.includes("missing"))).toBe(true);
    teardown(rig);
  });

  test("a completed restore is news, not a problem", async () => {
    // Restoring is not a failure of anything - it is the outcome the writer
    // asked for - so it goes through onDone, the channel the other ten units
    // use for their own successes, and never through onNotice.
    const rig = mount({ listRecoveryPoints: () => Promise.resolve(POINTS) });
    await open(rig);
    click(pointRow(rig.container, POINTS[0]!.id));
    await settle();
    expect(rig.calls.dones.some((d) => d.includes("One (recovered)"))).toBe(true);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("a restore does NOT switch to the restored project", async () => {
    // The design's central refusal reaching the page: the writer is comparing
    // two states of a book, and moving them off the one they are looking at is
    // the application making the choice it exists to refuse.
    const rig = mount({ listRecoveryPoints: () => Promise.resolve(POINTS) });
    await open(rig);
    click(pointRow(rig.container, POINTS[0]!.id));
    await settle();
    expect(rig.calls.switched).toEqual([]);
    teardown(rig);
  });

  test("a completed restore repaints the project list", async () => {
    const rig = mount({ listRecoveryPoints: () => Promise.resolve(POINTS) });
    await open(rig);
    const before = rig.calls.list;
    click(pointRow(rig.container, POINTS[0]!.id));
    await settle();
    expect(rig.calls.list).toBe(before + 1);
    teardown(rig);
  });

  test("a failed restore reports through the notice channel", async () => {
    const rig = mount({
      listRecoveryPoints: () => Promise.resolve(POINTS),
      restorePoint: () => Promise.reject(new Error("no space left on device")),
    });
    await open(rig);
    click(pointRow(rig.container, POINTS[0]!.id));
    await settle();
    expect(rig.calls.notices).toContain("no space left on device");
    expect(rig.calls.dones).toEqual([]);
    teardown(rig);
  });

  test("a second click while a restore is in flight is ignored", async () => {
    // Every click would otherwise produce another copy of the same manuscript,
    // and the writer is trying to end up with two books, not five.
    let release = (): void => {};
    const rig = mount({
      listRecoveryPoints: () => Promise.resolve(POINTS),
      restorePoint: () =>
        new Promise((resolve) => {
          release = () => resolve({ path: "/p/x.mss", name: "x", modified_at: 1 });
        }),
    });
    await open(rig);
    const row = pointRow(rig.container, POINTS[0]!.id);
    click(row);
    await settle();
    click(row);
    await settle();
    expect(rig.calls.restored).toEqual([POINTS[0]!.id]);
    release();
    await settle();
    teardown(rig);
  });
});

describe("unresolved legacy folders", () => {
  test("warns about preserved folders once until the book changes", async () => {
    const rig = mount({ legacyProtection: () => Promise.resolve(LEGACY_PROTECTION) });
    await open(rig);
    expect(rig.calls.notices.filter((message) => message.includes("could not be linked"))).toHaveLength(1);
    await open(rig);
    expect(rig.calls.notices.filter((message) => message.includes("could not be linked"))).toHaveLength(1);
    rig.switcher.refresh("Another book");
    await settle();
    expect(rig.calls.notices.filter((message) => message.includes("could not be linked"))).toHaveLength(2);
    teardown(rig);
  });

  test("opening lists each unresolved folder in its matching section", async () => {
    const rig = mount({ legacyProtection: () => Promise.resolve(LEGACY_PROTECTION) });
    await open(rig);
    expect(rig.calls.listedLegacy).toBe(1);
    expect(el(rig.container, "project-legacy-recovery").textContent).toContain(
      "/legacy/recovery/one",
    );
    expect(el(rig.container, "project-legacy-mirror").textContent).toContain(
      "/legacy/mirror/one",
    );
    teardown(rig);
  });

  test("an older legacy response cannot overwrite a newer one", async () => {
    let releaseFirst: (items: LegacyProtection[]) => void = () => {};
    let releaseSecond: (items: LegacyProtection[]) => void = () => {};
    let reads = 0;
    const rig = mount({
      legacyProtection: () =>
        new Promise((resolve) => {
          if (reads++ === 0) releaseFirst = resolve;
          else releaseSecond = resolve;
        }),
    });
    rig.switcher.open("list");
    rig.switcher.open("list");
    releaseSecond([{ surface: "recovery", dir: "/legacy/newer" }]);
    await settle();
    releaseFirst([{ surface: "recovery", dir: "/legacy/older" }]);
    await settle();
    const recovery = el(rig.container, "project-legacy-recovery").textContent ?? "";
    expect(recovery).toContain("/legacy/newer");
    expect(recovery).not.toContain("/legacy/older");
    teardown(rig);
  });

  test("refresh does not cancel an in-flight project list", async () => {
    let release: (items: ProjectSummary[]) => void = () => {};
    const pending = new Promise<ProjectSummary[]>((resolve) => {
      release = resolve;
    });
    const rig = mount({ listProjects: () => pending });
    rig.switcher.open("list");
    rig.switcher.refresh("Renamed");
    release(PROJECTS);
    await settle();
    expect(rig.container.querySelectorAll("[data-project-path]").length).toBe(PROJECTS.length);
    teardown(rig);
  });

  test("a new book or failed read clears stale unresolved folders", async () => {
    let fail = false;
    const rig = mount({
      legacyProtection: () =>
        fail ? Promise.reject(new Error("cannot read protection registry")) : Promise.resolve(LEGACY_PROTECTION),
    });
    await open(rig);
    rig.switcher.setBookOpen(false);
    expect((el(rig.container, "project-legacy-recovery") as HTMLElement).hidden).toBe(true);
    expect((el(rig.container, "project-legacy-mirror") as HTMLElement).hidden).toBe(true);
    rig.switcher.setBookOpen(true);
    fail = true;
    rig.switcher.refresh("New book");
    await settle();
    expect((el(rig.container, "project-legacy-recovery") as HTMLElement).hidden).toBe(true);
    expect((el(rig.container, "project-legacy-mirror") as HTMLElement).hidden).toBe(true);
    expect(rig.calls.notices).toContain("cannot read protection registry");
    teardown(rig);
  });
});

describe("the copy that leaves this computer", () => {
  test("a chosen backup folder is remembered and cancelling leaves it unchanged", async () => {
    let destination = "/backups/writing";
    let next: string | null = "/drive/books";
    const rig = mount({
      encryptedBackupDestination: async () => destination,
      chooseEncryptedBackupDestination: async () => {
        if (next !== null) destination = next;
        return next;
      },
    });
    await open(rig);
    expect(el(rig.container, "project-backup-destination").textContent).toContain("/backups/writing");
    click(el(rig.container, "project-backup-destination-choose"));
    await settle();
    expect(el(rig.container, "project-backup-destination").textContent).toContain("/drive/books");
    next = null;
    click(el(rig.container, "project-backup-destination-choose"));
    await settle();
    expect(el(rig.container, "project-backup-destination").textContent).toContain("/drive/books");
    expect(rig.calls.dones).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    expect(el(rig.container, "project-backup-destination-note").textContent).toContain("not automatic");
    teardown(rig);
  });

  test("backup explanations stay behind accessible help marks", async () => {
    const rig = mount({ encryptedBackupDestination: async () => null });
    await open(rig);
    const note = el(rig.container, "project-encrypted-archive-note");
    const help = el(rig.container, "project-encrypted-archive-note-help");
    expect(note.hidden).toBe(true);
    expect(help.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.textContent).toContain("Keep your working book outside cloud folders");
    help.dispatchEvent(new Event("mouseenter"));
    expect(help.parentElement?.querySelector(".tip")?.textContent).toContain("recovery key");
    help.dispatchEvent(new Event("mouseleave"));
    expect(help.parentElement?.querySelector(".tip")).toBeNull();
    help.dispatchEvent(new Event("focus"));
    expect(help.parentElement?.querySelector(".tip")).not.toBeNull();
    help.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(help.parentElement?.querySelector(".tip")).toBeNull();
    teardown(rig);
  });

  test("an older folder read cannot overwrite the newly chosen destination", async () => {
    let release: ((dir: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const rig = mount({
      encryptedBackupDestination: () => pending,
      chooseEncryptedBackupDestination: async () => "/drive/new",
    });
    await open(rig);
    click(el(rig.container, "project-backup-destination-choose"));
    await settle();
    release?.("/drive/old");
    await settle();
    expect(el(rig.container, "project-backup-destination").textContent).toContain("/drive/new");
    teardown(rig);
  });

  test("an old folder read cannot repaint after its delayed privacy check", async () => {
    let release: (() => void) | undefined;
    let checks = 0;
    const pending = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const rig = mount({
      encryptedBackupDestination: async () => "/drive/old",
      chooseEncryptedBackupDestination: async () => "/drive/new",
      canReportArchive: () => ++checks === 1 ? pending : Promise.resolve(true),
    });
    await open(rig);
    click(el(rig.container, "project-backup-destination-choose"));
    await settle();
    release?.();
    await settle();
    expect(el(rig.container, "project-backup-destination").textContent).toContain("/drive/new");
    teardown(rig);
  });

  test("choosing a backup folder blocks other encrypted actions until the picker returns", async () => {
    let release: ((dir: null) => void) | undefined;
    const pending = new Promise<null>((resolve) => { release = resolve; });
    let picks = 0;
    const rig = mount({
      encryptedBackupDestination: async () => null,
      chooseEncryptedBackupDestination: () => { picks++; return pending; },
      makeEncryptedArchive: async () => { throw new Error("must wait for the picker"); },
    });
    await open(rig);
    click(el(rig.container, "project-backup-destination-choose"));
    click(el(rig.container, "project-backup-destination-choose"));
    expect(picks).toBe(1);
    expect((el(rig.container, "project-archive-encrypted") as HTMLButtonElement).disabled).toBe(true);
    release?.(null);
    await settle();
    await settle();
    expect((el(rig.container, "project-archive-encrypted") as HTMLButtonElement).disabled).toBe(false);
    expect(el(rig.container, "project-backup-destination").textContent).toContain("No backup folder chosen");
    teardown(rig);
  });

  test("folder failures are reported and late picker results stay hidden after a reopen", async () => {
    let release: ((dir: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    let opening = 1;
    const rig = mount({
      encryptedBackupDestination: async () => { throw new Error("folder unavailable"); },
      chooseEncryptedBackupDestination: () => pending,
      currentGeneration: () => opening,
    });
    await open(rig);
    expect(el(rig.container, "project-backup-destination").textContent).toContain("could not be read");
    expect(rig.calls.notices).toContain("folder unavailable");
    click(el(rig.container, "project-backup-destination-choose"));
    opening = 2;
    release?.("/private/late");
    await settle();
    expect(el(rig.container, "project-backup-destination").textContent).not.toContain("/private/late");
    teardown(rig);
  });

  test("encrypted file actions stay separate from ordinary folder archives", async () => {
    const calls: string[] = [];
    const rig = mount({
      generateArchiveKey: async () => { calls.push("key"); return { recipient: "age1public" }; },
      makeEncryptedArchive: async () => { calls.push("create"); return { file: "portable.age", recipient: "age1public", encrypted: true }; },
      verifyEncryptedArchive: async () => { calls.push("verify"); return { file: "portable.age", encrypted: true }; },
      restoreEncryptedArchive: async () => { calls.push("restore"); return { path: "/p/restored.db", name: "Restored", modified_at: 1 }; },
    });
    await open(rig);
    const note = el(rig.container, "project-encrypted-archive-note").textContent ?? "";
    expect(note).toContain("protected copy of your whole book");
    expect(note).toContain("spare copy separately");
    expect(el(rig.container, "project-archive-note").textContent).toContain("whole folder");
    const beforeShelf = rig.calls.list;
    for (const id of ["project-archive-key", "project-archive-encrypted", "project-archive-encrypted-verify", "project-archive-encrypted-restore"]) {
      click(el(rig.container, id));
      await settle();
    }
    expect(calls).toEqual(["key", "create", "verify", "restore"]);
    expect(rig.calls.archived).toBe(0);
    expect(rig.calls.dones.some((s) => s.includes("portable.age"))).toBe(true);
    expect(rig.calls.dones.some((s) => s.includes("Restored"))).toBe(true);
    expect(rig.calls.list).toBeGreaterThan(beforeShelf);
    teardown(rig);
  });

  test("a completed encrypted file is not announced after the same path reopens or privacy locks", async () => {
    let release: ((result: { file: string; recipient: string; encrypted: true }) => void) | undefined;
    const pending = new Promise<{ file: string; recipient: string; encrypted: true }>((resolve) => { release = resolve; });
    let opening = 1;
    let reportable = true;
    const rig = mount({
      makeEncryptedArchive: () => pending,
      currentGeneration: () => opening,
      canReportArchive: async () => reportable,
    });
    await open(rig);
    click(el(rig.container, "project-archive-encrypted"));
    await settle();
    opening = 2;
    release?.({ file: "already-written.age", recipient: "age1public", encrypted: true });
    await settle();
    expect(rig.calls.dones).toEqual([]);
    expect(rig.calls.notices).toEqual([]);

    reportable = false;
    click(el(rig.container, "project-archive-encrypted"));
    await settle();
    expect(rig.calls.dones).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("destroyed switcher ignores a late encrypted restore result", async () => {
    let release: ((project: ProjectSummary) => void) | undefined;
    const pending = new Promise<ProjectSummary>((resolve) => { release = resolve; });
    const rig = mount({ restoreEncryptedArchive: () => pending });
    await open(rig);
    const beforeShelf = rig.calls.list;
    click(el(rig.container, "project-archive-encrypted-restore"));
    teardown(rig);
    release?.({ path: "/p/restored.db", name: "Restored", modified_at: 1 });
    await settle();
    expect(rig.calls.dones).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    expect(rig.calls.list).toBe(beforeShelf);
  });
  test("the section is its own, after the recovery one and never folded into it", async () => {
    // The maintenance note, made structural: a panel with one "Recovery"
    // heading covering same-device recovery AND device-loss protection is the
    // design's forbidden blur with a different shape. Two headings, two notes,
    // two lists, in that order -- device loss LAST because it is the only one
    // whose next step happens outside this application.
    const rig = mount();
    await open(rig);
    // Inside Backups and archives.
    const body = el(rig.container, "project-copies");
    const ids = [...body.children].map((c) => c.id).filter((id) => id !== "");
    expect(ids).toContain("project-archive-heading");
    expect(ids.indexOf("project-archive-heading")).toBeGreaterThan(
      ids.indexOf("project-recovery-points"),
    );
    // The two headings are DIFFERENT SENTENCES about different files.
    expect(el(rig.container, "project-archive-heading").textContent).not.toBe(
      el(rig.container, "project-recovery-heading").textContent,
    );
    teardown(rig);
  });

  test("the note says the writer must move the file, in the design's words", async () => {
    // Design :362-368. The surface that offers this must say "move this file
    // off this computer yourself" in those words, and must not imply the
    // application already did it.
    const rig = mount();
    await open(rig);
    const note = el(rig.container, "project-archive-note").textContent ?? "";
    expect(note.toLowerCase()).toContain("move the whole folder off this computer yourself");
    teardown(rig);
  });

  test("the panel says WHERE, because the writer's next act is in a file manager", async () => {
    const rig = mount();
    await open(rig);
    expect(el(rig.container, "project-archive-where").textContent).toContain(ARCHIVE_DIR);
    teardown(rig);
  });

  test("opening the panel lists the verified archives by file name", async () => {
    // BY FILE NAME, not by date alone: the writer is about to look for this
    // file in a directory listing, and a row that named only a time would not
    // tell them which of five files to drag.
    const rig = mount({ listArchives: () => Promise.resolve(ARCHIVES) });
    await open(rig);
    expect(rig.calls.listedArchives).toBe(1);
    const rows = rig.container.querySelectorAll("[data-archive-file]");
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain(ARCHIVES[0]!.file);
    teardown(rig);
  });

  test("no archive paints an honest empty state", async () => {
    const rig = mount({ listArchives: () => Promise.resolve([]) });
    await open(rig);
    const list = el(rig.container, "project-archives");
    expect(list.querySelectorAll("[data-archive-file]").length).toBe(0);
    expect(list.textContent).not.toBe("");
    teardown(rig);
  });

  test("an archive list that cannot be read does not paint the empty state", async () => {
    // The recorded `reloadImports` defect, not repeated: an empty state over a
    // directory that merely could not be read tells a writer looking for their
    // last copy that no copy exists.
    const rig = mount({ listArchives: () => Promise.reject(new Error("permission denied")) });
    await open(rig);
    const list = el(rig.container, "project-archives");
    expect(list.textContent).not.toContain("No archive has been made yet");
    expect(rig.calls.notices.some((n) => n.includes("permission denied"))).toBe(true);
    teardown(rig);
  });

  test("the mirror is OFF by default and the panel says where it would go", async () => {
    // OFF is the DEFAULT, not an error and not an empty state. And the
    // destination is shown BEFORE the writer agrees to anything: it is the
    // design's stated reason for making enabling deliberate, because it is what
    // catches a mirror landing in a synced or cloud folder.
    const rig = mount();
    await open(rig);
    expect(el(rig.container, "project-mirror-state").textContent).toContain(
      "The mirror is off",
    );
    expect(el(rig.container, "project-mirror-where").textContent).toContain(
      "/data/mirror/one",
    );
    expect(el(rig.container, "project-mirror-toggle").textContent).toBe(
      "Turn the mirror on",
    );
    teardown(rig);
  });

  test("the thorough check is a real button, enabled only for a built mirror", async () => {
    const off = mount();
    await open(off);
    expect((el(off.container, "mirror-check") as HTMLButtonElement).disabled).toBe(true);
    teardown(off);

    const unbuilt = mount({ mirrorStatus: () => Promise.resolve({ ...MIRROR_ON, generated_at: null }) });
    await open(unbuilt);
    expect((el(unbuilt.container, "mirror-check") as HTMLButtonElement).disabled).toBe(true);
    teardown(unbuilt);

    const built = mount({ mirrorStatus: () => Promise.resolve(MIRROR_ON) });
    await open(built);
    const check = el(built.container, "mirror-check") as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    expect(check.textContent).toBe("Check the mirror thoroughly");
    teardown(built);
  });

  test("a completed thorough check reports changed and missing files through the done channel", async () => {
    const rig = mount({
      mirrorStatus: () => Promise.resolve(MIRROR_ON),
      checkMirror: () => Promise.resolve({ entries: 11, hashed: 10, changed: 2, deleted: 1 }),
    });
    await open(rig);
    click(el(rig.container, "mirror-check"));
    await settle();
    expect(rig.calls.checked).toBe(1);
    expect(rig.calls.notices).toEqual([]);
    expect(rig.calls.dones).toEqual([
      "Checked 11 mirror files. Changed: 2. Missing: 1.",
    ]);
    teardown(rig);
  });

  test("a thorough-check failure stays generic and releases its latch", async () => {
    let fail = true;
    const rig = mount({
      mirrorStatus: () => Promise.resolve(MIRROR_ON),
      checkMirror: () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("/private/mirror/scene.md is unreadable"));
        }
        return Promise.resolve({ entries: 3, hashed: 3, changed: 0, deleted: 0 });
      },
    });
    await open(rig);
    const check = el(rig.container, "mirror-check");
    click(check);
    await settle();
    expect(rig.calls.notices).toEqual(["Could not check the mirror thoroughly."]);
    expect(rig.calls.notices.join(" ")).not.toContain("/private/");
    expect((check as HTMLButtonElement).disabled).toBe(false);
    expect(check.textContent).toBe("Check the mirror thoroughly");
    click(check);
    await settle();
    expect(rig.calls.checked).toBe(2);
    teardown(rig);
  });

  test("check, toggle, and a reload cannot overlap while a thorough check runs", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<{ entries: number; hashed: number; changed: number; deleted: number }>((resolve) => {
      release = () => resolve({ entries: 3, hashed: 3, changed: 0, deleted: 0 });
    });
    const rig = mount({ mirrorStatus: () => Promise.resolve(MIRROR_ON), checkMirror: () => pending });
    await open(rig);
    const check = el(rig.container, "mirror-check");
    const toggle = el(rig.container, "project-mirror-toggle");

    click(check);
    await settle();
    // A panel reload resolving while the check is pending must preserve the
    // shared latch; otherwise it re-enables a second write mid-check.
    rig.switcher.open("list");
    await settle();
    expect((check as HTMLButtonElement).disabled).toBe(true);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(check.textContent).toBe("Checking the mirror thoroughly…");
    click(check);
    click(toggle);
    await settle();
    expect(rig.calls.checked).toBe(1);
    expect(rig.calls.mirrored).toEqual([]);

    release?.();
    await settle();
    expect((check as HTMLButtonElement).disabled).toBe(false);
    click(toggle);
    await settle();
    expect(rig.calls.mirrored).toEqual([false]);
    teardown(rig);
  });

  test("turning the mirror on asks the host exactly once and names the directory", async () => {
    const rig = mount();
    await open(rig);
    click(el(rig.container, "project-mirror-toggle"));
    await settle();
    expect(rig.calls.mirrored).toEqual([]);
    expect(rig.calls.mirrorPreviews).toBe(1);
    const preview = el(rig.container, "project-mirror-preview");
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain("/data/mirror/one");
    click(preview.querySelectorAll("button")[0] as HTMLElement);
    await settle();
    // The ARGUMENT, not a count: a toggle that sent `true` twice would rewrite
    // the whole manuscript twice.
    expect(rig.calls.mirrored).toEqual([true]);
    expect(rig.calls.mirrorTokens).toEqual(["preview-token"]);
    expect(rig.calls.dones.some((d) => d.includes("/data/mirror/one"))).toBe(true);
    expect(rig.calls.notices).toEqual([]);
    expect(el(rig.container, "project-mirror-toggle").textContent).toBe(
      "Turn the mirror off",
    );
    teardown(rig);
  });

  test("canceling the plaintext preview never enables or writes the mirror", async () => {
    const rig = mount({ previewMirror: () => Promise.resolve({
      ...MIRROR_PREVIEW,
      findings: [{ surface: "document_body", item_id: "0001-Scene.md", matched: "Other Name" }],
    }) });
    await open(rig);
    click(el(rig.container, "project-mirror-toggle"));
    await settle();
    const preview = el(rig.container, "project-mirror-preview");
    expect(document.activeElement).toBe(preview);
    expect(preview.textContent).toContain("Other Name in 0001-Scene.md");
    expect(preview.textContent).toContain("plaintext");
    click(preview.querySelectorAll("button")[1] as HTMLElement);
    await settle();
    expect(preview.hidden).toBe(true);
    expect(rig.calls.mirrored).toEqual([]);
    expect(rig.calls.dones).toEqual([]);
    teardown(rig);
  });

  test("a preview returned after the book changes cannot offer confirmation", async () => {
    let release: ((preview: MirrorPreview) => void) | undefined;
    const pending = new Promise<MirrorPreview>((resolve) => { release = resolve; });
    const rig = mount({ previewMirror: () => pending });
    await open(rig);
    click(el(rig.container, "project-mirror-toggle"));
    rig.switcher.refresh("Different book");
    release?.(MIRROR_PREVIEW);
    await settle();
    expect(el(rig.container, "project-mirror-preview").hidden).toBe(true);
    expect(rig.calls.mirrored).toEqual([]);
    teardown(rig);
  });

  test("turning the mirror off says the files are still there", async () => {
    // Disabling LEAVES THE FILES -- they are the writer's manuscript in their
    // own folder. A writer who expects them gone would otherwise not know, and
    // this is the only place the page can say so.
    const on: MirrorReport = { ...MIRROR_OFF, enabled: true, files: 3, generated_at: 5_000 };
    const rig = mount({
      mirrorStatus: () => Promise.resolve(on),
      enableMirror: (want) =>
        Promise.resolve(want ? on : { ...on, enabled: false }),
    });
    await open(rig);
    expect(el(rig.container, "project-mirror-toggle").textContent).toBe(
      "Turn the mirror off",
    );
    click(el(rig.container, "project-mirror-toggle"));
    await settle();
    expect(rig.calls.mirrored).toEqual([false]);
    expect(
      rig.calls.dones.some((d) => d.includes("still in") && d.includes("/data/mirror/one")),
    ).toBe(true);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("a mirror status that cannot be read is never painted as OFF", async () => {
    // The `reloadImports` defect once more, and it is worse here than in the
    // lists: a writer told the mirror is off may go and turn it on, which
    // rewrites the whole book to a directory the page just failed to read.
    const rig = mount({ mirrorStatus: () => Promise.reject(new Error("permission denied")) });
    await open(rig);
    const state = el(rig.container, "project-mirror-state");
    expect(state.textContent).not.toContain("The mirror is off");
    expect(state.textContent).toContain("could not be read");
    expect(rig.calls.notices.some((n) => n.includes("permission denied"))).toBe(true);
    teardown(rig);
  });

  test("a second toggle click while the first is in flight does nothing", async () => {
    // ONE deferred handed to EVERY caller, for the archive latch's reason: a
    // fake building a fresh promise per call could not test contention at all.
    // Two passes writing the same files at once is the failure here.
    let release: (() => void) | undefined;
    const pending = new Promise<MirrorReport>((resolve) => {
      release = () => resolve({ ...MIRROR_OFF, enabled: true });
    });
    const rig = mount({ enableMirror: () => pending });
    await open(rig);

    click(el(rig.container, "project-mirror-toggle"));
    await settle();
    click(el(rig.container, "project-mirror-preview").querySelectorAll("button")[0] as HTMLElement);
    await settle();
    expect((el(rig.container, "project-mirror-preview").querySelectorAll("button")[1] as HTMLButtonElement).disabled).toBe(true);
    click(el(rig.container, "project-mirror-toggle"));
    await settle();

    expect(rig.calls.mirrored).toEqual([true]);
    release?.();
    await settle();
    teardown(rig);
  });

  test("the action writes one archive and repaints the list", async () => {
    const rig = mount({ listArchives: () => Promise.resolve(ARCHIVES) });
    await open(rig);
    const before = rig.calls.listedArchives;
    click(el(rig.container, "project-archive-now"));
    await settle();
    expect(rig.calls.archived).toBe(1);
    expect(rig.calls.listedArchives).toBeGreaterThan(before);
    expect(rig.calls.dones.some((d) => d.includes(ARCHIVES[0]!.file))).toBe(true);
    expect(rig.calls.notices).toEqual([]);
    teardown(rig);
  });

  test("a second click while the first is still writing does nothing", async () => {
    // ONE deferred handed to EVERY caller, and an assertion on the call COUNT.
    // A fake that built a fresh promise per call could not test contention at
    // all: the second call would overwrite the first's resolver and the
    // assertion would hold with the latch deleted outright.
    let release: (() => void) | undefined;
    const pending = new Promise<Archive>((resolve) => {
      release = () => resolve(ARCHIVES[0]!);
    });
    const rig = mount({ makeArchive: () => pending });
    await open(rig);

    click(el(rig.container, "project-archive-now"));
    await settle();
    click(el(rig.container, "project-archive-now"));
    await settle();

    expect(rig.calls.archived).toBe(1);
    release?.();
    await settle();
    // And the latch releases: a third click after the first finished works.
    click(el(rig.container, "project-archive-now"));
    await settle();
    expect(rig.calls.archived).toBe(2);
    teardown(rig);
  });

  test("a failed archive is reported and never leaves the button stuck", async () => {
    const rig = mount({ makeArchive: () => Promise.reject(new Error("disk full")) });
    await open(rig);
    click(el(rig.container, "project-archive-now"));
    await settle();
    expect(rig.calls.notices.some((n) => n.includes("disk full"))).toBe(true);
    expect(rig.calls.dones).toEqual([]);
    click(el(rig.container, "project-archive-now"));
    await settle();
    expect(rig.calls.archived).toBe(2);
    teardown(rig);
  });

  test("a listing that resolves after the panel was reopened does not repaint", async () => {
    // `reloadArchives` reads `generation` WITHOUT bumping it, riding
    // `reload()`'s bump so every listing in the panel is cancelled together.
    // Swap that and a stale archive listing paints over a fresh one.
    let release: (() => void) | undefined;
    const stale = new Promise<Archive[]>((resolve) => {
      release = () => resolve(ARCHIVES);
    });
    let first = true;
    const rig = mount({
      listArchives: () => {
        if (first) {
          first = false;
          return stale;
        }
        return Promise.resolve([]);
      },
    });
    rig.switcher.open("list");
    await open(rig);

    release?.();
    await settle();

    expect(rig.container.querySelectorAll("[data-archive-file]").length).toBe(0);
    teardown(rig);
  });
});

describe("the book's name in the sidebar", () => {
  const header = (rig: Rig): HTMLElement =>
    document.getElementById("nav-header") as HTMLElement;

  test("the name is painted into the header, not into the bar container", () => {
    // It MOVED here. Two copies of a manuscript's title on one screen is
    // the option not chosen, and the strip's width is scarce.
    const rig = mount({ currentName: () => "The Harbour" });
    expect(header(rig).textContent).toContain("The Harbour");
    expect(rig.container.querySelector("#project-name")).toBeNull();
    teardown(rig);
  });

  test("clicking the name opens a field carrying it", () => {
    const rig = mount({ currentName: () => "The Harbour" });
    (document.getElementById("project-name-label") as HTMLElement).click();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    expect(field).not.toBeNull();
    expect(field.hidden).toBe(false);
    expect(field.value).toBe("The Harbour");
    expect(document.activeElement).toBe(field);
    teardown(rig);
  });

  test("the field is focused BEFORE the label is hidden", () => {
    // Hiding a focused element drops the focus it is holding, and this button
    // has just been clicked. Showing and focusing the field first leaves no
    // window in which focus is on nothing.
    //
    // Observed through `focus` itself rather than by reading the source, which
    // is the recorded trap: a guard that searches for a word survives its own
    // mutation.
    const rig = mount({ currentName: () => "The Harbour" });
    const label = document.getElementById("project-name-label") as HTMLElement;
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    // Typed as the union rather than initialised to `false`, so a `focus` that
    // is never called fails LOUDLY instead of passing on the initial value --
    // which is how this assertion would silently stop testing anything.
    let labelHiddenAtFocus = "focus was never called";
    const realFocus = field.focus.bind(field);
    field.focus = () => {
      labelHiddenAtFocus = label.hidden ? "hidden" : "still visible";
      realFocus();
    };
    label.click();
    expect(labelHiddenAtFocus).toBe("still visible");
    // And it IS hidden once the act is over, or the title would be on screen
    // twice.
    expect(label.hidden).toBe(true);
    teardown(rig);
  });

  test("Enter commits and repaints from what the host STORED", async () => {
    // Not from the field. They differ by the trim, and a header painted from the
    // input is the page answering a question the host just answered.
    const rig = mount({
      currentName: () => "default",
      renameProject: () => Promise.resolve({ path: "/p/x", name: "Stored", modified_at: 0 }),
    });
    (document.getElementById("project-name-label") as HTMLElement).click();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    field.value = "  Typed  ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(rig.calls.renamed).toEqual(["Typed"]);
    expect(header(rig).textContent).toContain("Stored");
    expect(field.hidden).toBe(true);
    teardown(rig);
  });

  test("Escape cancels, sends nothing, and restores the label", () => {
    const rig = mount({ currentName: () => "The Harbour" });
    (document.getElementById("project-name-label") as HTMLElement).click();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    field.value = "Something else";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(rig.calls.renamed).toEqual([]);
    expect(field.hidden).toBe(true);
    // The PREVIOUS label, not an empty one: a cancelled rename changed nothing
    // and a header that went blank would read as a title that had been erased.
    expect(header(rig).textContent).toContain("The Harbour");
    teardown(rig);
  });

  test("a blank name is refused and never reaches the host", () => {
    const rig = mount({ currentName: () => "The Harbour" });
    (document.getElementById("project-name-label") as HTMLElement).click();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    field.value = "   ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(rig.calls.renamed).toEqual([]);
    // The field STAYS OPEN. Closing it on a refusal would look like a rename
    // that worked and silently did nothing.
    expect(field.hidden).toBe(false);
    teardown(rig);
  });

  test("a rename the host refuses leaves the header alone", async () => {
    // A header showing the new name over a store holding the old one is the one
    // outcome a writer cannot detect.
    const rig = mount({
      currentName: () => "The Harbour",
      renameProject: () => Promise.reject(new Error("cannot record the project name")),
    });
    (document.getElementById("project-name-label") as HTMLElement).click();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    field.value = "Nope";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(rig.calls.notices).toEqual(["cannot record the project name"]);
    expect(header(rig).textContent).toContain("The Harbour");
    teardown(rig);
  });

  test("beginRename() is the same act, reached from the menu", () => {
    // File > Rename project... and a click on the name are ONE implementation.
    const rig = mount({ currentName: () => "The Harbour" });
    rig.switcher.beginRename();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    expect(field.hidden).toBe(false);
    expect(field.value).toBe("The Harbour");
    expect(document.activeElement).toBe(field);
    teardown(rig);
  });

  test("refresh() repaints the header on a project switch", () => {
    const rig = mount({ currentName: () => "One" });
    rig.switcher.refresh("Two");
    expect(header(rig).textContent).toContain("Two");
    teardown(rig);
  });
});

describe("the cast button in the header", () => {
  const cast = (): HTMLButtonElement =>
    document.getElementById("nav-cast") as HTMLButtonElement;

  test("it is labelled, and clicking it runs the dep", () => {
    const rig = mount();
    expect(cast()).not.toBeNull();
    expect(cast().getAttribute("aria-label")).toBe("Cast");
    cast().click();
    expect(rig.calls.openCast).toBe(1);
    teardown(rig);
  });

  test("a project switch leaves exactly one cast button in the header", () => {
    // The recorded shape `name.remove()` documents: an element this unit owns
    // OUTSIDE its own container is not cleared by whoever owns that container,
    // so a teardown that forgot it would leave the previous manuscript's
    // button beside the new one's.
    const first = mount();
    teardown(first);
    const second = mount();
    expect(document.querySelectorAll("#nav-cast").length).toBe(1);
    teardown(second);
  });
});

describe("setBookOpen (099, review fixup)", () => {
  // createSwitcher builds the rename button, its field and the cast button
  // into #nav-header unconditionally, before main.ts knows whether a book is
  // open. At the empty boot they would otherwise sit beside
  // `library.no-book`'s sentence naming a leftover project and offering a
  // Cast panel with nothing in it -- both routes into a command that only
  // answers "no project is open".
  test("false hides the name button and the cast button", () => {
    const rig = mount({ currentName: () => "The Harbour" });
    rig.switcher.setBookOpen(false);
    expect((document.getElementById("project-name-label") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("nav-cast") as HTMLElement).hidden).toBe(true);
    teardown(rig);
  });

  test("true restores both", () => {
    const rig = mount({ currentName: () => "The Harbour" });
    rig.switcher.setBookOpen(false);
    rig.switcher.setBookOpen(true);
    expect((document.getElementById("project-name-label") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("nav-cast") as HTMLElement).hidden).toBe(false);
    teardown(rig);
  });

  test("false cancels a rename in progress rather than leaving the field open over a hidden label", () => {
    const rig = mount({ currentName: () => "The Harbour" });
    (document.getElementById("project-name-label") as HTMLElement).click();
    const field = document.getElementById("project-name-field") as HTMLInputElement;
    expect(field.hidden).toBe(false);
    rig.switcher.setBookOpen(false);
    expect(field.hidden).toBe(true);
    expect((document.getElementById("project-name-label") as HTMLElement).hidden).toBe(true);
    teardown(rig);
  });
});


for (const fails of [false, true]) {
  test(`a check completing after a book switch does not announce the old book (${fails ? "failure" : "success"})`, async () => {
    let path = "/p/one.mss";
    let finish = (): void => { throw new Error("check has not started"); };
    const rig = mount({
      currentPath: () => path,
      mirrorStatus: () => Promise.resolve(MIRROR_ON),
      checkMirror: () => new Promise((resolve, reject) => {
        finish = () => fails ? reject(new Error("old book failed"))
          : resolve({ entries: 3, hashed: 3, changed: 0, deleted: 0 });
      }),
    });
    await open(rig);
    click(el(rig.container, "mirror-check"));
    path = "/p/two.mss";
    finish();
    await settle();
    expect(rig.calls.dones).toEqual([]);
    expect(rig.calls.notices).toEqual([]);
    expect((el(rig.container, "mirror-check") as HTMLButtonElement).disabled).toBe(false);
    expect((el(rig.container, "project-mirror-toggle") as HTMLButtonElement).disabled).toBe(false);
    teardown(rig);
  });
}

describe("progressive disclosure in the project panel", () => {
  test("folderName takes the last folder, for a file or a folder, on either separator", () => {
    expect(folderName("/home/w/Books/Novel.mss", true)).toBe("Books");
    expect(folderName("C:\\Users\\w\\Books\\Novel.mss", true)).toBe("Books");
    expect(folderName("/home/w/Books/", false)).toBe("Books");
    // Nothing to take: the whole path, never a blank line.
    expect(folderName("Novel.mss", true)).toBe("Novel.mss");
  });

  test("backups and archives open closed, and the toggle opens them", async () => {
    const rig = mount();
    await open(rig);
    const toggle = el(rig.container, "project-copies-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("project-copies");
    expect(el(rig.container, "project-copies").hidden).toBe(true);
    // Nothing is removed from the tree while closed.
    expect(el(rig.container, "project-copies").contains(el(rig.container, "project-archive-now"))).toBe(true);
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(el(rig.container, "project-copies").hidden).toBe(false);
    teardown(rig);
  });

  test("section headings have level-three semantics and names without help text", async () => {
    const rig = mount();
    await open(rig, "copies");
    for (const [id, label] of [
      ["project-import-heading", "Import"],
      ["project-recovery-heading", "Recovery points on this device"],
      ["project-archive-heading", "If you lose this computer"],
      ["project-encrypted-archive-heading", "Encrypted backups"],
      ["project-mirror-heading", "A readable copy you can open anywhere"],
    ]) {
      const heading = el(rig.container, id!);
      expect(heading.getAttribute("role")).toBe("heading");
      expect(heading.getAttribute("aria-level")).toBe("3");
      expect(heading.getAttribute("aria-label")).toBe(label);
    }
    expect(el(rig.container, "project-recovery-heading").querySelector("button")?.getAttribute("aria-describedby"))
      .toBe("project-recovery-note");
    teardown(rig);
  });

  test("expanding backups scrolls the focused disclosure without moving focus", async () => {
    const rig = mount();
    await open(rig, "create");
    const toggle = el(rig.container, "project-copies-toggle");
    toggle.focus();
    const requests: (ScrollIntoViewOptions | boolean | undefined)[] = [];
    toggle.scrollIntoView = (options) => {
      expect(toggle.closest("[hidden]")).toBeNull();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement?.id).toBe("project-copies-toggle");
      requests.push(options);
    };
    click(toggle);
    expect(requests).toEqual([{ block: "start", inline: "nearest" }]);
    expect(document.activeElement?.id).toBe("project-copies-toggle");
    click(toggle);
    expect(el(rig.container, "project-copies").hidden).toBe(true);
    expect(requests).toHaveLength(1);
    click(el(rig.container, "project-panel").querySelector<HTMLButtonElement>(".panel-close")!);
    expect(el(rig.container, "project-panel").hidden).toBe(true);
    click(toggle);
    expect(el(rig.container, "project-copies").hidden).toBe(true);
    expect(requests).toHaveLength(1);
    await open(rig, "copies");
    expect(document.activeElement?.id).toBe("project-mirror-toggle");
    expect(requests).toHaveLength(1);
    teardown(rig);
  });

  test("the backups route reveals and scrolls encrypted backups, focusing an available action", async () => {
    const cases: [RigOptions, string][] = [
      [{ makeEncryptedArchive: async () => null, generateArchiveKey: async () => null }, "project-archive-encrypted"],
      [{ generateArchiveKey: async () => null }, "project-archive-key"],
      [{ verifyEncryptedArchive: async () => null }, "project-archive-encrypted-verify"],
      [{ restoreEncryptedArchive: async () => null }, "project-archive-encrypted-restore"],
      [{}, "project-encrypted-archive-heading"],
    ];
    for (const [options, focusId] of cases) {
      const rig = mount(options);
      const heading = el(rig.container, "project-encrypted-archive-heading");
      const requests: (ScrollIntoViewOptions | boolean | undefined)[] = [];
      heading.scrollIntoView = (request) => {
        expect(heading.closest("[hidden]")).toBeNull();
        expect(document.activeElement?.id).toBe(focusId);
        requests.push(request);
      };
      await open(rig, "backups");
      expect(el(rig.container, "project-copies").hidden).toBe(false);
      expect(el(rig.container, "project-copies-toggle").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement?.id).toBe(focusId);
      expect(requests).toEqual([{ block: "start", inline: "nearest" }]);
      if (focusId === heading.id) expect(heading.tabIndex).toBe(-1);
      await open(rig, "copies");
      expect(document.activeElement?.id).toBe("project-mirror-toggle");
      expect(requests).toHaveLength(1);
      teardown(rig);
    }
  });

  test("the restore route focuses restore even when other encrypted actions are available", async () => {
    for (const availability of ["available", "missing", "disabled"] as const) {
      const rig = mount({
        makeEncryptedArchive: async () => null,
        generateArchiveKey: async () => null,
        verifyEncryptedArchive: async () => null,
        restoreEncryptedArchive: availability === "missing" ? undefined : async () => null,
      });
      const restore = el(rig.container, "project-archive-encrypted-restore") as HTMLButtonElement;
      if (availability === "disabled") restore.disabled = true;
      const heading = el(rig.container, "project-encrypted-archive-heading");
      const focusId = availability === "available" ? restore.id : heading.id;
      let requests = 0;
      heading.scrollIntoView = () => {
        expect(heading.closest("[hidden]")).toBeNull();
        expect(document.activeElement?.id).toBe(focusId);
        requests++;
      };
      await open(rig, "restore");
      expect(el(rig.container, "project-copies").hidden).toBe(false);
      expect(document.activeElement?.id).toBe(focusId);
      expect(requests).toBe(1);
      await open(rig, "copies");
      expect(document.activeElement?.id).toBe("project-mirror-toggle");
      expect(requests).toBe(1);
      teardown(rig);
    }
  });

  test("pending restore alignment respects navigation, focus, project identity and privacy", async () => {
    for (const leave of ["close", "collapse", "route", "focus", "project", "generation", "privacy", "destroy"] as const) {
      let release: (points: RecoveryPoint[]) => void = () => {};
      const pending = new Promise<RecoveryPoint[]>((resolve) => { release = resolve; });
      let path = "/current-book.db";
      let generation = 1;
      let allowed = true;
      const rig = mount({
        listRecoveryPoints: () => pending, restoreEncryptedArchive: async () => null,
        currentPath: () => path, currentGeneration: () => generation, canReportArchive: async () => allowed,
      });
      let requests = 0;
      el(rig.container, "project-encrypted-archive-heading").scrollIntoView = () => { requests++; };
      await open(rig, "restore");
      expect(document.activeElement?.id).toBe("project-archive-encrypted-restore");
      expect(requests).toBe(0);
      if (leave === "close") click(el(rig.container, "project-panel").querySelector<HTMLButtonElement>(".panel-close")!);
      if (leave === "collapse") click(el(rig.container, "project-copies-toggle"));
      if (leave === "route") await open(rig, "copies");
      if (leave === "focus") el(rig.container, "project-new-name").focus();
      if (leave === "project") path = "/other-book.db";
      if (leave === "generation") generation++;
      if (leave === "privacy") allowed = false;
      if (leave === "destroy") rig.switcher.destroy();
      release(POINTS);
      await settle();
      expect(requests).toBe(0);
      teardown(rig);
    }
  });

  test("restore alignment rechecks focus and generation after the asynchronous privacy read", async () => {
    for (const leave of ["focus", "generation"] as const) {
      let release: (allowed: boolean) => void = () => {};
      const pending = new Promise<boolean>((resolve) => { release = resolve; });
      let generation = 1;
      const rig = mount({ restoreEncryptedArchive: async () => null,
        currentGeneration: () => generation, canReportArchive: () => pending });
      let requests = 0;
      el(rig.container, "project-encrypted-archive-heading").scrollIntoView = () => { requests++; };
      await open(rig, "restore");
      expect(requests).toBe(0);
      if (leave === "focus") el(rig.container, "project-new-name").focus();
      if (leave === "generation") generation++;
      release(true);
      await settle();
      expect(requests).toBe(0);
      teardown(rig);
    }
  });

  test("the backups route waits for earlier content before aligning its section", async () => {
    let release: (points: RecoveryPoint[]) => void = () => {};
    const pending = new Promise<RecoveryPoint[]>((resolve) => { release = resolve; });
    let releaseDir: (dir: string) => void = () => {};
    const pendingDir = new Promise<string>((resolve) => { releaseDir = resolve; });
    const rig = mount({ listRecoveryPoints: () => pending, newDir: () => pendingDir, makeEncryptedArchive: async () => null });
    const heading = el(rig.container, "project-encrypted-archive-heading");
    const requests: (ScrollIntoViewOptions | boolean | undefined)[] = [];
    heading.scrollIntoView = (request) => {
      expect(el(rig.container, "project-recovery-points").querySelectorAll("[data-point-id]")).toHaveLength(POINTS.length);
      expect(document.activeElement?.id).toBe("project-archive-encrypted");
      requests.push(request);
    };
    await open(rig, "backups");
    expect(document.activeElement?.id).toBe("project-archive-encrypted");
    expect(requests).toHaveLength(0);
    release(POINTS);
    await settle();
    expect(requests).toHaveLength(0);
    releaseDir(NEW_DIR);
    await settle();
    expect(requests).toEqual([{ block: "start", inline: "nearest" }]);
    teardown(rig);
  });

  test("a pending backups alignment cannot scroll after navigation or a focus change", async () => {
    for (const leave of ["close", "collapse", "route", "focus", "destroy"]) {
      let release: (points: RecoveryPoint[]) => void = () => {};
      const pending = new Promise<RecoveryPoint[]>((resolve) => { release = resolve; });
      const rig = mount({ listRecoveryPoints: () => pending, makeEncryptedArchive: async () => null });
      let requests = 0;
      el(rig.container, "project-encrypted-archive-heading").scrollIntoView = () => { requests++; };
      await open(rig, "backups");
      if (leave === "close") click(el(rig.container, "project-panel").querySelector<HTMLButtonElement>(".panel-close")!);
      if (leave === "collapse") click(el(rig.container, "project-copies-toggle"));
      if (leave === "route") await open(rig, "copies");
      if (leave === "focus") el(rig.container, "project-new-name").focus();
      if (leave === "destroy") rig.switcher.destroy();
      release(POINTS);
      await settle();
      expect(requests).toBe(0);
      teardown(rig);
    }
  });

  test("they open by themselves when a copy needs attention, and on the copies route", async () => {
    let attention = true;
    const rig = mount({ copiesNeedAttention: () => attention });
    await open(rig);
    expect(el(rig.container, "project-copies").hidden).toBe(false);
    attention = false;
    await open(rig);
    expect(el(rig.container, "project-copies").hidden).toBe(true);
    await open(rig, "copies");
    expect(el(rig.container, "project-copies").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("project-mirror-toggle");
    teardown(rig);
  });

  test("the import folder stays closed while empty and opens when a file is waiting", async () => {
    const empty = mount({ listImports: () => Promise.resolve([]) });
    await open(empty);
    expect(el(empty.container, "project-import-body").hidden).toBe(true);
    expect(el(empty.container, "project-import-toggle").getAttribute("aria-expanded")).toBe("false");
    teardown(empty);

    const waiting = mount({ listImports: () => Promise.resolve(["book.md"]) });
    await open(waiting);
    expect(el(waiting.container, "project-import-body").hidden).toBe(false);
    expect(el(waiting.container, "project-import-toggle").getAttribute("aria-expanded")).toBe("true");
    teardown(waiting);
  });
});


test("action-bearing Books rows expose native keyboard controls inside list items", async () => {
  const rig = mount({ listImports: async () => ["draft.md"], listRecoveryPoints: async () => [POINTS[0]!] });
  await open(rig);
  for (const id of ["project-list", "project-imports", "project-recovery-points", "project-archives"]) {
    expect(el(rig.container, id).getAttribute("role")).toBe("list");
  }
  const openButton = el(rig.container, "project-list").querySelector<HTMLButtonElement>(".switcher-open")!;
  expect(openButton.parentElement?.getAttribute("role")).toBe("listitem");
  openButton.focus();
  expect(document.activeElement === openButton).toBe(true);
  const imported = el(rig.container, "project-imports").querySelector<HTMLButtonElement>(".switcher-import")!;
  expect(imported.parentElement?.getAttribute("role")).toBe("listitem");
  const restored = el(rig.container, "project-recovery-points").querySelector<HTMLButtonElement>(".switcher-restore")!;
  expect(restored.parentElement?.getAttribute("role")).toBe("listitem");
  teardown(rig);
});


describe("Books without an open book", () => {
  test("Restore keeps recovery tools available without book-only dead ends", async () => {
    const actions: string[] = [];
    const rig = mount({ currentPath: () => "",
      generateArchiveKey: async () => { actions.push("key"); return null; },
      makeEncryptedArchive: async () => { actions.push("make"); return null; },
      verifyEncryptedArchive: async () => { actions.push("verify"); return null; },
      restoreEncryptedArchive: async () => { actions.push("restore"); return null; },
      chooseEncryptedBackupDestination: async () => { actions.push("destination"); return null; },
    });
    try {
      rig.switcher.open("restore"); await settle();
      for (const id of ["project-move", "project-recovery-heading", "project-recovery-points", "project-archive-heading", "project-archive-now", "project-archive-where", "project-mirror-heading", "project-mirror-toggle", "project-mirror-where", "project-archive-encrypted"]) {
        expect(el(rig.container, id).hidden).toBe(true);
      }
      expect(el(rig.container, "project-book-required").hidden).toBe(false);
      expect(el(rig.container, "project-book-required").textContent).toBe(t("switcher.book-required"));
      expect(el(rig.container, "project-archive-where").textContent).toBe("");
      expect(el(rig.container, "project-mirror-where").textContent).toBe("");
      for (const id of ["project-archive-key", "project-archive-encrypted-verify", "project-archive-encrypted-restore", "project-backup-destination-choose"]) {
        const button = (el(rig.container, id) as HTMLButtonElement);
        expect(button.hidden).toBe(false); expect(button.disabled).toBe(false);
        click(button); await settle();
      }
      expect(actions).toEqual(["key", "verify", "restore", "destination"]);
      for (const id of ["project-move", "project-archive-now", "project-mirror-toggle", "project-archive-encrypted"]) {
        el(rig.container, id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await settle();
      expect(actions).not.toContain("make"); expect(rig.calls.moved).toBe(0);
      expect(rig.calls.archived).toBe(0); expect(rig.calls.mirrorPreviews).toBe(0);
      expect(rig.calls.listedPoints).toBe(0); expect(rig.calls.listedArchives).toBe(0);
      expect((el(rig.container, "project-new-name") as HTMLInputElement).placeholder).toBe("");
    } finally { teardown(rig); }
  });

  test("closing and opening a book updates its maintenance prerequisites", async () => {
    let path = "/p/one.mss";
    const rig = mount({ currentPath: () => path, makeEncryptedArchive: async () => null });
    try {
      await open(rig);
      path = ""; rig.switcher.setBookOpen(false);
      expect(el(rig.container, "project-archive-now").hidden).toBe(true);
      expect((el(rig.container, "project-archive-encrypted") as HTMLButtonElement).disabled).toBe(true);
      path = "/p/two.mss"; rig.switcher.setBookOpen(true);
      rig.switcher.open("backups"); await settle();
      expect(el(rig.container, "project-archive-now").hidden).toBe(false);
      expect((el(rig.container, "project-archive-encrypted") as HTMLButtonElement).disabled).toBe(false);
      expect(el(rig.container, "project-book-required").hidden).toBe(true);
    } finally { teardown(rig); }
  });
});


describe("saved books awaiting Library registration", () => {
  const saved: ProjectSummary = { path: "/saved/draft.db", name: "Saved draft", modified_at: 5,
    registration_warning: { token: "host-token", error: "settings blocked" } };

  for (const route of ["project-create", "project-new-choose"] as const) {
    test(`${route} reports a saved unregistered book after the panel closes`, async () => {
      let release!: (project: ProjectSummary) => void;
      const pending = new Promise<ProjectSummary>((resolve) => { release = resolve; });
      const rig = mount({ createProject: () => pending, createProjectIn: () => pending });
      try {
        await open(rig, "create");
        const input = el(rig.container, "project-new-name") as HTMLInputElement;
        input.value = "Saved draft";
        click(el(rig.container, route));
        el(rig.container, "project-panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        const listings = rig.calls.list;
        release(saved);
        await settle();
        expect(rig.calls.notices).toEqual([`${t("registration.warning", { path: saved.path })} ${t("registration.session")}`]);
        expect(rig.calls.dones).toEqual([]);
        expect(input.value).toBe("Saved draft");
        expect(rig.calls.list).toBe(listings);
      } finally { teardown(rig); }
    });
  }

  test("pending rows remain actionable with no book open and retry uses only a token", async () => {
    let entries: PendingRegistration[] = [{ token: "host-token", path: saved.path, name: saved.name }];
    const tokens: string[] = [];
    const rig = mount({ currentPath: () => "", listProjects: async () => [], listPendingRegistrations: async () => entries,
      retryRegistration: async (token) => { tokens.push(token); entries = []; return { ...saved, registration_warning: null }; } });
    try {
      rig.switcher.setBookOpen(false);
      await open(rig);
      const pending = el(rig.container, "project-pending-registrations");
      expect(pending.hidden).toBe(false);
      click(pending.querySelector("button")!);
      await settle();
      expect(tokens).toEqual(["host-token"]);
      expect(rig.calls.dones).toEqual([t("registration.done", { name: saved.name })]);
      expect(pending.hidden).toBe(true);
    } finally { teardown(rig); }
  });

  test("retry failure leaves the saved-book row available", async () => {
    const rig = mount({ listPendingRegistrations: async () => [{ token: "host-token", path: saved.path, name: saved.name }],
      retryRegistration: async () => { throw new Error("settings still blocked"); } });
    try {
      await open(rig);
      const pending = el(rig.container, "project-pending-registrations");
      const button = pending.querySelector<HTMLButtonElement>("button")!;
      click(button);
      await settle();
      expect(rig.calls.notices).toEqual(["settings still blocked"]);
      expect(pending.hidden).toBe(false);
      expect(button.disabled).toBe(false);
    } finally { teardown(rig); }
  });
});


for (const blocked of ["privacy", "workspace"] as const) {
  test(`an encrypted restore registration warning stays private after ${blocked} changes`, async () => {
    let release!: (project: ProjectSummary) => void;
    const pending = new Promise<ProjectSummary>((resolve) => { release = resolve; });
    let allowed = true;
    let generation = 1;
    const rig = mount({ restoreEncryptedArchive: () => pending, canReportArchive: async () => allowed, currentGeneration: () => generation });
    try {
      await open(rig, "restore");
      click(el(rig.container, "project-archive-encrypted-restore"));
      if (blocked === "privacy") allowed = false;
      else generation++;
      release({ path: "/saved/restore.db", name: "Saved restore", modified_at: 5, registration_warning: { token: "secret-token", error: "blocked" } });
      await settle();
      expect(rig.calls.notices).toEqual([]);
      expect(rig.calls.dones).toEqual([]);
    } finally { teardown(rig); }
  });
}

test("an imported unregistered manuscript preserves its omission disclosure", async () => {
  const saved = { path: "/saved/import.db", name: "Imported", modified_at: 1, registration_warning: { token: "token", error: "blocked" } };
  const losses = { ...ZERO_LOSSES, pictures: 2, revisions: 1 };
  const rig = mount({ listImports: async () => ["book.docx"], importProject: async () => ({ summary: saved, losses }) });
  try {
    await open(rig, "import");
    click(rig.container.querySelector<HTMLElement>('[data-import-file="book.docx"]')!);
    await settle();
    expect(rig.calls.notices).toEqual([`${t("registration.warning", { path: saved.path })} ${t("registration.session")}`]);
    expect(rig.calls.dones).toEqual([lossesNotice(losses)!]);
    expect(rig.calls.switched).toEqual([]);
  } finally { teardown(rig); }
});


test("a scanned Library book reports an unsaved folder preference without a retry promise", () => {
  const project: ProjectSummary = { path: "/library/book.db", name: "Book", modified_at: 1,
    registration_warning: { kind: "destination_preference", token: null, error: "settings blocked" } };
  expect(registrationNotice(project)).toBe(t("registration.preference", { path: project.path }));
});

test("a saved book with unverifiable identity gives location guidance without a retry promise", () => {
  const project: ProjectSummary = { path: "/saved/book.db", name: "Book", modified_at: 1,
    registration_warning: { kind: "registration_unavailable", token: null, error: "identity changed" } };
  expect(registrationNotice(project)).toBe(t("registration.unavailable", { path: project.path }));
});
