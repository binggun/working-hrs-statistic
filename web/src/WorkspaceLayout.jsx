import React from "react";

export default function WorkspaceLayout({ account, active, onNavigate, logout, language, busy = false, children }) {
  const t = (en, zh) => language === "zh" ? zh : en;
  const manager = ["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"].includes(account.role);
  const admin = ["GENERAL_MANAGER", "SUPER_MANAGER"].includes(account.role);
  const items = [
    ["PersonalAttendance", t("Attendance", "签到记录")],
    ...(manager ? [["Validate", t("Validation queue", "审批列表")]] : []),
    ...(admin ? [["People", t("Groomer", "Groomer 管理")], ["Shops", t("Shops", "门店管理")], ["Organization", t("Structure", "公司体系")], ["Locations", t("Attendance GPS", "签到定位")]] : []),
  ];
  const selected = ["Hours", "Records"].includes(active) ? "PersonalAttendance" : active === "Invitations" ? "People" : active;
  const link = ([key, label]) => <button key={key} className={"nav-link text-start w-100 " + (selected === key ? "active" : "")} aria-current={selected === key ? "page" : undefined} disabled={busy} onClick={() => onNavigate(key)}>{label}</button>;
  return <div className="page manager-workspace shared-workspace">
    <aside className="navbar navbar-vertical navbar-expand-lg">
      <div className="container-fluid">
        <div className="brand my-4">Pawhub<span>{account.name}</span></div>
        <nav className="nav flex-column w-100" aria-label={t("Features", "功能栏")}>{items.map(link)}</nav>
        <div className="workspace-sidebar-footer mt-auto w-100 pt-4">
          <nav className="nav flex-column w-100" aria-label={t("Website and account", "网站与账号")}>
            <a className="nav-link text-start w-100" href="/appdownload">{t("Download Android App", "下载 Android App")}</a>
            {[["Settings", t("Website settings", "网站设置")], ["Profile", t("My account", "我的账号")]].map(link)}
          </nav>
          <button className="btn btn-sm w-100 mt-2" disabled={busy} onClick={logout}>{t("Sign out", "退出登录")}</button>
        </div>
      </div>
    </aside>
    {children}
  </div>;
}
