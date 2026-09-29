// app/harness/src/nav-rules.ts
// The navigator rig's two rules, out where a test can reach them.
//
// EXTRACTED, not written here. Both lived inside `nav-cli.ts`, which aborts at
// module scope and therefore cannot be imported — so neither the structural
// comparison that decides whether a run can support a claim, nor the budget
// clamp that keeps a soak away from the ~600 s headless event, had a test that
// could drive it. A rig whose own rules are unmutatable is a rig grading
// everything except itself.
//
// The thresholds' derivation is here rather than at the call site because the
// numbers and the argument for them must move together.

/** Only what the rules read. Deliberately structural rather than an import of
 *  `RunOutcome`: these rules are about three numbers, and a test that has to
 *  build a whole run outcome to check a comparison tests the builder. */
export interface ArmFacts {
  readonly rows: number;
  readonly mountedRows: number;
  readonly peakRssMb: number;
}

export interface StructuralCheckFailure {
  readonly check: string;
  readonly detail: string;
}

/** How much of the projection the naive arm must mount before it counts as a
 *  control.
 *
 *  `main.ts` asserts `navigator.rows().length === source.count` before the soak
 *  starts, so the projection IS the whole tree -- nothing is collapsed at boot,
 *  and the workload's NAV_KEYS carry no ArrowLeft/ArrowRight to collapse
 *  anything during it. The naive arm mounts the projection, so it mounts every
 *  item; the three recorded flat runs mounted 15,200 of 15,200 exactly. 0.9 is
 *  slack against a truncated AT-SPI walk, not an expectation of loss. */
export const CONTROL_MOUNT_FLOOR = 0.9;

/** What the virtualized arm may mount before the run stops being evidence.
 *
 *  AN ABSOLUTE COUNT, NOT A FRACTION, and that is the whole point. The mounted
 *  window is bounded by the PANE -- pane height / ROW_HEIGHT + 2 * OVERSCAN,
 *  about 46 rows in the 900px window the shell builds; measured 36-38 flat and
 *  48-50 on the store tree. A fraction of rows is the wrong shape: 10% of
 *  20,000 would pass a navigator mounting 1,999 rows, which is virtualization
 *  not working at all. 200 leaves a taller pane four times the observed window
 *  while staying two orders of magnitude below the projection. */
export const VIRTUAL_MOUNT_CEILING_ROWS = 200;

/** The comparison IS the evidence: a run where the control did not really mount
 *  the list, or the virtualized mode did not really window it, or windowing did
 *  not lower peak RSS, cannot support a claim about virtualization at all --
 *  independent of whatever the gates say. */
export function validateStructuralDifference(
  control: ArmFacts,
  test: ArmFacts,
): StructuralCheckFailure | null {
  const rows = control.rows;
  if (control.mountedRows < CONTROL_MOUNT_FLOOR * rows) {
    return {
      check: `naive mountedRows >= ${CONTROL_MOUNT_FLOOR * 100}% of rows`,
      detail: `naive mounted ${control.mountedRows} of ${rows} rows (need >= ${Math.round(
        CONTROL_MOUNT_FLOOR * rows,
      )})`,
    };
  }
  if (test.mountedRows > VIRTUAL_MOUNT_CEILING_ROWS) {
    return {
      check: `virtual mountedRows <= ${VIRTUAL_MOUNT_CEILING_ROWS}`,
      detail: `virtual mounted ${test.mountedRows} of ${rows} rows (need <= ${VIRTUAL_MOUNT_CEILING_ROWS})`,
    };
  }
  if (!(test.peakRssMb < control.peakRssMb)) {
    return {
      check: "virtual peak_rss_mb < naive peak_rss_mb",
      detail: `virtual ${test.peakRssMb} MB vs naive ${control.peakRssMb} MB`,
    };
  }
  return null;
}

/** Whether a requested soak is inside the rig's budget.
 *
 *  Returns null when it is, and the refusal text when it is not. A boolean would
 *  put the explanation back at the call site, where nothing can read it: the
 *  reason a budget is refused is the part a reader needs, because the number
 *  alone looks arbitrary. */
export function refuseSoak(requestedMinutes: number, maxMinutes: number): string | null {
  if (requestedMinutes <= maxMinutes) return null;
  return (
    `refusing a ${requestedMinutes}-minute run: budgets over ${maxMinutes} minutes straddle the ~600 s ` +
    `headless event, so their latency gates measure the rig rather than the application. ` +
    `This rig runs TWO arms, so the wall clock is twice what you ask for.`
  );
}
