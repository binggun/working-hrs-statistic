import React, { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { operationId } from "./operationId.js";
import AttendancePhotoLink from "./AttendancePhotoLink.jsx";
import AttendanceRecordDialog from "./AttendanceRecordDialog.jsx";

const zone = "Pacific/Auckland";
const today = () => DateTime.now().setZone(zone);
const displayTime = (value) => value ? DateTime.fromISO(value).setZone(zone).toFormat("dd/MM/yyyy HH:mm") : "—";

export default function WorkerPortal({ account, api, logout, session }) {
  const [shops, setShops] = useState([]);
  const [shop, setShop] = useState("");
  const [fromDate, setFromDate] = useState(today().startOf("month").toISODate());
  const [toDate, setToDate] = useState(today().toISODate());
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(null);
  const [recordDialog, setRecordDialog] = useState(null);
  const [time, setTime] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [shopsLoaded, setShopsLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setError("");
    api("/shops").then((items) => {
      if (!active) return;
      setShops(items);
      setShop((current) => items.some((item) => item.shopId === current) ? current : items[0]?.shopId || "");
      setShopsLoaded(true);
    }).catch((e) => { if (active) { setError(e.message); setShopsLoaded(true); } });
    return () => { active = false; };
  }, [session, refresh]);

  useEffect(() => {
    let active = true;
    setRecords([]); setEditor(null); setLoading(false);
    if (!shop) return;
    const start = DateTime.fromISO(fromDate, { zone });
    const end = DateTime.fromISO(toDate, { zone });
    if (!start.isValid || !end.isValid || start > end || end.diff(start, "days").days > 30) {
      setError("Choose a valid date range of up to 31 days."); return;
    }
    setLoading(true); setError("");
    const query = new URLSearchParams({ shopId: shop, fromDate, toDate });
    api("/attendance?" + query).then((data) => {
      if (active) setRecords(data.items);
    }).catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session, shop, fromDate, toDate, refresh]);

  async function save(e) {
    e.preventDefault();
    if (saving || !editor) return;
    const occurredAt = DateTime.fromISO(time, { zone });
    if (!occurredAt.isValid || occurredAt.toFormat("yyyy-MM-dd'T'HH:mm") !== time) {
      setError("Enter a valid Auckland date and time."); return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      await api("/attendance-adjustments", {
        method: "POST",
        body: JSON.stringify({ operationId: operationId(), action: "UPDATE",
          recordId: editor.id, expectedVersion: editor.version, occurredAt: occurredAt.toUTC().toISO() }),
      });
      setEditor(null);
      setNotice("Change submitted for manager approval. The original record is preserved.");
      setRefresh((value) => value + 1);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return <main className="container-xl py-4">
    <header className="d-flex justify-content-between align-items-center mb-4">
      <div><h1 className="h2">My attendance</h1><p className="text-secondary mb-0">{account.name}</p></div>
      <button disabled={saving} className="btn" onClick={async () => {
        try { await logout(); } catch (e) { setError(e.message); }
      }}>Sign out</button>
    </header>
    <p>You can view and request time changes to your own records. Changes require manager approval. All times use Pacific/Auckland.</p>
    {error && <div role="alert" className="alert alert-danger">{error}</div>}
    {notice && <div role="status" className="alert alert-success">{notice}</div>}
    <div className="card card-body mb-4">
      <div className="row g-3">
        <label className="col-md-4 form-label">Store
          <select className="form-select mt-1" value={shop} disabled={saving} onChange={(e) => setShop(e.target.value)}>
            {!shops.length && <option value="">{shopsLoaded ? "No stores available" : "Loading stores…"}</option>}
            {shops.map((item) => <option key={item.id} value={item.shopId}>{item.name}</option>)}
          </select>
        </label>
        <label className="col-md-3 form-label">From
          <input className="form-control mt-1" type="date" value={fromDate} disabled={saving} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label className="col-md-3 form-label">To
          <input className="form-control mt-1" type="date" value={toDate} disabled={saving} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <div className="col-md-2 align-self-end mb-2"><button className="btn" disabled={loading || saving} onClick={() => setRefresh((v) => v + 1)}>Refresh</button></div>
      </div>
    </div>
    <button className="btn btn-primary mb-3" disabled={saving || loading || !shops.length} onClick={() => setRecordDialog({ mode: "ADD" })}>Add attendance record</button>
    {recordDialog && <AttendanceRecordDialog mode={recordDialog.mode} record={recordDialog.record}
      shops={shops} defaultShop={shop} api={api} endpoint="/attendance-adjustments"
      onClose={() => setRecordDialog(null)} onDone={() => {
        setRecordDialog(null); setEditor(null); setRefresh((v) => v + 1);
        setNotice(recordDialog.mode === "REMOVE" ? "Record marked as removal; original data retained. Pending approval." : "Manual record added. Pending approval.");
      }} />}
    {editor && <form className="card card-body mb-4" onSubmit={save}>
      <h2 className="h3">Edit {editor.sign_type === "SIGN_IN" ? "clock-in" : "clock-out"} time</h2>
      <p>Original: {displayTime(editor.original_occurred_at)}</p>
      <label className="form-label">New time (Auckland)
        <input required type="datetime-local" className="form-control mt-1" value={time} disabled={saving} onChange={(e) => setTime(e.target.value)} />
      </label>
      <div className="d-flex gap-2"><button disabled={saving} className="btn btn-primary">{saving ? "Submitting…" : "Submit change"}</button>
        <button type="button" disabled={saving} className="btn" onClick={() => setEditor(null)}>Cancel</button></div>
    </form>}
    {loading ? <p role="status">Loading records…</p> : <div className="card table-responsive"><table className="table table-vcenter">
      <thead><tr><th>Type</th><th>Original</th><th>Current</th><th>Confirmed</th><th>Status</th><th>Photo</th><th>Action</th></tr></thead>
      <tbody>{records.map((record) => <tr key={record.id}>
        <td>{record.sign_type === "SIGN_IN" ? "Clock in" : "Clock out"}</td>
        <td>{displayTime(record.original_occurred_at)}</td><td>{displayTime(record.effective_occurred_at)}</td>
        <td>{displayTime(record.confirmed_occurred_at)}</td>
        <td>{record.pending ? "Pending approval" : record.effective_deleted ? "Deleted" : record.confirmed_occurred_at ? "Confirmed" : "Unconfirmed"}</td>
        <td>{record.photo_id ? <AttendancePhotoLink photoId={record.photo_id} api={api}
          description={`${record.sign_type === "SIGN_IN" ? "Clock in" : "Clock out"} · ${displayTime(record.original_occurred_at)}`} /> : "—"}</td>
        <td><div className="d-flex gap-2"><button className="btn btn-sm" disabled={saving || record.pending || record.effective_deleted} onClick={() => {
          setEditor(record); setTime(DateTime.fromISO(record.effective_occurred_at).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm"));
          setError(""); setNotice("");
        }}>Adjust</button>
          <button className="btn btn-sm btn-outline-danger" disabled={saving || record.pending || record.effective_deleted}
            onClick={() => setRecordDialog({ mode: "REMOVE", record })}>Remove</button>
        </div></td>
      </tr>)}</tbody>
    </table>{!records.length && <p className="p-3 mb-0">{error ? "Unable to display records. Check the message above." : "No records for this selection."}</p>}</div>}
  </main>;
}
