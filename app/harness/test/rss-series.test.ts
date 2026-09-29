import { describe, expect, test } from "bun:test";
import { bucketRss, summarizeRss, type RssSample } from "../src/rss-series";

const every = (n: number, stepMs: number, f: (i: number) => number): RssSample[] =>
  Array.from({ length: n }, (_, i) => ({ atMs: i * stepMs, rssMb: f(i) }));

describe("bucketRss", () => {
  test("keeps the maximum per bucket, stamped at the bucket start", () => {
    const s: RssSample[] = [
      { atMs: 0, rssMb: 100 },
      { atMs: 250, rssMb: 140 },
      { atMs: 500, rssMb: 120 },
      { atMs: 1000, rssMb: 130 },
      { atMs: 1250, rssMb: 110 },
    ];
    expect(bucketRss(s, 1000)).toEqual([
      { atMs: 0, rssMb: 140 },
      { atMs: 1000, rssMb: 130 },
    ]);
  });

  test("an empty bucket in the middle is absent, not zero", () => {
    const s: RssSample[] = [
      { atMs: 0, rssMb: 100 },
      { atMs: 2500, rssMb: 105 },
    ];
    expect(bucketRss(s, 1000)).toEqual([
      { atMs: 0, rssMb: 100 },
      { atMs: 2000, rssMb: 105 },
    ]);
  });

  test("an empty series buckets to an empty series", () => {
    expect(bucketRss([], 1000)).toEqual([]);
  });
});

describe("summarizeRss", () => {
  // The 2026-08-25 question the peak could not answer: a boot spike that
  // settles reads as the same 700 as a run that climbs to 700 and stays there.
  test("a boot transient: the peak sits inside the boot window and the run settles below it", () => {
    const s = every(600, 500, (i) => (i * 500 < 5000 ? 700 : 500));
    const r = summarizeRss(s, 30_000);
    expect(r.peak_mb).toBe(700);
    expect(r.peak_at_ms).toBe(0);
    expect(r.peak_in_boot_window).toBe(true);
    expect(r.boot_window_peak_mb).toBe(700);
    expect(r.post_boot_median_mb).toBe(500);
    expect(r.post_boot_max_mb).toBe(500);
    expect(r.post_boot_slope_mb_per_min).toBe(0);
  });

  test("a steady-state rise: the peak is at the end and the slope carries the rate", () => {
    // 500 MB at 30 s, climbing 10 MB per minute for five minutes.
    const s = every(601, 500, (i) => 500 + ((i * 500) / 60_000) * 10);
    const r = summarizeRss(s, 30_000);
    expect(r.peak_at_ms).toBe(300_000);
    expect(r.peak_in_boot_window).toBe(false);
    expect(r.post_boot_slope_mb_per_min).toBeCloseTo(10, 6);
    expect(r.post_boot_max_mb).toBe(r.peak_mb);
    expect(r.post_boot_median_mb).toBeGreaterThan(r.boot_window_peak_mb);
  });

  test("peak_at_ms is the FIRST sample at the peak, not the last", () => {
    const s: RssSample[] = [
      { atMs: 0, rssMb: 400 },
      { atMs: 1000, rssMb: 600 },
      { atMs: 2000, rssMb: 600 },
      { atMs: 3000, rssMb: 400 },
    ];
    expect(summarizeRss(s, 500).peak_at_ms).toBe(1000);
  });

  test("the boot window is half-open: a sample AT the boundary is post-boot", () => {
    const s: RssSample[] = [
      { atMs: 0, rssMb: 100 },
      { atMs: 1000, rssMb: 900 },
      { atMs: 2000, rssMb: 100 },
    ];
    const r = summarizeRss(s, 1000);
    expect(r.boot_window_peak_mb).toBe(100);
    expect(r.post_boot_max_mb).toBe(900);
    expect(r.peak_in_boot_window).toBe(false);
  });

  test("the median is the middle of an odd post-boot series and the mean of the middle pair of an even one", () => {
    const odd: RssSample[] = [1, 9, 5].map((v, i) => ({ atMs: 10_000 + i * 1000, rssMb: v }));
    expect(summarizeRss(odd, 1000).post_boot_median_mb).toBe(5);
    // The sampler's first tick lands ~250 ms after spawn, never at 0: the span
    // is what the samples COVER, not the timestamp of the last one.
    expect(summarizeRss(odd, 1000).span_ms).toBe(2000);
    const even: RssSample[] = [1, 9, 5, 7].map((v, i) => ({ atMs: 10_000 + i * 1000, rssMb: v }));
    expect(summarizeRss(even, 1000).post_boot_median_mb).toBe(6);
  });

  test("a series with nothing after the boot window reports the post-boot figures as null, not zero", () => {
    const s = every(10, 1000, () => 480);
    const r = summarizeRss(s, 60_000);
    expect(r.peak_mb).toBe(480);
    expect(r.post_boot_samples).toBe(0);
    expect(r.post_boot_median_mb).toBeNull();
    expect(r.post_boot_max_mb).toBeNull();
    expect(r.post_boot_slope_mb_per_min).toBeNull();
  });

  test("one post-boot sample has a median and no slope", () => {
    const s: RssSample[] = [
      { atMs: 0, rssMb: 100 },
      { atMs: 5000, rssMb: 120 },
    ];
    const r = summarizeRss(s, 1000);
    expect(r.post_boot_median_mb).toBe(120);
    expect(r.post_boot_max_mb).toBe(120);
    expect(r.post_boot_slope_mb_per_min).toBeNull();
  });

  test("the summary records the window it was computed with and the sample count", () => {
    const s = every(20, 1000, () => 480);
    const r = summarizeRss(s, 5000);
    expect(r.boot_window_ms).toBe(5000);
    expect(r.samples).toBe(20);
    expect(r.post_boot_samples).toBe(15);
    expect(r.span_ms).toBe(19_000);
  });

  test("an empty series throws: a sampler that never ran is not a flat run", () => {
    expect(() => summarizeRss([], 30_000)).toThrow(/no RSS samples/);
  });

  test("a non-positive boot window is refused", () => {
    const s = every(3, 1000, () => 1);
    expect(() => summarizeRss(s, 0)).toThrow(/boot window/);
  });
});
