import React, { useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";
import { operationId } from "./operationId.js";

const zone = "Pacific/Auckland";
export default function AttendanceRecordDialog({ mode, record, shops, workers, defaultShop = "", defaultWorker = "", api, endpoint, onDone, onClose }) {
  const dialog = useRef(null);
  const request = useRef(null);
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  useEffect(() => { dialog.current.showModal(); }, []);
  const remove = mode === "REMOVE";
  async function submit(event) {
    event.preventDefault();
    if (saving || conflict) return;
    const form = new FormData(event.currentTarget);
    setError("");
    if (!request.current) {
      if (remove) request.current = { operationId: operationId(), action: "DELETE", recordId: record.id, expectedVersion: record.version };
      else {
        const raw = String(form.get("occurredAt"));
        const time = DateTime.fromISO(raw, { zone });
        if (!time.isValid || time.toFormat("yyyy-MM-dd'T'HH:mm") !== raw) {
          setError("Enter a valid Auckland date and time."); return;
        }
        request.current = { operationId: operationId(), action: "ADD", shopId: form.get("shopId"),
          type: form.get("type"), occurredAt: time.toUTC().toISO(),
          ...(workers ? { workerId: form.get("workerId") } : {}) };
      }
    }
    setSaving(true);
    try {
      const data = await api(endpoint, { method: "POST", body: JSON.stringify(request.current) });
      onDone(data);
    } catch (e) {
      setError(e.message);
      if (e.status >= 400 && e.status < 500) {
        request.current = null; setPending(false);
        if (e.status === 409) setConflict(true);
      } else setPending(true);
    } finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="attendance-record-dialog" aria-labelledby={titleId}
    onCancel={(e) => { if (saving) e.preventDefault(); }} onClose={onClose}>
    <h2 className="h3" id={titleId}>{remove ? "Remove attendance record" : "Add attendance record"}</h2>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {pending && <p>Unable to confirm the result. Retry this request to avoid creating a duplicate.</p>}
    {conflict && <p>Close this dialog and refresh the list before trying again.</p>}
    <form onSubmit={submit}>
      {remove ? <>
        <p>Remove this {record.sign_type === "SIGN_IN" ? "clock-in" : "clock-out"} record?</p>
        <p><strong>{record.shop_name || shops.find((s) => s.shopId === defaultShop)?.name}</strong><br />
          {DateTime.fromISO(record.effective_occurred_at).setZone(zone).toFormat("dd/MM/yyyy HH:mm")}</p>
        <p>The record will be marked as removal and hidden from the normal list. Original data and photos are retained for super administrator review. This request requires approval.</p>
      </> : <fieldset disabled={saving || pending}>
        {workers && <label className="form-label mb-3">Employee
          <select required name="workerId" className="form-select mt-1" defaultValue={defaultWorker}>
            <option value="">Select an employee</option>
            {workers.filter((w) => w.status === "ACTIVE").map((w) => <option key={w.workerId} value={w.workerId}>{w.name} ({w.workerId})</option>)}
          </select>
        </label>}
        <label className="form-label mb-3">Store
          <select required name="shopId" className="form-select mt-1" defaultValue={defaultShop}>
            <option value="">Select a store</option>
            {shops.map((s) => <option key={s.id} value={s.shopId}>{s.name} ({s.shopId})</option>)}
          </select>
        </label>
        <label className="form-label mb-3">Date and time (Auckland)
          <input required name="occurredAt" type="datetime-local" className="form-control mt-1"
            defaultValue={DateTime.now().setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm")} />
        </label>
        <label className="form-label mb-3">Type
          <select required name="type" className="form-select mt-1"><option value="SIGN_IN">Clock in</option><option value="SIGN_OUT">Clock out</option></select>
        </label>
        <p>This manual entry has no selfie or GPS data and requires approval.</p>
      </fieldset>}
      <div className="d-flex gap-2 mt-3">
        <button disabled={saving || conflict} className={`btn ${remove ? "btn-danger" : "btn-primary"}`}>
          {saving ? "Submitting…" : pending ? "Retry request" : remove ? "Confirm removal" : "Add record"}
        </button>
        <button disabled={saving} type="button" className="btn" onClick={() => dialog.current.close()}>Cancel</button>
      </div>
    </form>
  </dialog>;
}
