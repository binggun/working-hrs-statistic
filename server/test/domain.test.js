import test from "node:test";
import assert from "node:assert/strict";
import { monthBounds, calculateHours } from "../src/domain.js";
test("Auckland leap February and DST month boundaries", () => {
  assert.equal(monthBounds("2024-02").toDate, "2024-02-29");
  assert.equal(monthBounds("2026-10").start, "2026-09-30T11:00:00.000Z");
  assert.equal(monthBounds("2026-09").start, "2026-08-31T12:00:00.000Z");
  assert.throws(() => monthBounds("2026-13"));
});
test("Precise minutes and midnight errors", () => {
  assert.equal(
    calculateHours("2026-10-07T09:00:00+13:00", "2026-10-07T17:05:00+13:00")
      .hrs,
    "8.08",
  );
  assert.equal(
    calculateHours("2026-10-07T09:00:00+13:00", "2026-10-07T17:10:00+13:00")
      .hrs,
    "8.17",
  );
  assert.equal(
    calculateHours("2026-10-07T09:00:00+13:00", "2026-10-08T00:00:00+13:00")
      .issue,
    "CROSS_MIDNIGHT",
  );
});
