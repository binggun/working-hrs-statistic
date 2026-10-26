import { DateTime } from "luxon";

// Each pair is rounded to integer hundredths before totals are added.
export function dailyAttendanceHours(records) {
  const days = new Map();
  for (const record of records) {
    const time = DateTime.fromISO(String(record.effective_occurred_at instanceof Date ? record.effective_occurred_at.toISOString() : record.effective_occurred_at), { zone: "Pacific/Auckland" });
    const date = time.isValid ? time.toISODate() : "Invalid date";
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ record, time: time.toMillis() });
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const active = rows.filter(({ record }) => !record.effective_deleted && !record.confirmed_deleted).sort((a, b) => a.time - b.time || String(a.record.id).localeCompare(String(b.record.id)));
    const stores = new Map();
    for (const row of active) {
      const key = row.record.shop_id || "single";
      if (!stores.has(key)) stores.set(key, []);
      stores.get(key).push(row);
    }
    let valid = true, hundredths = 0;
    for (const entries of stores.values()) {
      if (entries.length % 2 !== 0) valid = false;
      for (let i = 0; i < entries.length; i += 2) {
        const start = entries[i], end = entries[i + 1];
        if (!end || !Number.isFinite(start.time) || !Number.isFinite(end.time) || end.time < start.time ||
          (start.record.pending_sign_type || start.record.sign_type) !== "SIGN_IN" ||
          (end.record.pending_sign_type || end.record.sign_type) !== "SIGN_OUT") { valid = false; break; }
        hundredths += Math.round((end.time - start.time) / 36000);
      }
    }
    return { date, valid, hours: valid ? (hundredths / 100).toFixed(2) : null,
      pending: rows.some(({ record }) => record.pending), recordCount: active.length };
  });
}

export function totalAttendanceHours(days) {
  const valid = days.every(day => day.valid);
  const hundredths = days.reduce((sum, day) => sum + (day.valid ? Math.round(Number(day.hours) * 100) : 0), 0);
  return { valid, hours: valid ? (hundredths / 100).toFixed(2) : null, pending: days.some(day => day.pending) };
}
