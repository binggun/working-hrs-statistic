import test from "node:test";
import assert from "node:assert/strict";
import { dailyAttendanceHours, totalAttendanceHours } from "../src/attendance-hours.js";
const r = (id, time, type, extra = {}) => ({ id, effective_occurred_at: `2026-10-26T${time}:00+13:00`, sign_type: type, ...extra });
test("Daily hours sort, pair, round each pair and sum integer hundredths", () => {
  const rows = [r("d", "10:02", "SIGN_OUT"), r("b", "09:01", "SIGN_OUT"), r("c", "10:00", "SIGN_IN"), r("a", "09:00", "SIGN_IN")];
  assert.deepEqual(dailyAttendanceHours(rows), [{ date: "2026-10-26", valid: true, hours: "0.05", pending: false, recordCount: 4 }]);
});
test("Malformed daily sequences show adjustment required without a partial total", () => {
  for (const rows of [[r("a", "09:00", "SIGN_IN")], [r("a", "09:00", "SIGN_OUT"), r("b", "10:00", "SIGN_IN")], [r("a", "09:00", "SIGN_IN"), r("b", "10:00", "SIGN_IN")]]) {
    const [day] = dailyAttendanceHours(rows); assert.equal(day.valid, false); assert.equal(day.hours, null);
  }
});
test("Pending proposals use their latest type/time and removals are excluded", () => {
  const rows = [r("a", "09:00", "SIGN_OUT", { pending_sign_type: "SIGN_IN", pending: true }), r("b", "17:30", "SIGN_OUT"), r("c", "18:00", "SIGN_IN", { effective_deleted: true, pending: true })];
  assert.equal(dailyAttendanceHours(rows)[0].hours, "8.50"); assert.equal(dailyAttendanceHours(rows)[0].pending, true);
});
test("Auckland dates stay separate and DST durations use elapsed time", () => {
  const rows = [{id:"a",effective_occurred_at:"2026-09-27T01:30:00+12:00",sign_type:"SIGN_IN"}, {id:"b",effective_occurred_at:"2026-09-27T03:30:00+13:00",sign_type:"SIGN_OUT"}, r("c", "09:00", "SIGN_IN")];
  const days = dailyAttendanceHours(rows); assert.equal(days[0].hours,"1.00"); assert.equal(days[1].valid,false);
});

test("A matching zero-duration pair contributes zero hours", () => {
  assert.equal(dailyAttendanceHours([r("a", "09:00", "SIGN_IN"), r("b", "09:00", "SIGN_OUT")])[0].hours, "0.00");
});

test("Range totals include valid pending changes and flag invalid days", () => {
  const days = [{valid:true,hours:"8.33",pending:false},{valid:true,hours:"7.67",pending:true}];
  assert.deepEqual(totalAttendanceHours(days), {valid:true,hours:"16.00",pending:true});
  assert.deepEqual(totalAttendanceHours([...days,{valid:false,hours:null,pending:false}]), {valid:false,hours:null,pending:true});
  assert.deepEqual(totalAttendanceHours([]), {valid:true,hours:"0.00",pending:false});
});

test("All-store totals pair within each store and add daily hours", () => {
  const rows = [r("a","09:00","SIGN_IN",{shop_id:"A"}),r("b","10:00","SIGN_OUT",{shop_id:"A"}),r("c","11:00","SIGN_IN",{shop_id:"B"}),r("d","13:30","SIGN_OUT",{shop_id:"B"})];
  assert.equal(dailyAttendanceHours(rows)[0].hours,"3.50");
  assert.equal(dailyAttendanceHours([rows[0],rows[3]])[0].valid,false);
});
