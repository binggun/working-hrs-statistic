import { DateTime } from "luxon";
export const zone = "Pacific/Auckland";
export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ""))
    throw Object.assign(new Error("Month must be YYYY-MM"), { status: 422 });
  const d = DateTime.fromISO(month + "-01", { zone });
  if (!d.isValid)
    throw Object.assign(new Error("Invalid month"), { status: 422 });
  return {
    month,
    timezone: zone,
    start: d.toUTC().toISO(),
    end: d.plus({ months: 1 }).toUTC().toISO(),
    fromDate: d.toISODate(),
    toDate: d.endOf("month").toISODate(),
  };
}
export const localDate = (t) =>
  DateTime.fromJSDate(new Date(t), { zone }).toISODate();
export function calculateHours(start, end) {
  if (localDate(start) !== localDate(end))
    return { status: "INVALID", issue: "CROSS_MIDNIGHT" };
  const ms = new Date(end) - new Date(start);
  if (ms < 0) return { status: "INVALID", issue: "REVERSED_TIME" };
  return {
    status: "CONFIRMED",
    minutes: ms / 60000,
    hrs: (Math.round(ms / 36000) / 100).toFixed(2),
  };
}
