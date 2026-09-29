import { describe, expect, test } from "bun:test";
import {
  BACK_MATTER_TYPE,
  BIBLE_FOLDER_TYPE,
  BIBLE_TYPE,
  FRONT_MATTER_TYPE,
  MATTER_TYPE,
  NOTE_TYPE,
  TIMELINE_TYPE,
  TRASH_TYPE,
} from "../src/item-types";
import {
  chapterItemsIn,
  createOutline,
  isTrashedIn,
  liveItemsIn,
  manuscriptItemsIn,
  planMove,
  readingOrderItems,
  sectionChange,
  type Outline,
  type OutlineDeps,
} from "../src/outline";
import type { ProjectItem } from "../src/store/source";

const item = (
  id: string,
  parent: string | null,
  depth: number,
  rev = 1,
  title = id,
  type = "scene",
): ProjectItem => ({ id, parent_id: parent, type, title, position: "0000", rev, state: null, depth });

//   p1
//     c1 (rev 7)
//       s1 s2
//   p2
const walk = (): ProjectItem[] => [
  item("p1", null, 0, 1, "p1", "part"),
  item("c1", "p1", 1, 7, "c1", "chapter"),
  item("s1", "c1", 2),
  item("s2", "c1", 2),
  item("p2", null, 0, 1, "p2", "part"),
];

/** A book as it comes out of the box: the host's starter scene, and nothing
 *  else. The reported shape, and the one every
 *  other fixture in this file is missing -- they all open with a part. */
const newBook = (): ProjectItem[] => [item("s1", null, 0, 1, "Scene 1")];

interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

interface Rig {
  outline: Outline;
  /** invoke calls AND reload, in one array. Only an ordering assertion can see
   *  the command -> re-read -> reload sequence; every end state passes either
   *  way. */
  log: string[];
  calls: Call[];
  reloads: ProjectItem[][];
  failures: string[];
  created: string[];
  done: string[];
}

function rig(opts: {
  /** Successive `project_items` results. The last one repeats. */
  walks?: ProjectItem[][];
  selected?: string | null;
  initialItems?: readonly ProjectItem[];
  rejectOn?: string | string[];
  rejectWith?: Error;
  /** Lets a test seed a walk and only then arm the rejection. */
  rejectAfter?: number;
  /** Model the store's actual base_rev discipline: a mutation carrying a rev
   *  the current walk no longer reports is refused as a Conflict. */
  refuseStaleRev?: boolean;
  /** Awaited inside invoke, so a test can hold an operation in flight across
   *  something else - a teardown, say. */
  gate?: Promise<unknown>;
  confirmSectionMove?: OutlineDeps["confirmSectionMove"];
} = {}): Rig {
  const rejects = typeof opts.rejectOn === "string" ? [opts.rejectOn] : opts.rejectOn ?? [];
  const log: string[] = [];
  const calls: Call[] = [];
  const reloads: ProjectItem[][] = [];
  const failures: string[] = [];
  const created: string[] = [];
  const done: string[] = [];
  const walks = opts.walks ?? [walk()];
  // The store's CURRENT state, advanced by a mutation rather than by a read: a
  // read must be repeatable, and a test that seeds the unit with refresh()
  // would otherwise skip the store a state forward before it mutated anything.
  // The last entry repeats.
  let state = 0;
  const stateWalk = (): ProjectItem[] => walks[Math.min(state, walks.length - 1)] ?? [];

  let seen = 0;
  const invoke: OutlineDeps["invoke"] = async (cmd, args) => {
    calls.push({ cmd, args });
    log.push(cmd);
    seen++;
    if (opts.gate !== undefined) await opts.gate;
    if (rejects.includes(cmd) && seen > (opts.rejectAfter ?? 0)) {
      throw opts.rejectWith ?? new Error(`${cmd} exploded`);
    }
    if (cmd === "project_items") return stateWalk();
    if (
      cmd === "item_create" ||
      cmd === "item_rename" ||
      cmd === "item_move" ||
      cmd === "item_set_state"
    ) {
      if (
        opts.refuseStaleRev &&
        (cmd === "item_move" || cmd === "item_rename" || cmd === "item_set_state")
      ) {
        const row = stateWalk().find((i) => i.id === args?.["id"]);
        if (row !== undefined && row.rev !== args?.["baseRev"]) {
          throw new Error(`conflict: item ${String(args?.["id"])}`);
        }
      }
      state++;
      // The store answers a create with the row it made. `create` reads the id
      // out of this to move the selection, so a fake that answered `{}` would
      // make every selection-follows-the-new-row test vacuous.
      if (cmd === "item_create") return { id: `made-${state}`, position: "0", rev: 1 };
    }
    return {};
  };

  const outline = createOutline({
    invoke,
    reload: (items) => {
      log.push("reload");
      reloads.push(items);
    },
    selectedId: () => opts.selected ?? null,
    onCreated: (id) => created.push(id),
    onFailure: (message) => failures.push(message),
    onDone: (message) => done.push(message),
    confirmSectionMove: opts.confirmSectionMove,
    initialItems: opts.initialItems ?? [],
  });

  return { outline, log, calls, reloads, failures, created, done };
}

/** Seeds the unit's walk the way the page does at boot, then clears the log so
 *  each test asserts about its own mutation. */
async function seeded(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(opts);
  await r.outline.refresh();
  r.log.length = 0;
  r.calls.length = 0;
  r.reloads.length = 0;
  return r;
}

const argsOf = (r: Rig, cmd: string): Record<string, unknown> | undefined =>
  r.calls.find((c) => c.cmd === cmd)?.args;

describe("createOutline: create", () => {
  test("sends the placement and the numbered title, in camelCase", async () => {
    // camelCase is not cosmetic. `parentId` and `afterId` are Option args: a
    // misspelling deserializes to None, which for `parentId` means "create at
    // root" - legal, wrong, and indistinguishable from the correct call.
    //
    // The fixture's chapter `c1` is selected, so a new scene appends inside it:
    // `c1` IS the holder, and there is no ancestor between the two to follow.
    const r = await seeded({ selected: "c1" });
    expect(await r.outline.create("scene")).toBe("applied");
    expect(argsOf(r, "item_create")).toEqual({
      parentId: "c1",
      afterId: null,
      itemType: "scene",
      title: "Scene 1",
    });
  });

  test("a new scene beside the selected scene follows it", async () => {
    // The reported act, and the arm the test above cannot reach: with
    // a SCENE selected the new one lands after it inside the same chapter,
    // rather than at the end of the group.
    const r = await seeded({ selected: "s1" });
    await r.outline.create("scene");
    expect(argsOf(r, "item_create")).toEqual({
      parentId: "c1",
      afterId: "s1",
      itemType: "scene",
      title: "Scene 1",
    });
  });

  test("with nothing selected sends an explicit null parent", async () => {
    const r = await seeded({ selected: null });
    await r.outline.create("part");
    expect(argsOf(r, "item_create")).toEqual({
      parentId: null,
      afterId: null,
      itemType: "part",
      title: "Part 1",
    });
  });

  test("the selection follows the created row", async () => {
    // NOT a convenience. Placement is relative to the selection, so a selection
    // that stays put makes every create land in the same slot -- and three
    // creates in a row come out REVERSED, each pushing the last down. Measured
    // on a live window: New part, New chapter, New scene produced Scene 1,
    // Chapter 1, Part 1 in that order down the pane. No unit test saw it,
    // which is why this one exists.
    const r = await seeded({ selected: "c1" });
    await r.outline.create("scene");
    expect(r.created).toEqual(["made-1"]);
  });

  test("a create the store refused moves the selection nowhere", async () => {
    // A failed create has no row to select, and moving the selection anyway
    // leaves the writer pointing at whatever happened to be there.
    const r = await seeded({ selected: "c1", rejectOn: "item_create" });
    expect(await r.outline.create("scene")).toBe("failed");
    expect(r.created).toEqual([]);
  });

  test("a create that COMMITTED but could not be re-read moves the selection nowhere", async () => {
    // The arm the test above cannot reach, and the one the `applied` check
    // exists for. With the invoke rejected there is no id to pass on either
    // way, so a mutation deleting the outcome check SURVIVED - it was equivalent
    // to the code. Only the mutation pass saw it.
    //
    // Here the store accepts the create and hands back an id, and the re-read
    // that follows fails. The navigator is therefore still showing the tree
    // from BEFORE the create, and selecting a row it does not hold would leave
    // the selection pointing at nothing while a banner explains something else.
    const r = await seeded({
      selected: "c1",
      rejectOn: "project_items",
      // The rig's own seeding reads the walk once; arm the rejection after it.
      rejectAfter: 1,
    });
    expect(await r.outline.create("scene")).toBe("failed");
    expect(r.calls.some((c) => c.cmd === "item_create")).toBe(true);
    expect(r.created).toEqual([]);
  });

  test("command, then re-read, then reload - in that order", async () => {
    const r = await seeded({ selected: "c1" });
    await r.outline.create("scene");
    expect(r.log).toEqual(["item_create", "project_items", "reload"]);
  });

  test("reload receives the freshly read walk", async () => {
    const after = [...walk(), item("s3", "c1", 2)];
    const r = await seeded({ walks: [walk(), after], selected: "c1" });
    await r.outline.create("scene");
    expect(r.reloads).toHaveLength(1);
    expect(r.reloads[0]?.map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "p2", "s3"]);
  });
});

describe("createOutline: a chapter with nowhere to live", () => {
  // THE REPORTED DEFECT, 2026-08-27. In a new book -- one starter scene, no
  // part -- New chapter landed at the root beside the scene, and the part
  // created next was placed after THAT, appearing below the chapter it was
  // meant to contain. Three flat siblings in an order that reads backwards.
  //
  // Every other create test in this file starts from `walk()`, which opens with
  // a part, which is why the mutation pass that shipped the rule could not see
  // this.
  const creates = (r: Awaited<ReturnType<typeof seeded>>): Call[] =>
    r.calls.filter((c) => c.cmd === "item_create");

  test("makes the part, then the chapter INSIDE it", async () => {
    const r = await seeded({ walks: [newBook()], selected: "s1" });
    await r.outline.create("chapter");
    const made = creates(r);
    expect(made.length).toBe(2);
    // The part first, at the root, after the scene the writer was on.
    expect(made[0]?.args).toEqual({
      parentId: null,
      afterId: "s1",
      itemType: "part",
      title: "Part 1",
    });
    // Then the chapter INSIDE it. `parentId` is the id the fake answered with,
    // which is what makes this an assertion about the wiring rather than about
    // the plan: a build that created both at the root would pass a test that
    // only counted the calls.
    expect(made[1]?.args).toEqual({
      parentId: "made-1",
      afterId: null,
      itemType: "chapter",
      title: "Chapter 1",
    });
  });

  test("the part is made BEFORE the chapter", async () => {
    // Ordering, asserted separately: a build that created the chapter first and
    // the part after it would produce the same two rows with the same parents
    // only if the store accepted a parent that does not exist yet, which it
    // does not -- but the fake does, so nothing else here would catch it.
    const r = await seeded({ walks: [newBook()], selected: "s1" });
    await r.outline.create("chapter");
    expect(creates(r).map((c) => c.args?.["itemType"])).toEqual(["part", "chapter"]);
  });

  test("the selection follows the CHAPTER, not the part", async () => {
    // The writer asked for a chapter. Leaving them selected on a part they did
    // not ask for would make the next press land somewhere else again, which is
    // the second half of the reported defect.
    const r = await seeded({ walks: [newBook()], selected: "s1" });
    await r.outline.create("chapter");
    expect(r.created).toEqual(["made-2"]);
  });

  test("a book that HAS a part makes only the chapter", async () => {
    // The control. A rule that always built a holder would double every part in
    // the book.
    const r = await seeded({ selected: "s1" });
    await r.outline.create("chapter");
    expect(creates(r).length).toBe(1);
    expect(creates(r)[0]?.args?.["itemType"]).toBe("chapter");
  });

  test("a scene in a bare book is still ONE row at the root", async () => {
    // A flat book of scenes is a book a writer is allowed to have. Building a
    // chapter and a part over a press for one row would answer it with three.
    const r = await seeded({ walks: [newBook()], selected: "s1" });
    await r.outline.create("scene");
    expect(creates(r).length).toBe(1);
    expect(creates(r)[0]?.args).toEqual({
      parentId: null,
      afterId: "s1",
      itemType: "scene",
      title: "Scene 2",
    });
  });

  test("a part in a bare book is still ONE row", async () => {
    const r = await seeded({ walks: [newBook()], selected: "s1" });
    await r.outline.create("part");
    expect(creates(r).length).toBe(1);
    expect(creates(r)[0]?.args?.["itemType"]).toBe("part");
  });

  test("a failed part leaves the chapter unattempted and reports the failure", async () => {
    // STOPS, and leaves what did land. Unwinding would be a second write on a
    // path that has just said writes are failing.
    const r = await seeded({
      walks: [newBook()],
      selected: "s1",
      rejectOn: "item_create",
    });
    expect(await r.outline.create("chapter")).toBe("failed");
    expect(creates(r).length).toBe(1);
    expect(r.created).toEqual([]);
  });
});

describe("createOutline: rename", () => {
  test("sends the rev the last walk reported", async () => {
    const r = await seeded();
    expect(await r.outline.rename("c1", "New")).toBe("applied");
    expect(argsOf(r, "item_rename")).toEqual({ id: "c1", title: "New", baseRev: 7 });
  });

  test("an unchanged title is inert and reaches no IPC", async () => {
    const r = await seeded();
    expect(await r.outline.rename("c1", "c1")).toBe("inert");
    expect(r.calls).toHaveLength(0);
    expect(r.failures).toHaveLength(0);
  });

  test("a blank or whitespace-only title is inert and reaches no IPC", async () => {
    // Unrecoverable through this UI: the row would have no name to click.
    const r = await seeded();
    expect(await r.outline.rename("c1", "")).toBe("inert");
    expect(await r.outline.rename("c1", "   ")).toBe("inert");
    expect(r.calls).toHaveLength(0);
  });

  test("an id absent from the walk fails without inventing a rev", async () => {
    const r = await seeded();
    expect(await r.outline.rename("ghost", "New")).toBe("failed");
    expect(r.calls.some((c) => c.cmd === "item_rename")).toBe(false);
    expect(r.failures).toHaveLength(1);
  });

  test("before the first read every id is absent, so a rename fails", async () => {
    // `rig()`'s default initialItems IS `[]`, so this covers the empty-seed
    // case too. It used to be restated as a second test in the construction
    // block, phrased differently and asserting exactly the same thing.
    const r = rig();
    expect(await r.outline.rename("c1", "New")).toBe("failed");
    expect(r.calls).toHaveLength(0);
    expect(r.failures).toHaveLength(1);
  });

  test("revisions are never cached across mutations", async () => {
    // The store bumps c1 to 42, not to 8. A unit that remembered its own rev and
    // incremented it would send 8 and be refused for the rest of the session.
    const bumped = walk().map((i) => (i.id === "c1" ? { ...i, rev: 42, title: "New" } : i));
    const r = await seeded({ walks: [walk(), bumped] });
    await r.outline.rename("c1", "New");
    await r.outline.rename("c1", "Newer");
    const renames = r.calls.filter((c) => c.cmd === "item_rename");
    expect(renames).toHaveLength(2);
    expect(renames[0]?.args).toEqual({ id: "c1", title: "New", baseRev: 7 });
    expect(renames[1]?.args).toEqual({ id: "c1", title: "Newer", baseRev: 42 });
  });
});

describe("createOutline: setState", () => {
  test("sends the state and the rev the last walk reported", async () => {
    const r = await seeded();
    expect(await r.outline.setState("c1", "revising")).toBe("applied");
    expect(argsOf(r, "item_set_state")).toEqual({ id: "c1", state: "revising", baseRev: 7 });
  });

  test("clearing sends null, and the key is PRESENT", async () => {
    // `state` is an Option arg host-side and None MEANS the default there, so a
    // missing key does not error - it clears the state. That is legal, wrong,
    // and indistinguishable from the call that was intended, which is the
    // recorded `parentId` hazard with a destructive reading. The assertion is on
    // the key's presence, not only on its value.
    const marked = walk().map((i) => (i.id === "c1" ? { ...i, state: "draft" } : i));
    const r = await seeded({ initialItems: marked, walks: [marked] });
    expect(await r.outline.setState("c1", null)).toBe("applied");
    const args = argsOf(r, "item_set_state") ?? {};
    expect("state" in args).toBe(true);
    expect(args).toEqual({ id: "c1", state: null, baseRev: 7 });
  });

  test("the state a row already stands in is inert and reaches no IPC", async () => {
    // The panel repaints from the walk, so pressing the current state is an
    // ordinary thing to do: it must not cost a write, a rev bump or a
    // reprojection of 20,060 rows.
    const marked = walk().map((i) => (i.id === "c1" ? { ...i, state: "done" } : i));
    const r = await seeded({ initialItems: marked, walks: [marked] });
    expect(await r.outline.setState("c1", "done")).toBe("inert");
    expect(r.calls).toHaveLength(0);
    expect(r.failures).toHaveLength(0);
  });

  test("clearing a row that has no state is inert: null and absent are one thing", async () => {
    const r = await seeded();
    expect(await r.outline.setState("c1", null)).toBe("inert");
    expect(r.calls).toHaveLength(0);
  });

  test("any item type can be marked, not only a scene", async () => {
    // A writer marks a whole chapter `revising`, and the hierarchy is free-form
    // everywhere else, so a type check here would be a rule nothing else in the
    // outline has. p1 is a PART.
    const r = await seeded();
    expect(await r.outline.setState("p1", "outline")).toBe("applied");
    expect(argsOf(r, "item_set_state")).toEqual({ id: "p1", state: "outline", baseRev: 1 });
  });

  test("an id absent from the walk fails without inventing a rev", async () => {
    const r = await seeded();
    expect(await r.outline.setState("ghost", "draft")).toBe("failed");
    expect(r.calls.some((c) => c.cmd === "item_set_state")).toBe(false);
    expect(r.failures).toHaveLength(1);
  });

  test("a refusal is reported and the tree is re-read anyway", async () => {
    const r = await seeded({ rejectOn: "item_set_state" });
    expect(await r.outline.setState("c1", "draft")).toBe("failed");
    expect(r.failures[0]).toContain("revision state");
    // The command may have committed before the failure reached us, and a screen
    // showing a tree that no longer exists is worse than a slow one.
    expect(r.log).toContain("project_items");
  });

  test("revisions are never cached across mutations", async () => {
    // The store bumps c1 to 42, not to 8. A unit that remembered its own rev and
    // incremented it would send 8 and be refused for the rest of the session.
    const bumped = walk().map((i) =>
      i.id === "c1" ? { ...i, rev: 42, state: "draft" } : i,
    );
    const r = await seeded({ walks: [walk(), bumped] });
    await r.outline.setState("c1", "draft");
    await r.outline.setState("c1", "done");
    const sets = r.calls.filter((c) => c.cmd === "item_set_state");
    expect(sets).toHaveLength(2);
    expect(sets[0]?.args).toEqual({ id: "c1", state: "draft", baseRev: 7 });
    expect(sets[1]?.args).toEqual({ id: "c1", state: "done", baseRev: 42 });
  });

  test("it is serialized against a move already in flight", async () => {
    // Every operation reads the walk INSIDE the serialized body. Two mutations
    // planned against the same pre-mutation walk means the second carries a rev
    // the store has already spent, and is refused as a Conflict.
    const bumped = walk().map((i) => (i.id === "c1" ? { ...i, rev: 8 } : i));
    const r = await seeded({ walks: [walk(), bumped], refuseStaleRev: true });
    const renaming = r.outline.rename("c1", "New");
    const marking = r.outline.setState("c1", "done");
    expect(await renaming).toBe("applied");
    expect(await marking).toBe("applied");
    expect(r.failures).toHaveLength(0);
  });
});

describe("createOutline: move", () => {
  test("sends the planned neighbours and the rev, in camelCase", async () => {
    // `newParentId` and `afterId` are both Option args - see the create case.
    const r = await seeded();
    expect(await r.outline.move("s2", "up")).toBe("applied");
    expect(argsOf(r, "item_move")).toEqual({
      id: "s2",
      newParentId: "c1",
      afterId: null,
      baseRev: 1,
    });
  });

  test("a non-null afterId is carried through", async () => {
    const r = await seeded();
    await r.outline.move("s1", "down");
    expect(argsOf(r, "item_move")).toEqual({
      id: "s1",
      newParentId: "c1",
      afterId: "s2",
      baseRev: 1,
    });
  });

  test("an inert direction performs no IPC", async () => {
    const r = await seeded();
    expect(await r.outline.move("s1", "up")).toBe("inert");
    expect(r.calls).toHaveLength(0);
    expect(r.failures).toHaveLength(0);
  });

  test("an id absent from the walk fails rather than reading as inert", async () => {
    // planMove returns null for an unknown id, which would otherwise report
    // "nothing to do" for what is actually a page bug.
    const r = await seeded();
    expect(await r.outline.move("ghost", "down")).toBe("failed");
    expect(r.calls).toHaveLength(0);
    expect(r.failures).toHaveLength(1);
  });

  test("command, then re-read, then reload - in that order", async () => {
    const r = await seeded();
    await r.outline.move("s1", "down");
    expect(r.log).toEqual(["item_move", "project_items", "reload"]);
  });

  test("a walk naming a parent it does not contain is LOUD, not inert", async () => {
    // planMove refuses a malformed walk for the same reason it refuses a move
    // with no destination, and reporting both as "inert" makes "the store and
    // the page disagree about the shape of the manuscript" indistinguishable
    // from Alt+Up on the first sibling.
    const orphaned = [
      item("p1", null, 0, 1, "p1", "part"),
      item("lost", "vanished", 1),
    ];
    const r = await seeded({ walks: [orphaned] });
    expect(await r.outline.move("lost", "outdent")).toBe("failed");
    expect(r.calls.some((c) => c.cmd === "item_move")).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("lost");
  });
});

describe("createOutline: overlapping operations", () => {
  //   p1 > c1 > s1 s2 s3
  const three = (order: string[], revs: Record<string, number> = {}): ProjectItem[] => [
    item("p1", null, 0, 1, "p1", "part"),
    item("c1", "p1", 1, 7, "c1", "chapter"),
    ...order.map((id) => item(id, "c1", 2, revs[id] ?? 1)),
  ];

  test("a held Alt+ArrowDown applies twice, each planned against the refreshed walk", async () => {
    // The writer holds the key: ~30 keydowns a second, all of them before the
    // first round trip returns. Unserialized, every one after the first reads
    // `rev` and the sibling order from the same pre-mutation walk, so the store
    // refuses it as a Conflict - a red banner and a full reprojection each -
    // and the row moves exactly one place.
    const r = await seeded({
      refuseStaleRev: true,
      walks: [
        three(["s1", "s2", "s3"]),
        three(["s2", "s1", "s3"], { s1: 2 }),
        three(["s2", "s3", "s1"], { s1: 3 }),
      ],
    });

    // Not awaited between the two: that is the whole gesture.
    const first = r.outline.move("s1", "down");
    const second = r.outline.move("s1", "down");
    expect(await first).toBe("applied");
    // "inert" is the OTHER shape of this defect: the second call reads the
    // stale walk, finds s1 still last-but-one... or already last, and drops the
    // writer's edit with no IPC and no banner.
    expect(await second).toBe("applied");

    const moves = r.calls.filter((c) => c.cmd === "item_move");
    expect(moves).toHaveLength(2);
    expect(moves[0]?.args).toEqual({
      id: "s1", newParentId: "c1", afterId: "s2", baseRev: 1,
    });
    // The refreshed rev AND the refreshed sibling order. Either one stale is a
    // Conflict from the real store.
    expect(moves[1]?.args).toEqual({
      id: "s1", newParentId: "c1", afterId: "s3", baseRev: 2,
    });
    expect(r.failures).toEqual([]);
    expect(r.log).toEqual([
      "item_move", "project_items", "reload",
      "item_move", "project_items", "reload",
    ]);
  });

  test("a create and a rename queued together both see their own walk", async () => {
    // Same guarantee across different operations: the rename must read the rev
    // the create's re-read reported, not the one from before it.
    const bumped = walk().map((i) => (i.id === "c1" ? { ...i, rev: 42 } : i));
    const r = await seeded({
      refuseStaleRev: true,
      selected: "c1",
      walks: [walk(), bumped],
    });
    const created = r.outline.create("scene");
    const renamed = r.outline.rename("c1", "New");
    expect(await created).toBe("applied");
    expect(await renamed).toBe("applied");
    expect(argsOf(r, "item_rename")).toEqual({ id: "c1", title: "New", baseRev: 42 });
    expect(r.failures).toEqual([]);
  });

  test("a failing operation does not poison the one queued behind it", async () => {
    const r = await seeded({ rejectOn: "item_rename", rejectAfter: 1 });
    const failing = r.outline.rename("c1", "New");
    const following = r.outline.move("s1", "down");
    expect(await failing).toBe("failed");
    expect(await following).toBe("applied");
  });
});

describe("createOutline: failure", () => {
  test("a failing command still re-reads the walk", async () => {
    // The command may have committed before the failure reached us, and a screen
    // showing a tree that no longer exists is worse than a slow one.
    const r = await seeded({ rejectOn: "item_rename" });
    expect(await r.outline.rename("c1", "New")).toBe("failed");
    expect(r.log).toEqual(["item_rename", "project_items", "reload"]);
    expect(r.failures).toHaveLength(1);
  });

  test("onFailure carries the underlying message", async () => {
    const r = await seeded({
      rejectOn: "item_rename",
      rejectWith: new Error("conflict: item c1"),
    });
    await r.outline.rename("c1", "New");
    expect(r.failures[0]).toContain("conflict: item c1");
  });

  test("a reload that throws leaves the unit holding the walk the navigator shows", async () => {
    // storeSourceFrom throws on an empty array and project() panics on a
    // malformed walk, so `reload` really can throw. Committing the fresh walk
    // before it ran left this unit planning against a tree the navigator was
    // not displaying - reported, but still two views of one manuscript.
    const after = [...walk(), item("s3", "c1", 2, 3)];
    const r = rig({ walks: [walk(), after] });
    await r.outline.refresh();
    const boom = new Error("the navigator refused the walk");
    let thrown = 0;
    const outline = createOutline({
      invoke: async (cmd) => (cmd === "project_items" ? after : {}),
      reload: () => {
        thrown++;
        throw boom;
      },
      selectedId: () => null,
      onCreated: () => undefined,
      onFailure: () => undefined,
      onDone: () => undefined,
      initialItems: walk(),
    });
    expect(await outline.refresh()).toBe("failed");
    expect(thrown).toBe(1);
    expect(outline.items().map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "p2"]);
  });

  test("a failing re-read fails without reloading", async () => {
    // rejectAfter 1 lets the seeding read through, so the failure under test is
    // the re-read and not the boot.
    const r = await seeded({ rejectOn: "project_items", rejectAfter: 1 });
    expect(await r.outline.rename("c1", "New")).toBe("failed");
    expect(r.reloads).toHaveLength(0);
    expect(r.failures).toHaveLength(1);
    expect(r.log).toEqual(["item_rename", "project_items"]);
  });

  test("a failing command AND a failing re-read report once, not twice", async () => {
    // Two banners for one broken action tell the writer nothing extra, and the
    // second would be about the recovery rather than about the edit that failed.
    const r = await seeded({ rejectOn: ["item_rename", "project_items"], rejectAfter: 1 });
    expect(await r.outline.rename("c1", "New")).toBe("failed");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("item_rename");
    expect(r.reloads).toHaveLength(0);
  });
});

describe("createOutline: construction", () => {
  test("initialItems seeds the walk with no IPC at all", async () => {
    // mountProject already read this walk to build the navigator. At the stress
    // fixture that is 20,060 rows, so a refresh() at boot would pay for the same
    // rows twice and learn nothing.
    const r = rig({ initialItems: walk() });
    expect(r.calls).toHaveLength(0);
    expect(await r.outline.rename("c1", "New")).toBe("applied");
    // Exactly the mutation's own two calls: no read happened before them.
    expect(r.log).toEqual(["item_rename", "project_items", "reload"]);
    expect(argsOf(r, "item_rename")).toEqual({ id: "c1", title: "New", baseRev: 7 });
  });

  test("does NOT reload at construction", () => {
    // The navigator was built from this same walk and already displays it. A
    // reload here costs a reprojection for nothing and, worse, resets the
    // reader's selection to the top of the manuscript.
    const r = rig({ initialItems: walk() });
    expect(r.reloads).toHaveLength(0);
    expect(r.log).toHaveLength(0);
  });

  test("items() reflects initialItems immediately", () => {
    const r = rig({ initialItems: walk() });
    expect(r.outline.items().map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "p2"]);
  });

  test("a caller mutating the array it passed cannot corrupt the unit", async () => {
    // Same copy discipline as items(). The caller keeps its own reference - the
    // navigator's source holds one - and every base_rev is read from this walk.
    const passed = walk();
    const r = rig({ initialItems: passed });
    passed.length = 0;
    passed.push(item("junk", null, 0));
    expect(r.outline.items().map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "p2"]);
    await r.outline.rename("c1", "New");
    expect(argsOf(r, "item_rename")).toEqual({ id: "c1", title: "New", baseRev: 7 });
  });

});

describe("createOutline: destroy", () => {
  /** A gate a test can open by hand. */
  function gated(): { gate: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { gate, open };
  }

  test("an operation resolving AFTER destroy reloads nothing", async () => {
    // navigator.reload after destroy() does not throw, and the navigator's
    // container is still #nav - the element the NEXT project has just mounted
    // into. The dead project's walk would set the live navigator's scrollTop
    // and point its aria-activedescendant at a row computed from a tree nobody
    // is looking at.
    const { gate, open } = gated();
    const r = rig({ initialItems: walk(), gate });
    const inFlight = r.outline.move("s2", "up");
    r.outline.destroy();
    open();
    expect(await inFlight).toBe("applied");
    expect(r.reloads).toEqual([]);
  });

  test("a failure resolving AFTER destroy raises nothing", async () => {
    // Same corruption with a banner instead of a walk: raiseNotice prepends to
    // document.body, which destroy() has already swept, so the new manuscript
    // would carry the dead one's error.
    const { gate, open } = gated();
    const r = rig({ initialItems: walk(), gate, rejectOn: ["item_move", "project_items"] });
    const inFlight = r.outline.move("s2", "up");
    r.outline.destroy();
    open();
    expect(await inFlight).toBe("failed");
    expect(r.failures).toEqual([]);
    expect(r.reloads).toEqual([]);
  });

  test("a synchronous failure after destroy raises nothing either", async () => {
    // The lookup failures report without any IPC at all, so they take a
    // different path out of the unit than the one above.
    const r = rig({ initialItems: walk() });
    r.outline.destroy();
    expect(await r.outline.move("ghost", "down")).toBe("failed");
    expect(await r.outline.rename("ghost", "New")).toBe("failed");
    expect(r.failures).toEqual([]);
  });

  test("destroy is idempotent", () => {
    const r = rig({ initialItems: walk() });
    r.outline.destroy();
    expect(() => r.outline.destroy()).not.toThrow();
  });
});

describe("createOutline: items", () => {
  test("returns the last read walk", async () => {
    const r = await seeded();
    expect(r.outline.items().map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "p2"]);
  });

  test("is empty before the first read", () => {
    expect(rig().outline.items()).toHaveLength(0);
  });

  test("a caller mutating the returned array cannot corrupt the unit", async () => {
    const r = await seeded();
    const taken = r.outline.items() as ProjectItem[];
    taken.length = 0;
    taken.push(item("junk", null, 0));
    expect(r.outline.items().map((i) => i.id)).toEqual(["p1", "c1", "s1", "s2", "p2"]);
    // And the rev lookup still works, which is what a corrupted walk would break.
    await r.outline.rename("c1", "New");
    expect(argsOf(r, "item_rename")).toEqual({ id: "c1", title: "New", baseRev: 7 });
  });
});

// The bin walks. Each is the whole tree as the store would report it after one
// more mutation, because the rig advances its state per mutation rather than
// per read.
const BIN = "bin";
const withBin = (): ProjectItem[] => [
  ...walk(),
  item(BIN, null, 0, 1, "Trash", "trash"),
];
const s1InBin = (): ProjectItem[] => [
  item("p1", null, 0, 1, "p1", "part"),
  item("c1", "p1", 1, 7, "c1", "chapter"),
  item("s2", "c1", 2),
  item("p2", null, 0, 1, "p2", "part"),
  item(BIN, null, 0, 1, "Trash", "trash"),
  item("s1", BIN, 1),
];

describe("createOutline: remove", () => {
  test("creates the bin at the root, then moves the item into it", async () => {
    const r = await seeded({ walks: [walk(), withBin(), s1InBin()] });

    expect(await r.outline.remove("s1")).toBe("applied");

    // The ORDER is the claim, and only an ordering assertion can see it: the
    // bin has to exist before anything can be moved into it, and every end
    // state is identical either way.
    expect(r.log).toEqual([
      "item_create", "project_items", "reload",
      "item_move", "project_items", "reload",
    ]);
    expect(argsOf(r, "item_create")).toEqual({
      parentId: null,
      itemType: "trash",
      title: "Trash",
    });
    expect(argsOf(r, "item_move")).toEqual({
      id: "s1",
      newParentId: BIN,
      afterId: null,
      baseRev: 1,
    });
  });

  test("reuses a bin that already exists", async () => {
    const r = await seeded({ walks: [withBin(), s1InBin()] });

    expect(await r.outline.remove("s1")).toBe("applied");

    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(0);
    expect(argsOf(r, "item_move")?.["newParentId"]).toBe(BIN);
  });

  test("two deletes in flight at once create ONE bin, not two", async () => {
    // The reason find-or-create and the move share a single serialized body. A
    // held Delete fires around thirty keydowns a second; unserialized, each
    // would look for a bin, find none, and create one. The store defines the
    // two-bin case (the first wins) rather than refusing it, so the second
    // bin's contents would sit outside the manuscript AND outside the bin the
    // page uses - deleted twice over and invisible to both.
    const r = await seeded({ walks: [walk(), withBin(), s1InBin()] });

    const both = Promise.all([r.outline.remove("s1"), r.outline.remove("s2")]);
    expect(await both).toEqual(["applied", "applied"]);

    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(1);
    expect(r.calls.filter((c) => c.cmd === "item_move")).toHaveLength(2);
  });

  test("the bin itself cannot be deleted, and sends no IPC", async () => {
    const r = await seeded({ walks: [withBin()] });

    expect(await r.outline.remove(BIN)).toBe("inert");

    expect(r.calls).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  test("an item already in the bin is inert, at any depth", async () => {
    // A DEEP case, not `parent_id === bin`. Deleting a chapter takes its scenes
    // with it, so those scenes are grandchildren of the bin - and they are
    // visible, selectable rows a writer can press Delete on. A parent check
    // would send them through a second, pointless move.
    const deep = (): ProjectItem[] => [
      item(BIN, null, 0, 1, "Trash", "trash"),
      item("c1", BIN, 1, 7, "c1", "chapter"),
      item("s1", "c1", 2),
    ];
    const r = await seeded({ walks: [deep()] });

    expect(await r.outline.remove("s1")).toBe("inert");
    expect(r.calls).toEqual([]);
  });

  test("reports an id the outline no longer holds instead of inventing a rev", async () => {
    const r = await seeded();

    expect(await r.outline.remove("gone")).toBe("failed");

    expect(r.calls).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("gone");
  });

  test("sends the rev the walk holds AFTER the bin was created", async () => {
    // Creating the bin re-reads the whole walk. A rev captured before that read
    // is planned against a tree that no longer exists, which is the stale-plan
    // defect the serialization exists to remove - and here it would be a
    // Conflict on the writer's very first delete.
    const bumped = (): ProjectItem[] => [
      ...walk().filter((i) => i.id !== "s1"),
      item("s1", "c1", 2, 9),
      item(BIN, null, 0, 1, "Trash", "trash"),
    ];
    const r = await seeded({ walks: [walk(), bumped(), s1InBin()], refuseStaleRev: true });

    expect(await r.outline.remove("s1")).toBe("applied");

    expect(argsOf(r, "item_move")?.["baseRev"]).toBe(9);
    expect(r.failures).toEqual([]);
  });

  test("a second delete lands after the first, so the bin reads oldest-first", async () => {
    const afterSecondDelete = (): ProjectItem[] => [
      item("p1", null, 0, 1, "p1", "part"),
      item("c1", "p1", 1, 7, "c1", "chapter"),
      item("p2", null, 0, 1, "p2", "part"),
      item(BIN, null, 0, 1, "Trash", "trash"),
      item("s1", BIN, 1, 1),
      item("s2", BIN, 1, 2),
    ];
    const r = await seeded({ walks: [s1InBin(), afterSecondDelete()] });

    expect(await r.outline.remove("s2")).toBe("applied");

    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(0);
    expect(argsOf(r, "item_move")).toEqual({
      id: "s2",
      newParentId: BIN,
      afterId: "s1",
      baseRev: 1,
    });
  });
});

/** s1 restored to the manuscript root: AFTER the last manuscript root (p2)
 *  and BEFORE the bin. A null `afterId` on `item_move` is FIRST, not last
 *  (store/mod.rs's `moving_to_the_front_uses_a_null_left_neighbour`), so
 *  landing here means `restore()` named p2 -- not that it appended. */
const s1AfterBin = (): ProjectItem[] => [
  item("p1", null, 0, 1, "p1", "part"),
  item("c1", "p1", 1, 7, "c1", "chapter"),
  item("s2", "c1", 2),
  item("p2", null, 0, 1, "p2", "part"),
  item("s1", null, 0, 2),
  item(BIN, null, 0, 1, "Trash", "trash"),
];

describe("front and back reading order", () => {
  const lateFront = (): ProjectItem[] => [
    item("part1", null, 0, 1, "Part 1", "part"),
    item("scene1", "part1", 1),
    item("front", null, 0, 1, "Front", FRONT_MATTER_TYPE),
    item("dedication", "front", 1, 1, "Dedication", MATTER_TYPE),
    item("part2", null, 0, 1, "Part 2", "part"),
    item("scene2", "part2", 1),
    item("back", null, 0, 1, "Back", BACK_MATTER_TYPE),
  ];

  test("projects late matter roots with intact subtrees and leaves stored order alone", () => {
    const rows = lateFront();
    expect(readingOrderItems(rows).map((row) => row.id)).toEqual([
      "front", "dedication", "part1", "scene1", "part2", "scene2", "back",
    ]);
    expect(rows[0]?.id).toBe("part1");
    expect(manuscriptItemsIn(rows).map((row) => row.id)).toEqual(
      readingOrderItems(rows).map((row) => row.id),
    );
  });

  test("only first section roots are special; duplicate roots remain ordinary rows", () => {
    const rows = [
      ...lateFront(),
      item("front2", null, 0, 1, "Another front", FRONT_MATTER_TYPE),
      item("ordinary", "front2", 1),
      item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
      item("note", "bible", 1, 1, "Note", NOTE_TYPE),
      item("bible2", null, 0, 1, "Another bible", BIBLE_TYPE),
      item("kept", "bible2", 1),
    ];
    expect(manuscriptItemsIn(rows).map((row) => row.id)).toEqual([
      "front", "dedication", "part1", "scene1", "part2", "scene2",
      "front2", "ordinary", "bible2", "kept", "back",
    ]);
  });

  test("root movement translates projected neighbors back into store anchors", () => {
    const rows = lateFront();
    expect(planMove(rows, "part2", "up")).toEqual({
      kind: "move", target: { newParentId: null, afterId: null },
    });
    expect(planMove(rows, "part1", "down")).toEqual({
      kind: "move", target: { newParentId: null, afterId: "part2" },
    });
    expect(planMove(rows, "part1", "up")).toEqual({ kind: "inert" });
    expect(planMove(rows, "front", "down")).toEqual({ kind: "inert" });
    expect(planMove(rows, "back", "up")).toEqual({ kind: "inert" });
  });

  test("canceling a section change sends no store mutation", async () => {
    const changes: unknown[] = [];
    const rows = lateFront();
    const r = await seeded({
      walks: [rows],
      confirmSectionMove: async (_title, change) => {
        changes.push(change);
        return false;
      },
    });
    expect(sectionChange(rows, "part1", { newParentId: "front", afterId: "dedication" })).toEqual({
      count: 2, from: "body", to: "front",
    });
    expect(await r.outline.move("part1", "indent")).toBe("inert");
    expect(changes).toEqual([{ count: 2, from: "body", to: "front" }]);
    expect(r.calls).toEqual([]);
  });

  test("canceling an undo of a section move keeps the undo entry", async () => {
    const before = lateFront();
    const after = before.map((row) => row.id === "part1"
      ? { ...row, parent_id: "front", depth: 1, rev: 2 }
      : row.id === "scene1" ? { ...row, depth: 2 } : row);
    let answer = true;
    const r = await seeded({
      walks: [before, after],
      confirmSectionMove: async () => answer,
    });
    expect(await r.outline.move("part1", "indent")).toBe("applied");
    expect(r.outline.canUndo()).toBe(true);
    r.calls.length = 0;
    answer = false;
    expect(await r.outline.undo()).toBe("inert");
    expect(r.calls).toEqual([]);
    expect(r.outline.canUndo()).toBe(true);
  });
});

describe("createOutline: restore", () => {
  test("moves the item after the last manuscript root and never touches the bin", async () => {
    const r = await seeded({ walks: [s1InBin(), s1AfterBin()] });

    expect(await r.outline.restore("s1")).toBe("applied");

    // ONE item_move, not two: nothing here re-sinks the bin, because the bin
    // never moved in the first place.
    expect(r.log).toEqual(["item_move", "project_items", "reload"]);
    expect(argsOf(r, "item_move")).toEqual({
      id: "s1",
      newParentId: null,
      afterId: "p2",
      baseRev: 1,
    });
  });

  test("with the bible after the parts, afterId is still the last part, not the bible", async () => {
    const withBible = (): ProjectItem[] => [
      item("p1", null, 0, 1, "p1", "part"),
      item("p2", null, 0, 1, "p2", "part"),
      item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
      item(BIN, null, 0, 1, "Trash", "trash"),
      item("s1", BIN, 1),
    ];
    const after = (): ProjectItem[] => [
      item("p1", null, 0, 1, "p1", "part"),
      item("p2", null, 0, 1, "p2", "part"),
      item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
      item("s1", null, 0, 2),
      item(BIN, null, 0, 1, "Trash", "trash"),
    ];
    const r = await seeded({ walks: [withBible(), after()] });

    expect(await r.outline.restore("s1")).toBe("applied");

    expect(argsOf(r, "item_move")?.["afterId"]).toBe("p2");
  });

  test("with only the bin at root, afterId is null", async () => {
    const onlyBin = (): ProjectItem[] => [
      item(BIN, null, 0, 1, "Trash", "trash"),
      item("s1", BIN, 1),
    ];
    const after = (): ProjectItem[] => [
      item("s1", null, 0, 2),
      item(BIN, null, 0, 1, "Trash", "trash"),
    ];
    const r = await seeded({ walks: [onlyBin(), after()] });

    expect(await r.outline.restore("s1")).toBe("applied");

    expect(argsOf(r, "item_move")?.["afterId"]).toBe(null);
  });

  test("a row that is not in the bin is inert, and sends no IPC", async () => {
    const r = await seeded({ walks: [withBin()] });

    expect(await r.outline.restore("s1")).toBe("inert");

    expect(r.calls).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  test("the bin itself cannot be restored", async () => {
    // isTrashed is true of the bin as well as its contents, so the guard above
    // does not catch this one - the bin is not a manuscript item and has
    // nowhere to be returned to.
    const r = await seeded({ walks: [withBin()] });

    expect(await r.outline.restore(BIN)).toBe("inert");

    expect(r.calls).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  test("restores a row nested inside a deleted chapter, leaving the chapter", async () => {
    // The writer selected the scene, so the scene is what comes back. A
    // parent_id === bin check would have called this untrashed and refused it.
    const deep = (): ProjectItem[] => [
      item("p1", null, 0, 1, "p1", "part"),
      item(BIN, null, 0, 3, "Trash", "trash"),
      item("c1", BIN, 1, 7, "c1", "chapter"),
      item("s1", "c1", 2),
    ];
    const after = (): ProjectItem[] => [
      item("p1", null, 0, 1, "p1", "part"),
      item(BIN, null, 0, 3, "Trash", "trash"),
      item("c1", BIN, 1, 7, "c1", "chapter"),
      item("s1", null, 0, 2),
    ];
    const r = await seeded({ walks: [deep(), after(), after()] });

    expect(await r.outline.restore("s1")).toBe("applied");

    const moves = r.calls.filter((c) => c.cmd === "item_move");
    expect(moves[0]?.args?.["id"]).toBe("s1");
    expect(moves[0]?.args?.["newParentId"]).toBeNull();
    // The chapter stays where it is. Nothing in this operation touches it.
    expect(moves.some((c) => c.args?.["id"] === "c1")).toBe(false);
  });

  test("an id the outline does not hold is inert, not a failure", async () => {
    // Unlike remove, which reports it. An id that is absent is not in the bin,
    // so it takes the same path a live row takes, and a writer pressing a
    // button that says Restore on a row that vanished under them gets nothing
    // rather than a banner about an id.
    const r = await seeded({ walks: [withBin()] });

    expect(await r.outline.restore("gone")).toBe("inert");
    expect(r.calls).toEqual([]);
    expect(r.failures).toEqual([]);
  });
});

describe("isTrashedIn", () => {
  test("true for the bin and for anything inside it, false for the manuscript", () => {
    const walk = s1InBin();

    expect(isTrashedIn(walk, BIN)).toBe(true);
    expect(isTrashedIn(walk, "s1")).toBe(true);
    expect(isTrashedIn(walk, "s2")).toBe(false);
    expect(isTrashedIn(walk, "p1")).toBe(false);
  });

  test("true for a grandchild of the bin", () => {
    // Deleting a chapter takes its scenes with it, so they are grandchildren.
    // A parent_id === bin check would call them untrashed.
    const deep: ProjectItem[] = [
      item(BIN, null, 0, 1, "Trash", "trash"),
      item("c1", BIN, 1, 7, "c1", "chapter"),
      item("s1", "c1", 2),
    ];

    expect(isTrashedIn(deep, "s1")).toBe(true);
  });

  test("false for an id the walk does not hold", () => {
    // The same answer a live row gets, deliberately: a caller cannot act on
    // either, and the bar's one control offers Delete for both.
    expect(isTrashedIn(s1InBin(), "gone")).toBe(false);
  });

  test("terminates on a parent chain that does not", () => {
    // The bound, not the chain, is what ends this loop. The store refuses to
    // walk a cycle so one cannot arrive today; the guard does not depend on
    // that staying true.
    const cyclic: ProjectItem[] = [item("a", "b", 0), item("b", "a", 0)];

    expect(isTrashedIn(cyclic, "a")).toBe(false);
  });

  test("answers about the walk it is HANDED, not about any other", () => {
    // The whole reason this is a free function. The page calls it with the
    // walk a reload is still carrying, because the outline unit has not
    // committed that walk to its own field yet - and asking the unit painted
    // "Delete" on a row that had just been deleted.
    const before = withBin();
    const after = s1InBin();

    expect(isTrashedIn(before, "s1")).toBe(false);
    expect(isTrashedIn(after, "s1")).toBe(true);
  });
});

describe("createOutline: the book's first part adopts the loose chapters", () => {
  // THE RULE: "chapters inside parts, scenes inside
  // chapters". Every new book opens with a chapter, so the first
  // New part in ANY book meets a chapter at the root -- and a part created
  // beside it is the empty, misfiled part photographed twice.
  //
  //   Chapter 1 (rev 3)
  //     Scene 1
  //   Chapter 2 (rev 5)
  const loose = (): ProjectItem[] => [
    item("ch1", null, 0, 3, "Chapter 1", "chapter"),
    item("s1", "ch1", 1, 1, "Scene 1"),
    item("ch2", null, 0, 5, "Chapter 2", "chapter"),
  ];
  const moves = (r: Rig): Call[] => r.calls.filter((c) => c.cmd === "item_move");

  for (const requested of ["part", "chapter"]) {
    test(`unsafe adoption still creates the requested ${requested} without moving existing rows`, async () => {
      const mixed = loose();
      mixed.splice(2, 0, item("loose", null, 0));
      const r = await seeded({ walks: [mixed], selected: "ch2" });
      expect(await r.outline.create(requested)).toBe("applied");
      expect(moves(r)).toEqual([]);
      expect(r.calls.filter((c) => c.cmd === "item_create").map((c) => c.args?.["itemType"]))
        .toEqual(requested === "part" ? ["part"] : ["part", "chapter"]);
      expect(r.created).toEqual([requested === "part" ? "made-1" : "made-2"]);
      expect(r.failures).toEqual([]);
      expect(r.done).toEqual(["Added. Existing chapters stayed in place because moving them into the new part would change the reading order. You can move them manually."]);
    });
  }

  test("a contiguous chapter block cannot jump past a loose scene on create", async () => {
    const r = await seeded({ walks: [[...loose(), item("last", null, 0)]], selected: "last" });
    expect(await r.outline.create("part")).toBe("applied");
    expect(moves(r)).toEqual([]);
    expect(r.done).toHaveLength(1);
  });

  test("a reserved section between chapters does not change their reading order", async () => {
    const mixed = loose();
    mixed.splice(2, 0, item("bible", null, 0, 1, "Bible", BIBLE_TYPE));
    const r = await seeded({ walks: [mixed], selected: "ch2" });
    expect(await r.outline.create("part")).toBe("applied");
    expect(moves(r).map((m) => m.args?.["id"])).toEqual(["ch1", "ch2"]);
    expect(r.done).toEqual([]);
  });

  test("undo of skipped adoption bins only the new part", async () => {
    const mixed = [...loose(), item("last", null, 0), item(BIN, null, 0, 1, "Trash", "trash")];
    const afterCreate = [...mixed, item("made-1", null, 0, 1, "Part 1", "part")];
    const r = await seeded({ walks: [mixed, afterCreate], selected: "last" });
    expect(await r.outline.create("part")).toBe("applied");
    expect(r.outline.canUndo()).toBe(true);
    expect(await r.outline.undo()).toBe("applied");
    expect(moves(r).map((m) => m.args?.["id"])).toEqual(["made-1"]);
    expect(moves(r)[0]?.args?.["newParentId"]).toBe(BIN);
  });

  test("failed create does not announce that chapters were kept in place", async () => {
    const r = await seeded({ walks: [[...loose(), item("last", null, 0)]], selected: "last", rejectOn: "item_create" });
    expect(await r.outline.create("part")).toBe("failed");
    expect(moves(r)).toEqual([]);
    expect(r.done).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });

  test("moves them inside it, in order, each after the last", async () => {
    const r = await seeded({ walks: [loose()], selected: "ch2" });
    expect(await r.outline.create("part")).toBe("applied");
    // `newParentId` is the id the FAKE answered the create with, which is what
    // makes this an assertion about the wiring rather than about the plan.
    // `afterId` chains so the adopted chapters keep their relative order; a
    // build that sent null for both would reverse the book.
    expect(moves(r).map((m) => m.args)).toEqual([
      { id: "ch1", newParentId: "made-1", afterId: null, baseRev: 3 },
      { id: "ch2", newParentId: "made-1", afterId: "ch1", baseRev: 5 },
    ]);
  });

  test("the part is created BEFORE anything moves into it", async () => {
    const r = await seeded({ walks: [loose()], selected: "ch2" });
    await r.outline.create("part");
    expect(r.log).toEqual([
      "item_create",
      "project_items",
      "reload",
      "item_move",
      "project_items",
      "reload",
      "item_move",
      "project_items",
      "reload",
    ]);
  });

  test("the selection follows the part, once the chapters are in it", async () => {
    const r = await seeded({ walks: [loose()], selected: "ch2" });
    await r.outline.create("part");
    expect(r.created).toEqual(["made-1"]);
  });

  test("a chapter press that builds its own part adopts through it", async () => {
    // The holder is a part like any other. Without this the commonest way a
    // book gets its first part -- pressing New chapter -- would leave every
    // other chapter outside it.
    const r = await seeded({ walks: [loose()], selected: "s1" });
    await r.outline.create("chapter");
    expect(moves(r).map((m) => m.args?.["id"])).toEqual(["ch1", "ch2"]);
    // Into the PART, which is `made-1`; the chapter the writer asked for is
    // `made-2` and adopts nothing.
    expect(moves(r).every((m) => m.args?.["newParentId"] === "made-1")).toBe(true);
  });

  test("a book that already has a part moves nothing", async () => {
    // The control, and the bound on the whole rule: adoption happens at most
    // once in the life of a manuscript. `walk()` opens with a part.
    const r = await seeded({ selected: "s1" });
    await r.outline.create("part");
    expect(moves(r)).toEqual([]);
  });

  test("a part the writer DELETED does not count as the book having one", async () => {
    // The walk this unit holds includes the bin and everything in it, so the
    // "has this book got a part already" question has to be asked of the LIVE
    // manuscript. A part in the bin is one the writer threw away; letting it
    // suppress adoption would make a book behave differently forever because
    // of a row nobody can see.
    //
    // THIS IS THE FIXTURE THAT NEEDS `liveItemsIn`, and the first one did not:
    // it used a deleted CHAPTER, which the bin holds as a child of itself, so
    // the root-level filter already excluded it and dropping the strip entirely
    // survived the mutation pass. A trashed chapter is still not adopted, and
    // `planAdoption`'s parent filter is what says so.
    const binned: ProjectItem[] = [
      item("ch1", null, 0, 3, "Chapter 1", "chapter"),
      item("bin", null, 0, 1, "Deleted", "trash"),
      item("gone", "bin", 1, 1, "Part 1", "part"),
      item("goneCh", "bin", 1, 1, "Chapter 9", "chapter"),
    ];
    const r = await seeded({ walks: [binned], selected: "ch1" });
    await r.outline.create("part");
    expect(moves(r).map((m) => m.args?.["id"])).toEqual(["ch1"]);
  });

  test("a chapter that vanished between the plan and the move is skipped, not reported", async () => {
    // The re-read after the create is where the walk can change: another agent,
    // a restore, a `project_items` that no longer holds the row. The writer
    // asked for a part, not for this chapter, so a banner about it would be
    // about something they did not do -- and the chapters that ARE still there
    // still belong inside it.
    const without: ProjectItem[] = loose().filter((i) => i.id !== "ch1");
    const r = await seeded({ walks: [loose(), without], selected: "ch2" });
    expect(await r.outline.create("part")).toBe("applied");
    expect(moves(r).map((m) => m.args)).toEqual([
      { id: "ch2", newParentId: "made-1", afterId: null, baseRev: 5 },
    ]);
    expect(r.failures).toEqual([]);
  });

  test("a move the store refused stops the sequence and leaves what landed", async () => {
    // The same rule the holders follow: unwinding would be another write on a
    // path that has just said writes are failing. The writer is left with a
    // part holding the first chapter, both of which they can see and move.
    const r = await seeded({ walks: [loose()], selected: "ch2", rejectOn: "item_move" });
    expect(await r.outline.create("part")).toBe("failed");
    expect(moves(r).map((m) => m.args?.["id"])).toEqual(["ch1"]);
    // No selection move: the press did not finish, and the failure banner is
    // about the tree the writer is looking at.
    expect(r.created).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });

  test("undo still has a way back when the adoption dies partway through (review fixup)", async () => {
    // ch1 lands inside the part; ch2's move is refused. The holder and ch1's
    // move are real structural changes the writer cannot see any other way
    // to take back, so undo must still cover them - not just the presses
    // that finished cleanly. A bin exists throughout, so undo needs no
    // item_create of its own and every id in this trace stays predictable.
    const looseWithBin = (): ProjectItem[] => [...loose(), item(BIN, null, 0, 1, "Trash", "trash")];
    const afterPartCreate = (): ProjectItem[] => [
      ...looseWithBin(),
      item("made-1", null, 0, 1, "Part 1", "part"),
    ];
    const afterCh1Move = (): ProjectItem[] => [
      item("made-1", null, 0, 1, "Part 1", "part"),
      item("ch1", "made-1", 1, 4, "Chapter 1"),
      item("s1", "ch1", 2, 1, "Scene 1"),
      item("ch2", null, 0, 5, "Chapter 2", "chapter"),
      item(BIN, null, 0, 1, "Trash", "trash"),
    ];
    // undo's first step: ch1 back to the root.
    const ch1Restored = (): ProjectItem[] => [
      item("ch1", null, 0, 5, "Chapter 1"),
      item("s1", "ch1", 1, 1, "Scene 1"),
      item("made-1", null, 0, 1, "Part 1", "part"),
      item("ch2", null, 0, 5, "Chapter 2", "chapter"),
      item(BIN, null, 0, 1, "Trash", "trash"),
    ];
    // undo's second and last step: the now-empty part binned.
    const partBinned = (): ProjectItem[] => [
      item("ch1", null, 0, 5, "Chapter 1"),
      item("s1", "ch1", 1, 1, "Scene 1"),
      item("ch2", null, 0, 5, "Chapter 2", "chapter"),
      item(BIN, null, 0, 1, "Trash", "trash"),
      item("made-1", BIN, 1, 2, "Part 1", "part"),
    ];
    // A BESPOKE invoke, not the shared rig: `rejectOn`/`rejectAfter` there
    // reject a command for the rest of the rig's life once tripped, which
    // would also refuse undo's OWN moves. Only ch2's adoption move is
    // supposed to fail here.
    const walksSeq = [looseWithBin(), afterPartCreate(), afterCh1Move(), ch1Restored(), partBinned()];
    let state = 0;
    const stateWalk = (): ProjectItem[] => walksSeq[Math.min(state, walksSeq.length - 1)] ?? [];
    const calls: Call[] = [];
    const failures: string[] = [];
    const invoke: OutlineDeps["invoke"] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "project_items") return stateWalk();
      if (cmd === "item_move" && args?.["id"] === "ch2") throw new Error("item_move exploded");
      if (cmd === "item_create" || cmd === "item_move" || cmd === "item_rename" || cmd === "item_set_state") {
        state++;
        if (cmd === "item_create") return { id: `made-${state}`, position: "0", rev: 1 };
      }
      return {};
    };
    const outline = createOutline({
      invoke,
      reload: () => undefined,
      selectedId: () => "ch2",
      onCreated: () => undefined,
      onFailure: (message) => failures.push(message),
      onDone: () => undefined,
      initialItems: looseWithBin(),
    });
    const movesOf = (): Call[] => calls.filter((c) => c.cmd === "item_move");

    expect(await outline.create("part")).toBe("failed");
    expect(movesOf().map((m) => m.args?.["id"])).toEqual(["ch1", "ch2"]);
    expect(outline.canUndo()).toBe(true);

    expect(await outline.undo()).toBe("applied");
    const undoMoves = movesOf().slice(2);
    // ONLY ch1 comes back - ch2 was never adopted, so undo has nothing of
    // its to reverse. Then the part itself is binned.
    expect(undoMoves.map((m) => m.args?.["id"])).toEqual(["ch1", "made-1"]);
    expect(undoMoves[0]?.args).toEqual({ id: "ch1", newParentId: null, afterId: null, baseRev: 4 });
    expect(undoMoves[1]?.args).toMatchObject({ id: "made-1", newParentId: BIN });
    expect(failures).toHaveLength(1);
  });
});

describe("createNote: a document in the bible", () => {
  const book = (): ProjectItem[] => [item("s1", null, 0, 1, "Scene 1")];
  const withBible = (): ProjectItem[] => [
    item("s1", null, 0, 1, "Scene 1"),
    item("bible", null, 0, 3, "Bible", BIBLE_TYPE),
    item("n1", "bible", 1, 1, "Note 1", NOTE_TYPE),
  ];

  test("the first one builds the section, then the document inside it", async () => {
    const r = await seeded({ walks: [book(), withBible(), withBible()] });
    expect(await r.outline.createNote()).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toMatchObject({ parentId: null, itemType: BIBLE_TYPE });
    expect(creates[1]?.args).toMatchObject({ itemType: NOTE_TYPE });
    // Read from the walk the create's re-read produced, never from the create's
    // own report: the walk is the single source of tree truth in this unit.
    expect(creates[1]?.args?.["parentId"]).toBe("bible");
  });

  test("a second one reuses the section rather than making another", async () => {
    const r = await seeded({ walks: [withBible()] });
    expect(await r.outline.createNote()).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args).toMatchObject({ parentId: "bible", itemType: NOTE_TYPE });
  });

  test("the new document lands at the END of the bible, not in front of it", async () => {
    // afterId null appends, so the section reads oldest-first -- the bin's rule
    // and for the same reason: a writer's earlier notes must not be pushed down
    // the list by every new one.
    const r = await seeded({ walks: [withBible()] });
    await r.outline.createNote();
    expect(argsOf(r, "item_create")?.["afterId"]).toBe(null);
  });

  test("the selection follows the new document", async () => {
    const r = await seeded({ walks: [withBible()] });
    await r.outline.createNote();
    expect(r.created).toHaveLength(1);
  });

  test("a failed section create does not go on to create the document", async () => {
    const r = await seeded({ walks: [book()], rejectOn: "item_create" });
    expect(await r.outline.createNote()).toBe("failed");
    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  test("a section that does not appear in the re-read is reported, not guessed at", async () => {
    // The create said applied and the walk does not hold the row. Carrying on
    // with `parentId: null` would put a bible document at the root of the book,
    // which is a document in the manuscript that counts toward nothing.
    const r = await seeded({ walks: [book(), book()] });
    expect(await r.outline.createNote()).toBe("failed");
    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  test("a bible row that is not a root is not the section", async () => {
    // The host takes the first DEPTH-0 root of the type; a page that took the
    // first row of the type would file every note inside a scene.
    const nested = (): ProjectItem[] => [
      item("s1", null, 0, 1, "Scene 1"),
      item("decoy", "s1", 1, 1, "Bible", BIBLE_TYPE),
    ];
    const made = (): ProjectItem[] => [...nested(), item("bible", null, 0, 1, "Bible", BIBLE_TYPE)];
    const r = await seeded({ walks: [nested(), made(), made()] });
    await r.outline.createNote();
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.args?.["parentId"]).toBe("bible");
  });
});

describe("nested bible placement", () => {
  const empty = (): ProjectItem[] => [item("scene", null, 0, 1, "Scene")];
  const nested = (): ProjectItem[] => [
    item("scene", null, 0, 1, "Scene"),
    item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
    item("folder", "bible", 1, 1, "Folder 1", BIBLE_FOLDER_TYPE),
    item("note", "folder", 2, 1, "Note 1", NOTE_TYPE),
    item("timeline", "bible", 1, 1, "Timeline", TIMELINE_TYPE),
  ];

  test.each([
    ["folder", "folder"],
    ["note", "folder"],
    ["timeline", "bible"],
    ["scene", "bible"],
    ["bible", "bible"],
  ])("creates a note from %s under %s", async (selected, parentId) => {
    const r = await seeded({ walks: [nested()], selected });
    expect(await r.outline.createNote()).toBe("applied");
    expect(argsOf(r, "item_create")).toMatchObject({ parentId, itemType: NOTE_TYPE });
  });

  test("creates a bodyless folder inside the selected folder", async () => {
    const r = await seeded({ walks: [nested()], selected: "folder" });
    expect(await r.outline.createBibleFolder()).toBe("applied");
    expect(argsOf(r, "item_create")).toMatchObject({
      parentId: "folder", itemType: BIBLE_FOLDER_TYPE, title: "Folder 2",
    });
    expect(r.created).toHaveLength(1);
  });

  test("creates the bible root before the first folder", async () => {
    const r = await seeded({ walks: [empty(), nested(), nested()], selected: "scene" });
    expect(await r.outline.createBibleFolder()).toBe("applied");
    const creates = r.calls.filter((call) => call.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toMatchObject({ parentId: null, itemType: BIBLE_TYPE });
    expect(creates[1]?.args).toMatchObject({ parentId: "bible", itemType: BIBLE_FOLDER_TYPE });
  });

  test("creates a timeline alongside a selected note", async () => {
    const r = await seeded({ walks: [nested()], selected: "note" });
    expect(await r.outline.createTimeline()).toBe("applied");
    expect(argsOf(r, "item_create")).toMatchObject({ parentId: "folder", itemType: TIMELINE_TYPE });
  });
});

describe("createTimeline: a story clock in the bible", () => {
  const book = (): ProjectItem[] => [item("s1", null, 0, 1, "Scene 1")];
  const withBible = (): ProjectItem[] => [
    item("s1", null, 0, 1, "Scene 1"),
    item("bible", null, 0, 3, "Bible", BIBLE_TYPE),
    item("t1", "bible", 1, 1, "Timeline", TIMELINE_TYPE),
  ];

  test("the first one builds the section, then the timeline inside it", async () => {
    const r = await seeded({ walks: [book(), withBible(), withBible()] });
    expect(await r.outline.createTimeline()).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toMatchObject({ parentId: null, itemType: BIBLE_TYPE });
    expect(creates[1]?.args).toMatchObject({ itemType: TIMELINE_TYPE, parentId: "bible" });
  });

  test("a second one reuses the section rather than making another", async () => {
    const r = await seeded({ walks: [withBible()] });
    expect(await r.outline.createTimeline()).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args).toMatchObject({ parentId: "bible", itemType: TIMELINE_TYPE });
  });

  test("the title carries no number, unlike a bible note", async () => {
    // `createNote`'s titles are `Note 1`, `Note 2`, ...; a timeline's is
    // always exactly "Timeline", `createMatter`'s reason: one story clock per
    // book is the model, so a second one is a duplicate the writer can see
    // and rename rather than a slot to number.
    const r = await seeded({ walks: [withBible()] });
    await r.outline.createTimeline();
    expect(argsOf(r, "item_create")?.["title"]).toBe("Timeline");
  });

  test("the same bible a note would reuse, a timeline reuses too", async () => {
    // Both go through `createInSection` with `BIBLE_TYPE`; this pins that a
    // book with a note already has a bible a timeline lands inside rather
    // than making a second root.
    const withNote = (): ProjectItem[] => [
      item("s1", null, 0, 1, "Scene 1"),
      item("bible", null, 0, 2, "Bible", BIBLE_TYPE),
      item("n1", "bible", 1, 1, "Note 1", NOTE_TYPE),
    ];
    const r = await seeded({ walks: [withNote()] });
    expect(await r.outline.createTimeline()).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args).toMatchObject({ parentId: "bible", itemType: TIMELINE_TYPE });
  });

  test("a failed section create does not go on to create the timeline", async () => {
    const r = await seeded({ walks: [book()], rejectOn: "item_create" });
    expect(await r.outline.createTimeline()).toBe("failed");
    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });
});

describe("createMatter: front and back matter", () => {
  const book = (): ProjectItem[] => [item("s1", null, 0, 1, "Scene 1")];
  const withFront = (): ProjectItem[] => [
    item("s1", null, 0, 1, "Scene 1"),
    item("front", null, 0, 1, "Front matter", FRONT_MATTER_TYPE),
    item("d1", "front", 1, 1, "Dedication", MATTER_TYPE),
  ];
  const withBack = (): ProjectItem[] => [
    item("s1", null, 0, 1, "Scene 1"),
    item("back", null, 0, 1, "Back matter", BACK_MATTER_TYPE),
    item("a1", "back", 1, 1, "Acknowledgements", MATTER_TYPE),
  ];

  test("the first dedication builds the front section, then the document inside it", async () => {
    const r = await seeded({ walks: [book(), withFront(), withFront()] });
    expect(await r.outline.createMatter("dedication")).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toMatchObject({ parentId: null, itemType: FRONT_MATTER_TYPE });
    expect(creates[1]?.args).toMatchObject({ parentId: "front", itemType: MATTER_TYPE });
  });

  /** WHICH SECTION IS THE WHOLE OF WHAT THE KIND DECIDES. A fixture testing
   *  only one kind cannot tell a table from a constant. */
  test("acknowledgements go to the BACK section and a foreword to the front", async () => {
    const back = await seeded({ walks: [book(), withBack(), withBack()] });
    await back.outline.createMatter("acknowledgements");
    expect(back.calls.filter((c) => c.cmd === "item_create")[0]?.args).toMatchObject({
      itemType: BACK_MATTER_TYPE,
    });
    const front = await seeded({ walks: [book(), withFront(), withFront()] });
    await front.outline.createMatter("foreword");
    expect(front.calls.filter((c) => c.cmd === "item_create")[0]?.args).toMatchObject({
      itemType: FRONT_MATTER_TYPE,
    });
  });

  test("an afterword goes to the back section", async () => {
    const r = await seeded({ walks: [book(), withBack(), withBack()] });
    await r.outline.createMatter("afterword");
    expect(r.calls.filter((c) => c.cmd === "item_create")[0]?.args).toMatchObject({
      itemType: BACK_MATTER_TYPE,
    });
  });

  /** NOT NUMBERED. `Dedication 1` in a book with one dedication is a lie about
   *  the book, and unlike `Scene`, `Note` or `Chapter` the word alone is already
   *  a title a writer can read. */
  test("each kind is titled with its own word and carries no number", async () => {
    // FOUR TITLES, not one: a fixture testing one kind cannot tell four catalog
    // lookups from four copies of the same one.
    for (const [kind, title] of [
      ["dedication", "Dedication"],
      ["foreword", "Foreword"],
      ["acknowledgements", "Acknowledgements"],
      ["afterword", "Afterword"],
    ] as const) {
      const section = kind === "dedication" || kind === "foreword" ? withFront() : withBack();
      const r = await seeded({ walks: [section] });
      await r.outline.createMatter(kind);
      expect(argsOf(r, "item_create")?.["title"]).toBe(title);
    }
  });

  test("a second one reuses the section rather than making another", async () => {
    const r = await seeded({ walks: [withFront()] });
    expect(await r.outline.createMatter("foreword")).toBe("applied");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args).toMatchObject({ parentId: "front", itemType: MATTER_TYPE });
  });

  test("the two sections are independent: a front section is not a back one", async () => {
    // With only a FRONT section in the walk, an acknowledgements page must
    // still build its own back section rather than being filed in the front.
    const withBoth = (): ProjectItem[] => [
      ...withFront(),
      item("back", null, 0, 1, "Back matter", BACK_MATTER_TYPE),
    ];
    const r = await seeded({ walks: [withFront(), withBoth(), withBoth()] });
    await r.outline.createMatter("acknowledgements");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toMatchObject({ itemType: BACK_MATTER_TYPE });
    expect(creates[1]?.args?.["parentId"]).toBe("back");
  });

  test("the new document lands at the END of its section", async () => {
    const r = await seeded({ walks: [withFront()] });
    await r.outline.createMatter("dedication");
    expect(argsOf(r, "item_create")?.["afterId"]).toBe(null);
  });

  test("the selection follows the new document", async () => {
    const r = await seeded({ walks: [withFront()] });
    await r.outline.createMatter("dedication");
    expect(r.created).toHaveLength(1);
  });

  test("a failed section create does not go on to create the document", async () => {
    const r = await seeded({ walks: [book()], rejectOn: "item_create" });
    expect(await r.outline.createMatter("dedication")).toBe("failed");
    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  test("a section that does not appear in the re-read is reported, not guessed at", async () => {
    const r = await seeded({ walks: [book(), book()] });
    expect(await r.outline.createMatter("dedication")).toBe("failed");
    expect(r.calls.filter((c) => c.cmd === "item_create")).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  test("a matter row that is not a root is not the section", async () => {
    const nested = (): ProjectItem[] => [
      item("s1", null, 0, 1, "Scene 1"),
      item("decoy", "s1", 1, 1, "Front matter", FRONT_MATTER_TYPE),
    ];
    const made = (): ProjectItem[] => [
      ...nested(),
      item("front", null, 0, 1, "Front matter", FRONT_MATTER_TYPE),
    ];
    const r = await seeded({ walks: [nested(), made(), made()] });
    await r.outline.createMatter("dedication");
    const creates = r.calls.filter((c) => c.cmd === "item_create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.args?.["parentId"]).toBe("front");
  });
});

describe("chapterItemsIn: the chapter sequence, not the book", () => {
  /** THREE FILTERS, THREE ANSWERS, and one fixture that tells them apart. */
  const walk = (): ProjectItem[] => [
    item("ch1", null, 0, 1, "Chapter 1", "chapter"),
    item("front", null, 0, 1, "Front matter", FRONT_MATTER_TYPE),
    item("d1", "front", 1, 1, "Dedication", MATTER_TYPE),
    item("back", null, 0, 1, "Back matter", BACK_MATTER_TYPE),
    item("a1", "back", 1, 1, "Acknowledgements", MATTER_TYPE),
    item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
    item("bin", null, 0, 1, "Trash", TRASH_TYPE),
    item("gone", "bin", 1, 1, "Gone"),
  ];

  test("the chapter sequence drops all four reserved sections", () => {
    expect(chapterItemsIn(walk()).map((i) => i.id)).toEqual(["ch1"]);
  });

  test("the manuscript KEEPS front and back matter, because they are the book", () => {
    expect(manuscriptItemsIn(walk()).map((i) => i.id)).toEqual([
      "front",
      "d1",
      "ch1",
      "back",
      "a1",
    ]);
  });

  test("the live walk keeps everything but the bin", () => {
    expect(liveItemsIn(walk()).map((i) => i.id)).toEqual([
      "ch1",
      "front",
      "d1",
      "back",
      "a1",
      "bible",
    ]);
  });
});

describe("the walk filters and the bible", () => {
  const nested = (): ProjectItem[] => [
    item("p1", null, 0, 1, "p1", "part"),
    item("s1", "p1", 1),
    // A row of a RESERVED type that a writer moved inside a scene. It is a row
    // and not a section: the host's `root_subtree_ids` takes the first DEPTH-0
    // root, and a page that keyed on the type alone would drop the writer's own
    // rows out of the book on the strength of one hand-moved item.
    item("decoy", "s1", 2, 1, "Bible", BIBLE_TYPE),
    item("under-decoy", "decoy", 3),
  ];

  test("a bible row that is not a root keeps its subtree in the book", () => {
    const kept = manuscriptItemsIn(nested()).map((i) => i.id);
    expect(kept).toEqual(["p1", "s1", "decoy", "under-decoy"]);
  });

  test("a trash row that is not a root keeps its subtree in the live walk", () => {
    const walk: ProjectItem[] = [
      item("s1", null, 0),
      item("decoy", "s1", 1, 1, "Trash", TRASH_TYPE),
      item("under-decoy", "decoy", 2),
    ];
    expect(liveItemsIn(walk).map((i) => i.id)).toEqual(["s1", "decoy", "under-decoy"]);
  });

  test("the bible ROOT and its subtree do leave the book", () => {
    // The control. Without it the two tests above are satisfied by a filter
    // that drops nothing at all.
    const walk: ProjectItem[] = [
      item("s1", null, 0),
      item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
      item("n1", "bible", 1, 1, "Note 1", NOTE_TYPE),
    ];
    expect(manuscriptItemsIn(walk).map((i) => i.id)).toEqual(["s1"]);
    expect(liveItemsIn(walk).map((i) => i.id)).toEqual(["s1", "bible", "n1"]);
  });

  test("a part kept in the bible does not spend the book's one adoption", async () => {
    // The live-walk argument against the second reserved root. A part among
    // the writer's world building is not a part of the book, and letting one
    // suppress adoption would leave every root chapter homeless for the life of
    // the manuscript -- a screenshot, restored by a filter that was
    // one root type short.
    const before = (): ProjectItem[] => [
      item("ch1", null, 0, 1, "Chapter 1", "chapter"),
      item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
      item("p-notes", "bible", 1, 1, "Structure", "part"),
    ];
    const after = (): ProjectItem[] => [...before(), item("made-1", null, 0, 1, "Part 1", "part")];
    const r = await seeded({ walks: [before(), after(), after()] });
    await r.outline.create("part");
    const move = r.calls.find((c) => c.cmd === "item_move");
    expect(move?.args).toMatchObject({ id: "ch1", newParentId: "made-1" });
  });

  test("a part kept in the FRONT MATTER does not spend the book's one adoption", async () => {
    // THE SAME DEFECT THROUGH THE THIRD RESERVED ROOT, and the caller is where
    // it lives: `manuscriptItemsIn` KEEPS front matter, because front matter is
    // part of the book -- so it is the wrong filter for a question about the
    // chapter SEQUENCE, and the caller reads `chapterItemsIn` instead. Pinned
    // here rather than only on `planAdoption`, because the pure function is
    // correct either way and only this test can see which walk it is handed.
    const before = (): ProjectItem[] => [
      item("ch1", null, 0, 1, "Chapter 1", "chapter"),
      item("front", null, 0, 1, "Front matter", FRONT_MATTER_TYPE),
      item("p-front", "front", 1, 1, "Part 1", "part"),
    ];
    const after = (): ProjectItem[] => [...before(), item("made-1", null, 0, 1, "Part 1", "part")];
    const r = await seeded({ walks: [before(), after(), after()] });
    await r.outline.create("part");
    const move = r.calls.find((c) => c.cmd === "item_move");
    expect(move?.args).toMatchObject({ id: "ch1", newParentId: "made-1" });
  });

  test("a bible document is numbered as a note, not as a scene", async () => {
    // `numberPattern` falls back to the SCENE pattern for a type it has no
    // entry for, so without its own case the first bible document is called
    // `Scene 2` -- a second numbering series running through a section that is
    // not the book, colliding with the manuscript's own scene numbers.
    const withBible = (): ProjectItem[] => [
      item("s1", null, 0, 1, "Scene 1"),
      item("bible", null, 0, 1, "Bible", BIBLE_TYPE),
    ];
    const r = await seeded({ walks: [withBible()] });
    await r.outline.createNote();
    expect(argsOf(r, "item_create")?.["title"]).toBe("Note 1");
  });
});

describe("createOutline: undo", () => {
  const movesOf = (r: Rig): Call[] => r.calls.filter((c) => c.cmd === "item_move");
  const renamesOf = (r: Rig): Call[] => r.calls.filter((c) => c.cmd === "item_rename");
  const statesOf = (r: Rig): Call[] => r.calls.filter((c) => c.cmd === "item_set_state");
  const createsOf = (r: Rig): Call[] => r.calls.filter((c) => c.cmd === "item_create");

  // s1 moved down, past s2, inside c1.
  const afterMove = (): ProjectItem[] => [
    item("p1", null, 0, 1, "p1", "part"),
    item("c1", "p1", 1, 7, "c1", "chapter"),
    item("s2", "c1", 2),
    item("s1", "c1", 2, 2),
    item("p2", null, 0, 1, "p2", "part"),
  ];

  describe("move", () => {
    test("undoLabel names the row, and undo replays the inverse against the LIVE walk", async () => {
      const r = await seeded({ walks: [walk(), afterMove(), walk()] });

      expect(await r.outline.move("s1", "down")).toBe("applied");
      expect(r.outline.undoLabel()).toBe("moving s1");
      expect(r.outline.canUndo()).toBe(true);

      expect(await r.outline.undo()).toBe("applied");
      // s1 was the FIRST child before the move, so the inverse carries afterId
      // null - not the fixture's own pre-move rev, but the one the CURRENT
      // (post-move) walk reports for s1.
      expect(movesOf(r)[1]?.args).toEqual({ id: "s1", newParentId: "c1", afterId: null, baseRev: 2 });
      expect(r.done).toEqual(["Undone: moving s1."]);
    });

    test("moveBy lands a run of steps as ONE undo entry that puts the row back", async () => {
      // Three scenes under c1; s1 walks down past s2 and s3 in one drag.
      const three = (): ProjectItem[] => [
        item("p1", null, 0, 1, "p1", "part"),
        item("c1", "p1", 1, 7, "c1", "chapter"),
        item("s1", "c1", 2),
        item("s2", "c1", 2),
        item("s3", "c1", 2),
      ];
      const stepped = (order: string[], rev: number): ProjectItem[] => [
        item("p1", null, 0, 1, "p1", "part"),
        item("c1", "p1", 1, 7, "c1", "chapter"),
        ...order.map((id) => item(id, "c1", 2, id === "s1" ? rev : 1)),
      ];
      const r = await seeded({
        walks: [three(), stepped(["s2", "s1", "s3"], 2), stepped(["s2", "s3", "s1"], 3), three()],
      });

      expect(await r.outline.moveBy("s1", "down", 2)).toBe("applied");
      // Each step planned against the walk the step before it re-read.
      expect(movesOf(r).map((c) => c.args)).toEqual([
        { id: "s1", newParentId: "c1", afterId: "s2", baseRev: 1 },
        { id: "s1", newParentId: "c1", afterId: "s3", baseRev: 2 },
      ]);
      expect(r.outline.undoLabel()).toBe("moving s1");

      expect(await r.outline.undo()).toBe("applied");
      // One undo, one move, straight back to the first child's place.
      expect(movesOf(r)[2]?.args).toEqual({ id: "s1", newParentId: "c1", afterId: null, baseRev: 3 });
      expect(r.outline.canUndo()).toBe(false);
    });

    test("moveBy stops at the first step that does not apply and records nothing for an inert run", async () => {
      const r = await seeded({ walks: [walk(), afterMove()] });
      expect(await r.outline.moveBy("s1", "down", 3)).toBe("applied");
      // s1 is last after one step, so the second is inert and never reaches IPC.
      expect(movesOf(r)).toHaveLength(1);
      expect(await r.outline.moveBy("s2", "up", 2)).toBe("inert");
      expect(movesOf(r)).toHaveLength(1);
      expect(r.outline.undoLabel()).toBe("moving s1");
    });

    test("redo sends the move back to where undo took it from", async () => {
      const r = await seeded({ walks: [walk(), afterMove(), walk(), afterMove()] });

      await r.outline.move("s1", "down");
      await r.outline.undo();
      expect(r.outline.redoLabel()).toBe("moving s1");

      expect(await r.outline.redo()).toBe("applied");
      // The reverse computed live, right before undo's own move ran: s1 sat
      // after s2 in the walk undo was about to overwrite.
      expect(movesOf(r)[2]?.args).toEqual({ id: "s1", newParentId: "c1", afterId: "s2", baseRev: 1 });
      expect(r.done).toEqual(["Undone: moving s1.", "Redone: moving s1."]);
    });

    test("undo when the id is gone from the walk fails without sending item_move", async () => {
      // s1 is already gone from the VERY NEXT walk - the move's own re-read,
      // as if something else removed it in the same instant. Undo reads the
      // walk it already holds; nothing forces a fresher one.
      const gone = (): ProjectItem[] => walk().filter((i) => i.id !== "s1");
      const r = await seeded({ walks: [walk(), gone()] });
      await r.outline.move("s1", "down");

      expect(await r.outline.undo()).toBe("failed");
      expect(movesOf(r)).toHaveLength(1);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toContain("s1");
      expect(r.outline.canUndo()).toBe(false);
    });

    test("undo when the recorded afterId is gone sends afterId: null", async () => {
      // s2 moves up, ahead of s1; its inverse names s1 as the row it used to
      // follow. s1 is gone from the walk the move's own re-read reports, so
      // the fallback appends instead of naming it.
      const afterUpNoS1 = (): ProjectItem[] => [
        item("p1", null, 0, 1, "p1", "part"),
        item("c1", "p1", 1, 7, "c1", "chapter"),
        item("s2", "c1", 2, 2),
        item("p2", null, 0, 1, "p2", "part"),
      ];
      const r = await seeded({ walks: [walk(), afterUpNoS1()] });
      await r.outline.move("s2", "up");

      expect(await r.outline.undo()).toBe("applied");
      expect(movesOf(r)[1]?.args).toMatchObject({ afterId: null });
    });

    test("undo when the recorded parent is gone fails without sending item_move", async () => {
      // s1 outdents from c1 to p1; its inverse names c1 as the parent to
      // return to. c1 is gone from the walk the move's own re-read reports.
      const afterOutdentNoC1 = (): ProjectItem[] => [
        item("p1", null, 0, 1, "p1", "part"),
        item("s1", "p1", 1, 2),
        item("p2", null, 0, 1, "p2", "part"),
      ];
      const r = await seeded({ walks: [walk(), afterOutdentNoC1()] });
      await r.outline.move("s1", "outdent");

      expect(await r.outline.undo()).toBe("failed");
      expect(movesOf(r)).toHaveLength(1);
      expect(r.failures).toHaveLength(1);
    });

    test("with refuseStaleRev, undo sends the rev the RE-READ walk reports", async () => {
      const bumped = (): ProjectItem[] => afterMove().map((i) => (i.id === "s1" ? { ...i, rev: 99 } : i));
      const r = await seeded({ walks: [walk(), bumped()], refuseStaleRev: true });
      await r.outline.move("s1", "down");

      expect(await r.outline.undo()).toBe("applied");
      expect(movesOf(r)[1]?.args).toMatchObject({ baseRev: 99 });
    });

    test("undo is serialized behind an in-flight move", async () => {
      const r = await seeded({ walks: [walk(), afterMove(), walk()] });
      const held = r.outline.move("s1", "down");
      const undone = r.outline.undo();
      await Promise.all([held, undone]);
      expect(r.log).toEqual([
        "item_move", "project_items", "reload",
        "item_move", "project_items", "reload",
      ]);
    });

    test("after destroy(), a landed undo calls neither reload nor onDone", async () => {
      const r = await seeded({ walks: [walk(), afterMove(), walk()] });
      await r.outline.move("s1", "down");
      const before = r.reloads.length;
      const undoing = r.outline.undo();
      r.outline.destroy();
      await undoing;
      expect(r.reloads.length).toBe(before);
      expect(r.done).toEqual([]);
    });
  });

  describe("rename", () => {
    test("undo sends the OLD title, and a new operation clears redo", async () => {
      const renamed = () => walk().map((i) => (i.id === "c1" ? { ...i, title: "New", rev: 8 } : i));
      const r = await seeded({ walks: [walk(), renamed(), walk()] });

      await r.outline.rename("c1", "New");
      expect(r.outline.undoLabel()).toBe("renaming New");

      expect(await r.outline.undo()).toBe("applied");
      expect(renamesOf(r)[1]?.args).toEqual({ id: "c1", title: "c1", baseRev: 8 });
      expect(r.outline.canRedo()).toBe(true);

      await r.outline.rename("c1", "Other");
      expect(r.outline.canRedo()).toBe(false);
    });
  });

  describe("setState", () => {
    test("undo sends the OLD state", async () => {
      const marked = () => walk().map((i) => (i.id === "s1" ? { ...i, state: "drafting", rev: 2 } : i));
      const r = await seeded({ walks: [walk(), marked(), walk()] });

      await r.outline.setState("s1", "drafting");
      expect(await r.outline.undo()).toBe("applied");
      expect(statesOf(r)[1]?.args).toEqual({ id: "s1", state: null, baseRev: 2 });
    });
  });

  describe("remove", () => {
    test("undo sends the item back to its ORIGINAL parent and sibling, not to the root", async () => {
      // The assertion that separates undo from restore: restore's shape
      // (newParentId: null, afterId: null) would fail this.
      const r = await seeded({ walks: [walk(), withBin(), s1InBin(), withBin()] });

      expect(await r.outline.remove("s1")).toBe("applied");
      expect(r.outline.undoLabel()).toBe("deleting s1");

      expect(await r.outline.undo()).toBe("applied");
      expect(movesOf(r)[1]?.args).toEqual({ id: "s1", newParentId: "c1", afterId: null, baseRev: 1 });
    });
  });

  describe("restore", () => {
    test("undo sends the item back into the bin (review fixup)", async () => {
      // A mutant that deleted restore()'s own push would leave canUndo()
      // false here and this test dies with it.
      const r = await seeded({ walks: [s1InBin(), s1AfterBin()] });

      expect(await r.outline.restore("s1")).toBe("applied");
      expect(r.outline.undoLabel()).toBe("restoring s1");
      expect(r.outline.canUndo()).toBe(true);

      expect(await r.outline.undo()).toBe("applied");
      const moves = movesOf(r).slice(1); // skip restore's own move
      expect(moves).toHaveLength(1);
      expect(moves[0]?.args).toEqual({ id: "s1", newParentId: BIN, afterId: null, baseRev: 2 });
    });
  });

  describe("create", () => {
    test("undo bins the created row directly when a bin already exists", async () => {
      const created = (): ProjectItem[] => [...withBin(), item("made-1", "p2", 0, 1)];
      const binned = (): ProjectItem[] => [...withBin(), item("made-1", BIN, 0, 2)];
      const r = await seeded({ walks: [withBin(), created(), binned()], selected: "p2" });

      expect(await r.outline.create("scene", "p2")).toBe("applied");
      expect(r.outline.undoLabel()).toBe("adding made-1");

      expect(await r.outline.undo()).toBe("applied");
      expect(createsOf(r)).toHaveLength(1); // no bin create needed
      expect(movesOf(r)[0]?.args).toMatchObject({ id: "made-1", newParentId: BIN, afterId: null });
    });

    test("undo of a plain create with no pre-existing bin creates one, then moves the row in", async () => {
      const created = (): ProjectItem[] => [...newBook(), item("made-1", null, 0, 1)];
      const withBinToo = (): ProjectItem[] => [...created(), item(BIN, null, 0, 1, "Trash", "trash")];
      const binned = (): ProjectItem[] => [
        item("s1", null, 0, 1, "Scene 1"),
        item(BIN, null, 0, 1, "Trash", "trash"),
        item("made-1", BIN, 0, 2),
      ];
      const r = await seeded({ walks: [newBook(), created(), withBinToo(), binned()], selected: "s1" });

      expect(await r.outline.create("scene")).toBe("applied");
      expect(await r.outline.undo()).toBe("applied");

      expect(createsOf(r).map((c) => c.args?.["itemType"])).toEqual(["scene", "trash"]);
      expect(movesOf(r)[0]?.args).toMatchObject({ id: "made-1", newParentId: BIN });
    });

    test("undo of the press that adopts loose chapters moves them back FIRST, then bins the part", async () => {
      // The bin exists from the start here, so undo needs no item_create of
      // its own - the assertion below is purely about ORDER, not about the
      // bin's creation (covered separately above).
      const s0 = (): ProjectItem[] => [
        item("ch1", null, 0, 3, "Chapter 1", "chapter"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 5, "Chapter 2", "chapter"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // After the part is created.
      const s1state = (): ProjectItem[] => [...s0(), item("made-1", null, 0, 1, "Part 1", "part")];
      // After ch1 is adopted into it.
      const s2state = (): ProjectItem[] => [
        item("made-1", null, 0, 1, "Part 1", "part"),
        item("ch1", "made-1", 1, 4, "Chapter 1"),
        item("s1", "ch1", 2, 1, "Scene 1"),
        item("ch2", null, 0, 5, "Chapter 2", "chapter"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // After ch2 is adopted too - the walk create() leaves behind.
      const s3state = (): ProjectItem[] => [
        item("made-1", null, 0, 1, "Part 1", "part"),
        item("ch1", "made-1", 1, 4, "Chapter 1"),
        item("s1", "ch1", 2, 1, "Scene 1"),
        item("ch2", "made-1", 1, 6, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // undo's first step: ch1 back to the root.
      const s4state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("made-1", null, 0, 1, "Part 1", "part"),
        item("ch2", "made-1", 1, 6, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // undo's second step: ch2 back to the root, after ch1.
      const s5state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 7, "Chapter 2"),
        item("made-1", null, 0, 1, "Part 1", "part"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // undo's third and last step: the now-empty part binned.
      const s6state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 7, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
        item("made-1", BIN, 1, 2, "Part 1", "part"),
      ];
      const r = await seeded({
        walks: [s0(), s1state(), s2state(), s3state(), s4state(), s5state(), s6state()],
        selected: "ch2",
      });

      expect(await r.outline.create("part")).toBe("applied");
      expect(await r.outline.undo()).toBe("applied");

      // No new bin: the fixture already had one.
      expect(createsOf(r)).toHaveLength(1);
      const moves = movesOf(r).slice(2); // skip the create's own two adoption moves
      expect(moves.map((m) => m.args?.["id"])).toEqual(["ch1", "ch2", "made-1"]);
      expect(moves[0]?.args).toEqual({ id: "ch1", newParentId: null, afterId: null, baseRev: 4 });
      expect(moves[1]?.args).toEqual({ id: "ch2", newParentId: null, afterId: "ch1", baseRev: 6 });
      expect(moves[2]?.args).toMatchObject({ id: "made-1", newParentId: BIN });
    });

    test("redo of that press moves the holder out of the bin BEFORE the chapters go back in", async () => {
      // REVERSED replay (review fixup): undo applied ch1, then ch2, then the
      // bin - so redo has to replay their reverses in the OPPOSITE order, or
      // the chapters would be sent into a part that is still sitting in the
      // bin.
      const s0 = (): ProjectItem[] => [
        item("ch1", null, 0, 3, "Chapter 1", "chapter"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 5, "Chapter 2", "chapter"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      const s1state = (): ProjectItem[] => [...s0(), item("made-1", null, 0, 1, "Part 1", "part")];
      const s2state = (): ProjectItem[] => [
        item("made-1", null, 0, 1, "Part 1", "part"),
        item("ch1", "made-1", 1, 4, "Chapter 1"),
        item("s1", "ch1", 2, 1, "Scene 1"),
        item("ch2", null, 0, 5, "Chapter 2", "chapter"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      const s3state = (): ProjectItem[] => [
        item("made-1", null, 0, 1, "Part 1", "part"),
        item("ch1", "made-1", 1, 4, "Chapter 1"),
        item("s1", "ch1", 2, 1, "Scene 1"),
        item("ch2", "made-1", 1, 6, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      const s4state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("made-1", null, 0, 1, "Part 1", "part"),
        item("ch2", "made-1", 1, 6, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      const s5state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 7, "Chapter 2"),
        item("made-1", null, 0, 1, "Part 1", "part"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      const s6state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 7, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
        item("made-1", BIN, 1, 2, "Part 1", "part"),
      ];
      // redo's first step: the part out of the bin, back after ch2 - where
      // undo's OWN reverse (computed live, right before the bin-move ran)
      // found it.
      const s7state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("ch2", null, 0, 7, "Chapter 2"),
        item("made-1", null, 0, 3, "Part 1", "part"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // redo's second step: ch2 back inside the part.
      const s8state = (): ProjectItem[] => [
        item("ch1", null, 0, 5, "Chapter 1"),
        item("s1", "ch1", 1, 1, "Scene 1"),
        item("made-1", null, 0, 3, "Part 1", "part"),
        item("ch2", "made-1", 1, 8, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      // redo's third and last step: ch1 back inside the part, ahead of ch2 -
      // the fully-adopted shape the original press produced.
      const s9state = (): ProjectItem[] => [
        item("made-1", null, 0, 3, "Part 1", "part"),
        item("ch1", "made-1", 1, 9, "Chapter 1"),
        item("s1", "ch1", 2, 1, "Scene 1"),
        item("ch2", "made-1", 1, 8, "Chapter 2"),
        item(BIN, null, 0, 1, "Trash", "trash"),
      ];
      const r = await seeded({
        walks: [
          s0(), s1state(), s2state(), s3state(), s4state(), s5state(), s6state(),
          s7state(), s8state(), s9state(),
        ],
        selected: "ch2",
      });

      expect(await r.outline.create("part")).toBe("applied");
      expect(await r.outline.undo()).toBe("applied");
      expect(await r.outline.redo()).toBe("applied");

      const moves = movesOf(r).slice(5); // skip the create's and undo's five moves
      expect(moves.map((m) => m.args?.["id"])).toEqual(["made-1", "ch2", "ch1"]);
      expect(moves[0]?.args).toEqual({ id: "made-1", newParentId: null, afterId: "ch2", baseRev: 2 });
      expect(moves[1]?.args).toEqual({ id: "ch2", newParentId: "made-1", afterId: null, baseRev: 7 });
      expect(moves[2]?.args).toEqual({ id: "ch1", newParentId: "made-1", afterId: null, baseRev: 5 });
    });

    test("undo of a bible document names no move against the bible's own id", async () => {
      const withBible = (): ProjectItem[] => [item("s1", null, 0, 1, "Scene 1"), item("bible", null, 0, 3, "Bible", BIBLE_TYPE)];
      const withDoc = (): ProjectItem[] => [...withBible(), item("made-1", "bible", 1, 1, "Note 1", NOTE_TYPE)];
      const withBin3 = (): ProjectItem[] => [...withDoc(), item(BIN, null, 0, 1, "Trash", "trash")];
      const docInBin = (): ProjectItem[] => [...withBible(), item(BIN, null, 0, 1, "Trash", "trash"), item("made-1", BIN, 1, 2, "Note 1", NOTE_TYPE)];
      const r = await seeded({ walks: [withBible(), withDoc(), withBin3(), docInBin()] });

      expect(await r.outline.createNote()).toBe("applied");
      expect(await r.outline.undo()).toBe("applied");

      expect(movesOf(r).some((m) => m.args?.["id"] === "bible")).toBe(false);
      expect(movesOf(r).map((m) => m.args?.["id"])).toEqual(["made-1"]);
    });
  });

  test("a failed operation pushes nothing", async () => {
    const r = await seeded({ walks: [walk()], rejectOn: "item_move" });
    expect(await r.outline.move("s1", "down")).toBe("failed");
    expect(r.outline.canUndo()).toBe(false);
  });

  describe("a failed step clears redo, not just the entry that failed", () => {
    // walks: [0] boot, [1] c1 renamed, [2] s1 marked drafting, [3] s1's mark
    // undone, [4] c1's rename undone -- AND c1 removed entirely, simulating
    // something else deleting it in the same instant. That is what makes the
    // SUBSEQUENT redo() fail.
    const renamed = (): ProjectItem[] =>
      walk().map((i) => (i.id === "c1" ? { ...i, title: "New1", rev: 8 } : i));
    const marked = (): ProjectItem[] =>
      renamed().map((i) => (i.id === "s1" ? { ...i, state: "drafting", rev: 2 } : i));
    const unmarked = (): ProjectItem[] =>
      renamed().map((i) => (i.id === "s1" ? { ...i, rev: 3 } : i));
    const c1Gone = (): ProjectItem[] => unmarked().filter((i) => i.id !== "c1");

    test("redo's own failure clears whatever redo still holds", async () => {
      const r = await seeded({ walks: [walk(), renamed(), marked(), unmarked(), c1Gone()] });

      await r.outline.rename("c1", "New1");
      await r.outline.setState("s1", "drafting");
      // Two undos, nothing pushed between them, so redo now holds BOTH
      // reverses: the state one first, the rename one on top (LIFO).
      expect(await r.outline.undo()).toBe("applied");
      expect(await r.outline.undo()).toBe("applied");
      expect(r.outline.canRedo()).toBe(true);

      // redo() pops the rename reverse; c1 is gone from the walk this undo's
      // own re-read left behind, so this step fails.
      expect(await r.outline.redo()).toBe("failed");

      // Not just the failed entry: the state reverse beneath it is gone too.
      expect(r.outline.canRedo()).toBe(false);
    });

    test("undo's own failure also clears a PRE-EXISTING redo entry", async () => {
      // Two pushes, one clean undo (which fills redo), then a second undo
      // whose own step fails - c1 has vanished by the time it runs. The rule:
      // the failed entry is dropped and redo cleared; this is the second half
      // of that rule, with something already sitting in redo to clear.
      const r = await seeded({ walks: [walk(), renamed(), marked(), c1Gone()] });

      await r.outline.rename("c1", "New1");
      await r.outline.setState("s1", "drafting");

      expect(await r.outline.undo()).toBe("applied");
      expect(r.outline.canRedo()).toBe(true);

      expect(await r.outline.undo()).toBe("failed");
      expect(r.outline.canRedo()).toBe(false);
    });
  });

  describe("undo/redo when nothing is on the stack", () => {
    test("undo and redo are inert with no IPC", async () => {
      const r = await seeded();
      expect(await r.outline.undo()).toBe("inert");
      expect(await r.outline.redo()).toBe("inert");
      expect(r.calls).toEqual([]);
      expect(r.done).toEqual([]);
    });

    test("undoLabel/redoLabel are null", async () => {
      const r = await seeded();
      expect(r.outline.undoLabel()).toBeNull();
      expect(r.outline.redoLabel()).toBeNull();
    });
  });
});
