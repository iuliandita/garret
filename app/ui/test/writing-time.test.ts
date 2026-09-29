import { describe, expect, test } from "bun:test";
import { createWritingTime, formatMinutes, timeTrackingFrom, type TimeTracking } from "../src/writing-time";

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("writing time", () => {
  test("one edit per minute reaches the host, however many keystrokes", async () => {
    let minute = 1000;
    const noted: string[] = [];
    const time = createWritingTime({
      tracking: () => "on",
      note: (today) => {
        noted.push(today);
        return Promise.resolve(1);
      },
      minute: () => minute,
    });
    time.touch();
    time.touch();
    time.touch();
    expect(noted.length).toBe(1);
    minute = 1001;
    time.touch();
    expect(noted.length).toBe(2);
    expect(noted[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await settle();
  });

  test("nothing reaches the host while the writer has it off, and the switch is read per edit", () => {
    let tracking: TimeTracking = "off";
    let noted = 0;
    const time = createWritingTime({
      tracking: () => tracking,
      note: () => {
        noted += 1;
        return Promise.resolve(1);
      },
      minute: () => 5,
    });
    time.touch();
    expect(noted).toBe(0);
    tracking = "on";
    time.touch();
    expect(noted).toBe(1);
  });

  test("a host that refuses is swallowed: the count is bookkeeping, not the manuscript", async () => {
    const time = createWritingTime({
      tracking: () => "on",
      note: () => Promise.reject(new Error("no project is open")),
      minute: () => 1,
    });
    expect(() => time.touch()).not.toThrow();
    await settle();
  });

  test("minutes format in the unit the rule is stated in", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(59)).toBe("59 min");
    expect(formatMinutes(60)).toBe("1 h 00 min");
    expect(formatMinutes(125)).toBe("2 h 05 min");
    expect(formatMinutes(-3)).toBe("0 min");
  });

  test("anything the host says that is not off is on", () => {
    expect(timeTrackingFrom("off")).toBe("off");
    expect(timeTrackingFrom("on")).toBe("on");
    expect(timeTrackingFrom(undefined)).toBe("on");
    expect(timeTrackingFrom(7)).toBe("on");
  });
});
