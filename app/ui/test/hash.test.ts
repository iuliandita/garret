import { describe, expect, test } from "bun:test";
import { bodyHash } from "../src/store/hash";

describe("bodyHash", () => {
  test("is stable for the same input", () => {
    expect(bodyHash("hello")).toBe(bodyHash("hello"));
  });

  test("differs for different input", () => {
    expect(bodyHash("hello")).not.toBe(bodyHash("hello "));
  });

  test("is a fixed-width hex string", () => {
    expect(bodyHash("")).toMatch(/^[0-9a-f]{8}$/);
    expect(bodyHash("x".repeat(100_000))).toMatch(/^[0-9a-f]{8}$/);
  });
});
