import React, { useEffect, useRef, useState } from "react";
import { operationId } from "./operationId.js";

export default function AccountSettings({ api, logout, language, onSaved }) {
  const [profile, setProfile] = useState(null), [shops, setShops] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [password, setPassword] = useState(false);
  const request = useRef(null);
  const t = (en, zh) => language === "zh" ? zh : en;
  async function load() {
    setError("");
    try { const [p, s] = await Promise.all([api("/me/profile"), api("/me/stores")]); setProfile(p); setShops(s); request.current = null; }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function save(event) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    request.current ||= { operationId: operationId(), expectedVersion: profile.version,
      firstName: form.get("firstName"), lastName: form.get("lastName"), address: form.get("address"),
      phone: form.get("phone"), preferredShopId: form.get("preferredShopId") || null };
    setBusy(true); setError(""); setNotice("");
    try { const p = await api("/me/profile", { method: "POST", body: JSON.stringify(request.current) }); setProfile(p); request.current = null; onSaved?.(p); setNotice(t("Profile saved.", "资料已保存。")); }
    catch (e) { setError(e.message); if (e.status >= 400 && e.status < 500) request.current = null; }
    finally { setBusy(false); }
  }
  return <>
    {error && <div className="alert alert-danger" role="alert">{error}<button className="btn btn-sm ms-3" disabled={busy} onClick={load}>{t("Reload", "重新加载")}</button></div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    {!profile ? <p role="status">{t("Loading profile…", "正在加载资料…")}</p> : <form key={profile.version} className="card card-body" onSubmit={save}>
      <div className="mb-4"><div className="form-label">{t("Registered email", "注册邮箱")}</div><div>{profile.email || "—"}</div></div>
      {profile.accountId && <p>{t("Employee ID", "员工号")}: {profile.accountId}</p>}
      <fieldset disabled={busy || !!request.current}>
        <div className="row g-3">
          {[["firstName", "First name", "名", 100], ["lastName", "Last name", "姓", 100], ["address", "Address", "地址", 500], ["phone", "Phone", "电话", 50]].map(([name, en, zh, max]) => <label key={name} className="col-md-6 form-label">{t(en, zh)}<input name={name} className="form-control mt-1" defaultValue={profile[name] || ""} maxLength={max} required={name === "firstName"} autoComplete={name === "phone" ? "tel" : "off"} /></label>)}
          <label className="col-12 form-label">{t("Preferred store", "首选门店")}<select name="preferredShopId" className="form-select mt-1" defaultValue={profile.preferredShopId || ""}>
            <option value="">{t("No preferred store", "不设置首选门店")}</option>
            {profile.preferredShopId && !shops.some(s => s.shopId === profile.preferredShopId) && <option value={profile.preferredShopId}>{t("Store removed or renamed — please update", "门店已删除或改名，请更新")}</option>}
            {shops.map(s => <option key={s.id} value={s.shopId}>{s.name}</option>)}
          </select></label>
        </div>
      </fieldset>
      <button className="btn btn-primary mt-4" disabled={busy}>{busy ? t("Saving…", "正在保存…") : t("Save profile", "保存资料")}</button>
      <button className="btn btn-sm mt-3" type="button" disabled={busy} onClick={() => setPassword(true)}>{t("Change password", "修改密码")}</button>
    </form>}
    {password && <PasswordDialog api={api} logout={logout} onClose={() => setPassword(false)} t={t} />}
  </>;
}
function PasswordDialog({ api, logout, onClose, t }) {
  const dialog = useRef(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} className="attendance-record-dialog" onCancel={e => { if (busy) e.preventDefault(); }} onClose={onClose} aria-label={t("Change password", "修改密码")}>
    <h2 className="h3">{t("Change password", "修改密码")}</h2>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    <form onSubmit={async e => { e.preventDefault(); if (busy) return; const f = new FormData(e.currentTarget); if (f.get("newPassword") !== f.get("confirm")) { setError(t("Passwords do not match.", "两次密码不一致。")); return; } setBusy(true); setError(""); try { await api("/me/password", { method: "POST", body: JSON.stringify({ currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword") }) }); window.alert(t("Password changed. Please sign in again.", "密码已修改，请重新登录。")); await logout(); } catch (err) { setError(err.message); } finally { setBusy(false); } }}>
      {[["currentPassword", "Current password", "当前密码"], ["newPassword", "New password", "新密码"], ["confirm", "Confirm new password", "确认新密码"]].map(([name, en, zh]) => <label className="form-label mb-3 d-block" key={name}>{t(en, zh)}<input className="form-control mt-1" type="password" name={name} required minLength={name === "currentPassword" ? 1 : 6} maxLength={128} disabled={busy} autoComplete={name === "currentPassword" ? "current-password" : "new-password"} /></label>)}
      <p className="text-secondary">{t("Minimum 6 characters; any letter case or symbols allowed.", "至少 6 位，不限制大小写和特殊符号。")}</p>
      <div className="d-flex gap-2"><button className="btn btn-primary" disabled={busy}>{t("Confirm", "确认")}</button><button className="btn" type="button" disabled={busy} onClick={onClose}>{t("Cancel", "取消")}</button></div>
    </form>
  </dialog>;
}
