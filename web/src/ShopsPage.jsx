import React, { useEffect, useRef, useState } from "react";
import { operationId } from "./operationId.js";
export default function ShopsPage({ account, shops, api, busy, Table, onChanged }) {
  const [editor, setEditor] = useState(null);
  const [search, setSearch] = useState("");
  const admin = ["SUPER_MANAGER", "GENERAL_MANAGER"].includes(account.role);
  return <>
    <div className="d-flex justify-content-between align-items-center gap-3 mb-4"><p className="text-secondary mb-0">Stores within your permission scope.</p>{admin && <button className="btn btn-primary" disabled={busy} onClick={() => setEditor({})}>Add store</button>}</div>
    <label className="form-label mb-3">Search stores<input className="form-control mt-1" type="search" placeholder="Name, store ID or address" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <Table headers={["Store ID", "Name", "Address", "Actions"]} rows={shops.filter(s => [s.name, s.shopId, s.address].some(value => String(value || "").toLowerCase().includes(search.trim().toLowerCase()))).map(s => [s.shopId, s.name, s.address, <button className="btn btn-sm" disabled={busy} onClick={() => setEditor(s)}>Edit store</button>])} />
    {editor && <ShopDialog shop={editor} api={api} onClose={() => setEditor(null)} onDone={() => { setEditor(null); onChanged("Store saved; address coordinates updated."); }} />}
  </>;
}
function ShopDialog({ shop, api, onClose, onDone }) {
  const dialog = useRef(null), request = useRef(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [frozen, setFrozen] = useState(false);
  useEffect(() => { dialog.current.showModal(); }, []);
  async function submit(e) {
    e.preventDefault(); if (saving) return;
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    if (!request.current) request.current = { url: shop.id ? `/manager/shops/${shop.id}/profile` : "/manager/shops",
      body: { operationId: operationId(), name: fields.name.trim(), address: fields.address.trim(),
        ...(shop.id ? { expectedVersion: shop.profile_version } : { shopId: fields.shopId.trim(), password: fields.password }) } };
    setSaving(true); setFrozen(true); setError("");
    try { await api(request.current.url, { method: "POST", body: JSON.stringify(request.current.body) }); onDone(); }
    catch (e) { setError(e.message); if (e.status >= 400 && e.status < 500) { request.current = null; setFrozen(false); } }
    finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="attendance-record-dialog" onClose={onClose} onCancel={e => { if (saving) e.preventDefault(); }}><form onSubmit={submit}>
    <h2 className="h3 mb-4">{shop.id ? "Edit store" : "Add store"}</h2>{error && <div role="alert" className="alert alert-danger">{error}</div>}
    <fieldset disabled={saving || frozen}>
      {!shop.id && <label className="form-label mb-3">Store ID<input name="shopId" required pattern="00[0-9]{2}" className="form-control mt-1" placeholder="0001" /></label>}
      <label className="form-label mb-3">Store name<input name="name" required maxLength={200} defaultValue={shop.name || ""} className="form-control mt-1" /></label>
      <label className="form-label mb-3">Address<input name="address" required maxLength={500} defaultValue={shop.address || ""} className="form-control mt-1" /></label>
      {!shop.id && <label className="form-label mb-3">Store password (6–128 characters)<input name="password" type="password" required minLength={6} maxLength={128} className="form-control mt-1" /></label>}
    </fieldset><div className="d-flex justify-content-end gap-2 mt-4"><button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save store"}</button></div>
  </form></dialog>;
}
