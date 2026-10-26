import React, { useEffect, useRef, useState } from "react";
import { operationId } from "./operationId.js";

export default function PeoplePage({ account, workers, managers, shops, api, busy, task, onChanged, Table }) {
  const [editor, setEditor] = useState(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [search, setSearch] = useState("");
  const owner = ["SUPER_MANAGER", "GENERAL_MANAGER"].includes(account.role);
  const storeName = code => shops.find(s => s.shopId === code)?.name || code || "—";
  const run = (person, suffix, message) => task(async () => {
    await api(`/manager/accounts/${person.accountId}/${suffix}`, {
      method: "POST", body: JSON.stringify({ operationId: operationId() }),
    });
    onChanged(message);
  });
  const table = (people, kind) => <Table
    headers={["First name", "Last name", "Employee ID", "Registered email", "Address", "Phone", "Preferred store", "Status", "Actions"]}
    rows={people.filter(p => (showDeleted || p.status !== "DISABLED") && [p.firstName, p.lastName, p.name, p.email, p.workerId].some(value => String(value || "").toLowerCase().includes(search.trim().toLowerCase()))).map(p => [
      p.firstName || p.name, p.lastName || "—", kind === "worker" ? p.workerId || "Pending assignment" : "—",
      p.email, p.address || "—", p.phone || "—", storeName(p.preferredShopId),
      p.status === "DISABLED" ? "Deleted" : p.status,
      <div className="d-flex gap-2">
        {p.status !== "DISABLED" && <>
          <button className="btn btn-sm" disabled={busy} onClick={() => setEditor({ mode: "EDIT", person: p, kind })}>Edit</button>
          <button className="btn btn-sm btn-outline-danger" disabled={busy || p.accountId === account.id}
            onClick={() => setEditor({ mode: "REMOVE", person: p, kind })}>Delete</button>
          {p.status === "PENDING" && (p.requires_manager_approval && p.password_set
            ? account.role === "GENERAL_MANAGER" ? <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(p, "approve", "Account activated; employee ID confirmation email queued.")}>Approve activation</button> : <span className="small text-secondary">Awaiting General manager approval</span>
            : <button className="btn btn-sm" disabled={busy} onClick={() => run(p, "invitations", "Invitation queued.")}>Resend invitation</button>)}
        </>}
      </div>,
    ])} />;
  return <>
    <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
      <p className="text-secondary mb-0">Groomer profiles within your permission scope. New personnel require General manager approval.</p>
      <button className="btn btn-primary" disabled={busy} onClick={() => setEditor({ mode: "ADD", kind: "worker" })}>Add person</button>
    </div>
    <label className="form-label mb-3">Search groomers<input className="form-control mt-1" type="search" placeholder="Name, email or employee ID" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <label className="form-check mb-4">
      <input className="form-check-input" type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />
      <span className="form-check-label">Show deleted accounts</span>
    </label>
    <h2 className="h3 mb-3">Groomers</h2>
    {table(workers, "worker")}
    {owner && <><h2 className="h3 mt-4 mb-3">Managers</h2>{table(managers.filter(p => p.role !== "GENERAL_MANAGER"), "manager")}</>}
    {editor && <PersonDialog {...editor} owner={owner} shops={shops} api={api}
      onClose={() => setEditor(null)} onDone={message => { setEditor(null); onChanged(message); }} />}
  </>;
}

function PersonDialog({ mode, person, kind, owner, shops, api, onClose, onDone }) {
  const dialog = useRef(null);
  const request = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [frozen, setFrozen] = useState(false);
  const [conflict, setConflict] = useState(false);
  useEffect(() => { dialog.current.showModal(); }, []);
  const input = (name, label, type = "text", required = false, maxLength) => <label className="col-md-6 form-label">
    {label}<input name={name} type={type} required={required} maxLength={maxLength}
      defaultValue={person?.[name] || (name === "firstName" ? person?.name : "") || ""}
      className="form-control mt-1" />
  </label>;
  async function submit(e) {
    e.preventDefault();
    if (saving || conflict) return;
    const data = Object.fromEntries(new FormData(e.currentTarget));
    if (!request.current) {
      const operation = operationId();
      if (mode === "REMOVE") request.current = { endpoint: `/manager/accounts/${person.accountId}/remove`,
        body: { operationId: operation, expectedVersion: person.version } };
      else {
        const fields = { firstName: data.firstName.trim(), lastName: data.lastName.trim(), address: data.address.trim(),
          phone: data.phone.trim(), preferredShopId: data.preferredShopId || null };
        request.current = mode === "ADD" ? { endpoint: `/manager/${data.kind === "manager" ? "managers" : "workers"}`,
          body: { ...fields, name: [fields.firstName, fields.lastName].filter(Boolean).join(" "), email: data.email.trim(), operationId: operation } }
          : { endpoint: `/manager/accounts/${person.accountId}/profile`, body: { ...fields, operationId: operation, expectedVersion: person.version } };
      }
    }
    setSaving(true); setFrozen(true); setError("");
    try {
      await api(request.current.endpoint, { method: "POST", body: JSON.stringify(request.current.body) });
      onDone(mode === "ADD" ? "Person created; password setup invitation queued." : mode === "REMOVE"
        ? "Account deleted. Sign-in access revoked; attendance history retained." : "Personal details saved.");
    } catch (e) {
      setError(e.status === 409 ? "The account changed or the email is already in use. Close this dialog and refresh the list." : e.message);
      if (e.status >= 400 && e.status < 500) { request.current = null; setFrozen(false); }
      if (e.status === 409) setConflict(true);
    } finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="attendance-record-dialog people-dialog"
    onCancel={e => { if (saving) e.preventDefault(); }} onClose={onClose}>
    <form onSubmit={submit}>
      <h2 className="h3 mb-4">{mode === "ADD" ? "Add person" : mode === "EDIT" ? "Edit personal details" : "Delete account?"}</h2>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {mode === "REMOVE" ? <>
        <p>Delete <strong>{person.name}</strong> ({person.email})?</p>
        <p className="text-secondary">The account will be disabled and signed out. Attendance records, photos and history will be retained.</p>
      </> : <fieldset disabled={saving || frozen || conflict}>
        {mode === "EDIT" && <div className="mb-4"><div className="text-secondary small">Registered email</div><div>{person.email}</div>
          <div className="text-secondary small mt-2">{kind === "worker" ? `Employee ID: ${person.workerId || "Pending assignment"}` : "Manager account"}</div></div>}
        <div className="row g-3">
          {mode === "ADD" && input("email", "Registered email", "email", true, 254)}
          {mode === "ADD" && <label className="col-md-6 form-label">Role
            <select name="kind" className="form-select mt-1" defaultValue={kind}>
              <option value="worker">Groomer</option>{owner && <option value="manager">Manager</option>}
            </select>
          </label>}
          {input("firstName", "First name", "text", true, 100)}
          {input("lastName", "Last name", "text", false, 100)}
          {input("address", "Address", "text", false, 500)}
          {input("phone", "Phone", "tel", false, 50)}
          <label className="col-md-12 form-label">Preferred store
            <select name="preferredShopId" className="form-select mt-1" defaultValue={person?.preferredShopId || ""}>
              <option value="">None</option>
              {person?.preferredShopId && !shops.some(s => s.shopId === person.preferredShopId) &&
                <option value={person.preferredShopId}>Current preferred store ({person.preferredShopId})</option>}
              {shops.map(s => <option key={s.id} value={s.shopId}>{s.name} ({s.shopId})</option>)}
            </select>
          </label>
        </div>
        {mode === "ADD" && <p className="text-secondary mt-3">A password setup link will be emailed. All new personnel must be approved by the General manager before activation.</p>}
      </fieldset>}
      <div className="d-flex justify-content-end gap-2 mt-4">
        <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
        <button className={`btn ${mode === "REMOVE" ? "btn-danger" : "btn-primary"}`} disabled={saving || conflict}>
          {saving ? "Saving…" : mode === "REMOVE" ? "Delete account" : mode === "ADD" ? "Create & invite" : "Save changes"}
        </button>
      </div>
    </form>
  </dialog>;
}
