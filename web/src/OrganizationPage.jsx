import React, { useEffect, useRef, useState } from "react";
import { operationId } from "./operationId.js";
const roleName = role => ({ WORKER: "Groomer", MANAGER: "Manager", GENERAL_MANAGER: "General manager" }[role] || role);

export default function OrganizationPage({ account, api, onChanged }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(null), [candidate, setCandidate] = useState("");
  async function load() {
    try { const result = await api("/manager/organization"); setData(result); setError(""); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);
  if (!data) return <p role="status">{error || "Loading company structure…"}</p>;
  const general = data.people.find(p => p.role === "GENERAL_MANAGER" && p.status !== "DISABLED");
  return <>
    <div className="d-flex justify-content-end mb-3"><button className="btn" onClick={load}>Refresh organization</button></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <div className="row g-3 mb-4">
      {[["General manager", "One company-wide administrator. Approves all new personnel and manages roles and permissions."],
        ["Manager", "Multiple managers. Stores and groomers may be shared between managers."],
        ["Groomer", "Personal attendance and profile. Store OR groomer authorization grants managers access to attendance."]].map(([name, description]) =>
        <div className="col-lg-4" key={name}><section className="card h-100"><div className="card-body"><h2 className="h3">{name}</h2><p className="text-secondary mb-0">{description}</p></div></section></div>)}
    </div>
    <section className="card mb-4"><div className="card-body">
      <h2 className="h3">General manager</h2>
      <p>{general ? `${general.name} · ${general.email}` : "Not appointed yet"}</p>
      {account.role === "SUPER_MANAGER" && <>
        <p className="text-secondary">Owner appoints the only General manager. If needed, create a Manager in People first and ask them to set their password. Appointing them here activates this initial General manager.</p>
        <div className="d-flex flex-wrap gap-3">
          <select aria-label="General manager" className="form-select w-auto" value={candidate} onChange={e => setCandidate(e.target.value)}>
            <option value="">Choose a manager</option>
            {data.people.filter(p => ["MANAGER", "GENERAL_MANAGER"].includes(p.role) && p.status !== "DISABLED").map(p =>
              <option key={p.id} value={p.id} disabled={!p.passwordSet}>{p.name} · {p.email}{!p.passwordSet ? " (password not set)" : ""}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!candidate || candidate === general?.id}
            onClick={() => setEditor({ mode: "GENERAL", person: data.people.find(p => p.id === candidate) })}>Appoint General manager</button>
        </div>
      </>}
    </div></section>
    <section className="card"><div className="card-header"><h2 className="card-title">Roles & manager assignments</h2></div>
      <div className="table-responsive"><table className="table card-table table-vcenter"><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Stores</th><th>Groomers</th><th>Actions</th></tr></thead>
        <tbody>{data.people.map(p => {
          const permissions = data.assignments.find(a => a.managerId === p.id);
          return <tr key={p.id}><td>{p.name}<div className="text-secondary small">{p.email}</div></td><td>{roleName(p.role)}</td><td>{p.status}</td>
            <td>{p.role === "GENERAL_MANAGER" ? "All" : permissions?.shopIds.map(id => data.shops.find(s => s.id === id)?.name || id).join(", ") || "—"}</td>
            <td>{p.role === "GENERAL_MANAGER" ? "All" : permissions?.workerIds.map(id => data.people.find(g => g.workerId === id)?.name || id).join(", ") || "—"}</td>
            <td><div className="d-flex gap-2">{p.status !== "DISABLED" && p.role !== "GENERAL_MANAGER" && <>
              <button className="btn btn-sm" onClick={() => setEditor({ mode: "ROLE", person: p })}>Change role</button>
              {p.role === "MANAGER" && <button className="btn btn-sm btn-primary" onClick={() => setEditor({ mode: "PERMISSIONS", person: p })}>Assign permissions</button>}
            </>}</div></td></tr>;
        })}</tbody></table></div>
    </section>
    {editor && <OrganizationDialog {...editor} data={data} api={api} onClose={() => setEditor(null)} onDone={async () => {
      setEditor(null); setNotice("Company structure saved. Changed account roles require a fresh login."); await load(); onChanged();
    }} />}
  </>;
}

function OrganizationDialog({ mode, person, data, api, onClose, onDone }) {
  const dialog = useRef(null), request = useRef(null);
  const permissions = data.assignments.find(a => a.managerId === person.id);
  const [shopIds, setShopIds] = useState(permissions?.shopIds || []), [workerIds, setWorkerIds] = useState(permissions?.workerIds || []);
  const [role, setRole] = useState(person.role), [saving, setSaving] = useState(false), [error, setError] = useState(""), [frozen, setFrozen] = useState(false);
  useEffect(() => { dialog.current.showModal(); }, []);
  const toggle = (id, list, setter) => setter(list.includes(id) ? list.filter(v => v !== id) : [...list, id]);
  async function submit(e) {
    e.preventDefault(); if (saving) return;
    if (!request.current) request.current = { suffix: mode === "GENERAL" ? "general-manager" : mode === "ROLE" ? "role" : "permissions",
      body: { operationId: operationId(), expectedVersion: data.version,
        ...(mode === "PERMISSIONS" ? { managerId: person.id, shopIds, workerIds } : { accountId: person.id, ...(mode === "ROLE" ? { role } : {}) }) } };
    setSaving(true); setFrozen(true); setError("");
    try { await api("/manager/organization/" + request.current.suffix, { method: "POST", body: JSON.stringify(request.current.body) }); await onDone(); }
    catch (e) { setError(e.status === 409 ? "Company structure changed. Close and reopen this page before saving." : e.message); if (e.status >= 400 && e.status < 500) { request.current = null; setFrozen(false); } }
    finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="attendance-record-dialog people-dialog" onClose={onClose} onCancel={e => { if (saving) e.preventDefault(); }}>
    <form onSubmit={submit}><h2 className="h3">{mode === "GENERAL" ? "Confirm General manager appointment" : mode === "ROLE" ? "Change role" : "Assign manager permissions"}</h2>
      <p>{person.name} · {person.email}</p>{error && <div className="alert alert-danger" role="alert">{error}</div>}
      <fieldset disabled={saving || frozen}>
        {mode === "GENERAL" && <p>The previous General manager becomes a Manager. Affected accounts will be signed out. There can only be one General manager.</p>}
        {mode === "ROLE" && <label className="form-label">Role<select className="form-select mt-1" value={role} onChange={e => setRole(e.target.value)}><option value="MANAGER">Manager</option><option value="WORKER">Groomer</option></select><span className="text-secondary">Role changes sign this person out. Groomer attendance history is retained.</span></label>}
        {mode === "PERMISSIONS" && <><p className="text-secondary">Select any number of stores and groomers. Other managers may have the same assignments. Either assignment grants attendance access.</p>
          <div className="row g-4"><div className="col-md-6"><h3 className="h4">Stores</h3><div className="organization-checklist">{data.shops.map(s => <label className="form-check" key={s.id}><input type="checkbox" className="form-check-input" checked={shopIds.includes(s.id)} onChange={() => toggle(s.id, shopIds, setShopIds)} /><span className="form-check-label">{s.name} ({s.code})</span></label>)}</div></div>
          <div className="col-md-6"><h3 className="h4">Groomers</h3><div className="organization-checklist">{data.people.filter(p => p.role === "WORKER").map(p => <label className="form-check" key={p.id}><input type="checkbox" className="form-check-input" checked={workerIds.includes(p.workerId)} onChange={() => toggle(p.workerId, workerIds, setWorkerIds)} /><span className="form-check-label">{p.name} · {p.employeeCode || "Pending"}{p.status === "DISABLED" ? " (Deleted)" : ""}</span></label>)}</div></div></div></>}
      </fieldset>
      <div className="d-flex justify-content-end gap-2 mt-4"><button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Confirm & save"}</button></div>
    </form>
  </dialog>;
}
