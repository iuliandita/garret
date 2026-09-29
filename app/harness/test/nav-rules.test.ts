// app/harness/test/nav-rules.test.ts
// The navigator rig's own rules, driven rather than trusted.
import { describe, expect, test } from "bun:test";

import {
  CONTROL_MOUNT_FLOOR,
  refuseSoak,
  validateStructuralDifference,
  VIRTUAL_MOUNT_CEILING_ROWS,
} from "../src/nav-rules";

const ROWS = 20_000;

/** A run that passes every rule, so each test moves exactly one number. */
function arms(over: { control?: Partial<{ rows: number; mountedRows: number; peakRssMb: number }>; test?: Partial<{ rows: number; mountedRows: number; peakRssMb: number }> } = {}) {
  return {
    control: { rows: ROWS, mountedRows: ROWS, peakRssMb: 680, ...over.control },
    test: { rows: ROWS, mountedRows: 48, peakRssMb: 580, ...over.test },
  };
}

describe("the structural comparison", () => {
  test("a run where both arms behaved is evidence", () => {
    const { control, test: t } = arms();
    expect(validateStructuralDifference(control, t)).toBeNull();
  });

  test("a control that did not mount the list is not a control", () => {
    const { control, test: t } = arms({ control: { mountedRows: Math.floor(0.5 * ROWS) } });
    const failure = validateStructuralDifference(control, t);
    expect(failure?.check).toContain("naive mountedRows");
    // The numbers a reader needs to act, not just the verdict.
    expect(failure?.detail).toContain("10000");
    expect(failure?.detail).toContain("18000");
  });

  test("the control floor passes at exactly its boundary", () => {
    // Reachable AT the value, not merely near it: the recorded flat runs mounted
    // every row, so an off-by-one here would never show up in practice.
    const exactly = Math.ceil(CONTROL_MOUNT_FLOOR * ROWS);
    const { control, test: t } = arms({ control: { mountedRows: exactly } });
    expect(validateStructuralDifference(control, t)).toBeNull();
  });

  test("a virtualized arm mounting the whole manuscript is not windowing", () => {
    const { control, test: t } = arms({ test: { mountedRows: ROWS } });
    expect(validateStructuralDifference(control, t)?.check).toContain("virtual mountedRows");
  });

  test("the ceiling is an absolute count, so a bigger book does not raise it", () => {
    // THE REGRESSION THIS PINS: the old rule was 10% of rows, which on a 20,000
    // item tree would have accepted 1,999 mounted rows as virtualization.
    const { control, test: t } = arms({ test: { mountedRows: 1_999 } });
    expect(validateStructuralDifference(control, t)).not.toBeNull();
    expect(VIRTUAL_MOUNT_CEILING_ROWS).toBeLessThan(1_999);
  });

  test("the ceiling passes at exactly its boundary and fails one above it", () => {
    const at = arms({ test: { mountedRows: VIRTUAL_MOUNT_CEILING_ROWS } });
    expect(validateStructuralDifference(at.control, at.test)).toBeNull();
    const over = arms({ test: { mountedRows: VIRTUAL_MOUNT_CEILING_ROWS + 1 } });
    expect(validateStructuralDifference(over.control, over.test)).not.toBeNull();
  });

  test("windowing that did not lower peak RSS supports no claim", () => {
    const { control, test: t } = arms({ test: { peakRssMb: 680 } });
    // EQUAL is a failure, not a pass: the claim is that virtualization costs
    // less memory, and equal memory is not less.
    expect(validateStructuralDifference(control, t)?.check).toContain("peak_rss_mb");
  });
});

describe("the soak budget", () => {
  test("a budget inside the cap is accepted", () => {
    expect(refuseSoak(5, 5)).toBeNull();
    expect(refuseSoak(0.2, 5)).toBeNull();
  });

  test("a budget over the cap is refused, and says why", () => {
    const refusal = refuseSoak(15, 5);
    expect(refusal).toContain("15-minute");
    expect(refusal).toContain("600 s");
    // The wall clock is twice the ask, which is the part a caller gets wrong.
    expect(refusal).toContain("TWO arms");
  });
});
