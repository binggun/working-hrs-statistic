import { DateTime } from "luxon";
import { operationId } from "./operationId.js";
import SiteSettings, { useSiteLanguage } from "./SiteSettings.jsx";
import { attendanceSelectionForDay } from "./attendanceSelection.js";
import AttendanceLocationPage from "./AttendanceLocationPage.jsx";
import WorkspaceLayout from "./WorkspaceLayout.jsx";
import OrganizationPage from "./OrganizationPage.jsx";
import ShopsPage from "./ShopsPage.jsx";
import PeoplePage from "./PeoplePage.jsx";
import WorkerPortal from "./WorkerPortal.jsx";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@tabler/core/dist/css/tabler.min.css";
import "./style.css";
const API =
  (import.meta.env.VITE_API_URL || "").replace(/\/$/, "") + "/api/v1";
function App() {
  const t = (en, zh) => language === "zh" ? zh : en;
  const [language, setLanguage] = useSiteLanguage();
  const [session, setSession] = useState(
    sessionStorage.getItem("pawhubSession") || "",
  );
  const [me, setMe] = useState(null);
  const [page, setPage] = useState("PersonalAttendance");
  const [attendanceInitial, setAttendanceInitial] = useState(null);
  const [month, setMonth] = useState(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Auckland",
      year: "numeric",
      month: "2-digit",
    })
      .format(new Date())
      .replace(/(\d{2})\/(\d{4})/, "$2-$1"),
  );
  const [shop, setShop] = useState("");
  const [worker, setWorker] = useState("");
  const [shops, setShops] = useState([]);
  const [managers, setManagers] = useState([]);
  const [resetRequest, setResetRequest] = useState(false);
  const [workers, setWorkers] = useState([]);
  const [attendanceShops, setAttendanceShops] = useState([]);
  const [attendanceWorkers, setAttendanceWorkers] = useState([]);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState(null);
  const [cursor, setCursor] = useState("");
  const [nextCursor, setNextCursor] = useState(null);
  const [activation, setActivation] = useState(
    new URLSearchParams(location.hash.slice(1)).get("activate"),
  );
  const [refresh, setRefresh] = useState(0);
  async function api(path, options = {}) {
    const { responseType, ...requestOptions } = options;
    const response = await fetch(API + path, {
      ...requestOptions,
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: "Bearer " + session } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      if (response.status === 401 && session) {
        sessionStorage.removeItem("pawhubSession");
        setSession("");
        setMe(null); setAttendanceInitial(null); setPage("PersonalAttendance");
      }
      const fields = e.error?.fields;
      const details = Array.isArray(fields)
        ? fields
            .map((issue) => {
              const label =
                {
                  name: "Name",
                  email: "Email",
                }[issue.path?.[0]] ||
                issue.path?.join(".") ||
                "Request";
              return `${label}: ${issue.message}`;
            })
            .join("; ")
        : "";
      throw Object.assign(Error(details || e.error?.message || "Request failed"), { status: response.status });
    }
    if (responseType === "blob") return response.blob();
    return (await response.json()).data;
  }
  async function task(fn) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!session) return;
    let active = true;
    task(async () => {
      const a = await api("/me");
      if (!active) return;
      if (a.role === "WORKER") {
        setMe(a);
        setWorkers([]);
        setManagers([]);
        return;
      }
      if (!["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"].includes(a.role))
        throw Error("Store accounts use the Android app. Please sign out.");
      const [s, w, attendanceStores, attendanceGroomers] = await Promise.all([api("/manager/shops"), api("/manager/workers"), api("/manager/attendance/stores"), api("/manager/attendance/groomers")]);
      if (active) {
        setMe(a);
        setShops(s);
        setWorkers(w);
        setAttendanceShops(attendanceStores);
        setAttendanceWorkers(attendanceGroomers);
        if (["SUPER_MANAGER", "GENERAL_MANAGER"].includes(a.role)) setManagers(await api("/manager/managers"));
      }
    });
    return () => {
      active = false;
    };
  }, [session, refresh]);
  const query = new URLSearchParams({
    month,
    ...(shop ? { shopId: shop } : {}),
    ...(worker ? { workerId: worker } : {}),
  }).toString();
  useEffect(() => {
    if (!me || me.role === "WORKER") return;
    let active = true;
    const path =
      page === "Hours"
        ? "/manager/attendance/summary?" + query
        : page === "Records"
          ? "/manager/attendance?" + query + "&cursor=" + cursor
          : page === "Validate"
            ? "/manager/validations?" + query
            : page === "Invitations"
              ? "/manager/invitations"
              : null;
    if (!path) {
      setRows([]);
      return;
    }
    setRows([]);
    task(async () => {
      const d = await api(path);
      if (active) {
        setRows(d.groups || d.items || d);
        setNextCursor(d.nextCursor || null);
      }
    });
    return () => {
      active = false;
    };
  }, [me, page, query, cursor, refresh]);
  const date = (t) =>
    t
      ? new Intl.DateTimeFormat("en-NZ", {
          timeZone: "Pacific/Auckland",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(t))
      : "—";
  function field(name, label, type = "text", required = true, defaultValue) {
    return (
      <label className="form-label mb-3">
        {label}
        <input
          name={name}
          type={type}
          defaultValue={defaultValue}
          step={type === "number" ? "any" : undefined}
          required={required}
          className="form-control mt-1"
        />
      </label>
    );
  }
  async function login(e) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    await task(async () => {
      const identifier = String(b.identifier).trim();
      const accountId = /^\d{4}$/.test(identifier) ? identifier : null;
      const a = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ ...(accountId ? { accountId } : { email: identifier }), password: b.password }),
      });
      sessionStorage.setItem("pawhubSession", a.sessionToken);
      setSession(a.sessionToken);
    });
  }
  async function requestReset(e) {
    e.preventDefault();
    const identifier = String(new FormData(e.target).get("identifier")).trim();
    const body = /^\d{4}$/.test(identifier) ? { accountId: identifier } : { email: identifier };
    await task(async () => {
      await api("/auth/password-links", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice(
        "If this account exists, a password reset email has been queued.",
      );
      setResetRequest(false);
    });
  }
  async function activate(e) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    await task(async () => {
      const result = await api("/auth/password-links/consume", {
        method: "POST",
        body: JSON.stringify({ token: activation, ...b }),
      });
      setActivation(null);
      historyReplace();
      setNotice(result.awaitingManagerApproval ? "Password set. You can sign in now; recording attendance requires manager activation approval." : "Password set. Please sign in.");
    });
  }
  function historyReplace() {
    window.history.replaceState(null, "", location.pathname);
  }
  async function decision(r, value) {
    await task(async () => {
      await api("/manager/validations/" + r.id + "/decision", {
        method: "POST",
        body: JSON.stringify({
          operationId: operationId(),
          decision: value,
          expectedRecordVersion: r.version,
        }),
      });
      setRefresh((x) => x + 1);
    });
  }
  async function showHistory(id) {
    await task(async () =>
      setHistory(await api("/manager/attendance/" + id + "/history")),
    );
  }
  async function correct(e) {
    e.preventDefault();
    if (history?.record.effective_deleted) { setError("Removed records cannot be adjusted."); return; }
    const form = new FormData(e.target);
    const value = form.get("occurredAt");
    await task(async () => {
      await api("/manager/attendance/" + history.record.id + "/corrections", {
        method: "POST",
        body: JSON.stringify({
          operationId: operationId(),
          expectedRecordVersion: history.record.version,
          type: form.get("type"),
          occurredAt: DateTime.fromISO(value, { zone: "Pacific/Auckland" })
            .toUTC()
            .toISO(),
        }),
      });
      setHistory(null);
      setNotice("Attendance record updated.");
      setRefresh((x) => x + 1);
    });
  }
  async function pdf() {
    await task(async () => {
      const r = await fetch(API + "/manager/reports/pdf", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + session,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: operationId(),
          month,
          ...(shop ? { shopId: shop } : {}),
          ...(worker ? { workerId: worker } : {}),
          reportType: page === "Records" ? "ATTENDANCE" : "TIMESHEET",
        }),
      });
      if (!r.ok)
        throw Error((await r.json()).error?.message || "Export failed");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "Pawhub-" + month + ".pdf";
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  if (!session || activation)
    return (
      <div className="page page-center">
        <div className="container-tight py-4">
          <div className="brand text-center mb-4">
            Pawhub<span>Attendance workspace</span>
          </div>
          <form
            className="card card-md"
            onSubmit={
              activation ? activate : resetRequest ? requestReset : login
            }
          >
            <div className="card-body">
              <h2 className="card-title text-center mb-4">
                {activation
                  ? "Set your password"
                  : resetRequest
                    ? "Reset your password"
                    : "Welcome back"}
              </h2>
              {error && (
                <div role="alert" className="alert alert-danger">
                  {error}
                </div>
              )}
              {notice && <div className="alert alert-success">{notice}</div>}
              {activation ? (
                field(
                  "newPassword",
                  "New password (6–128 characters)",
                  "password",
                )
              ) : (
                <>
                  {field("identifier", "Email or employee ID (4 digits)")}
                  {!resetRequest && field("password", "Password", "password")}
                </>
              )}
              <button disabled={busy} className="btn btn-primary w-100">
                {busy
                  ? "Please wait…"
                  : activation
                    ? "Activate account"
                    : resetRequest
                      ? "Send reset link"
                      : "Sign in"}
              </button>
              {!activation && (
                <button
                  type="button"
                  className="btn btn-link w-100 mt-2"
                  onClick={() => {
                    setResetRequest(!resetRequest);
                    setError("");
                  }}
                >
                  {resetRequest ? "Back to sign in" : "Forgot password?"}
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    );
  const logout = async () => {
    try { await api("/auth/logout", { method: "POST" }); }
    finally {
      sessionStorage.removeItem("pawhubSession");
      setSession(""); setMe(null); setAttendanceInitial(null); setPage("PersonalAttendance"); setRows([]); setHistory(null);
      setShops([]); setWorkers([]); setAttendanceShops([]); setAttendanceWorkers([]); setManagers([]); setError("");
    }
  };
  if (!me) return <main className="container py-5">
    <p role="status">{error || "Loading account…"}</p>
    <button className="btn" onClick={() => task(logout)}>Sign out</button>
  </main>;
  const navigate = value => {
    setAttendanceInitial(null);
    setRows([]); setPage(value === "Records" ? "PersonalAttendance" : value); setCursor(""); setError(""); setNotice(""); setHistory(null);
  };
  if (me.role === "WORKER" || ["PersonalAttendance", "Profile", "Settings"].includes(page)) return <WorkerPortal account={me} api={api} logout={logout} session={session}
    onAccountSaved={p => setMe(p)} language={language} onLanguage={setLanguage}
    initialSelection={attendanceInitial}
    view={page === "Profile" ? "profile" : page === "Settings" ? "settings" : "attendance"} navigationPage={page} onNavigate={navigate} />;
  return (
    <WorkspaceLayout account={me} active={page} onNavigate={navigate} logout={() => task(logout)} language={language} busy={busy}>
      <main className="page-wrapper">
        <div className="container-xl workspace-content">
          <header className="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h1 className="mt-1">
                {
                  {
                    Hours: t("Attendance", "签到记录"),
                    Records: t("Attendance records", "签到管理"),
                    Validate: t("Validation queue", "审批列表"),
                    People: t("Groomer", "Groomer 管理"),
                    Invitations: "Invitation status",
                    Shops: t("Shops", "门店管理"),
                    Settings: language === "zh" ? "网站设置" : "Website settings",
                    Organization: t("Structure", "公司体系"),
                    Locations: t("Attendance GPS", "签到定位"),
                  }[page]
                }
              </h1>
            </div>
            <div className="d-flex gap-2">
              <button className="btn" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("Refresh", "刷新")}</button>
            {["Hours", "Records"].includes(page) && (
              <button className="btn btn-primary" disabled={busy} onClick={pdf}>
                Download PDF
              </button>
            )}
            </div>
          </header>
          {["Hours", "Records"].includes(page) && <nav className="d-flex gap-2 mb-3" aria-label={t("Attendance management", "签到管理")}>
            {[["PersonalAttendance", t("Records & daily hours", "记录与每日工时")], ["Hours", t("Monthly summary", "月度汇总")]].map(([key, label]) => <button key={key} className={"btn " + (page === key ? "btn-primary" : "")} onClick={() => { setRows([]); setPage(key); setCursor(""); setError(""); }}>{label}</button>)}
          </nav>}
          {["People", "Invitations"].includes(page) && <nav className="d-flex gap-2 mb-3" aria-label={t("Groomer management", "Groomer 管理")}>
            {[["People", t("Groomers", "Groomer 资料")], ["Invitations", t("Invitation status", "邀请邮件状态")]].map(([key, label]) => <button key={key} className={"btn " + (page === key ? "btn-primary" : "")} onClick={() => { setRows([]); setPage(key); setError(""); }}>{label}</button>)}
          </nav>}
          {["Hours", "Records", "Validate"].includes(page) && <p className="text-secondary">{t("Attendance access is granted by either an assigned store or an assigned groomer. Store and groomer profiles require their own assignments.", "拥有门店或 Groomer 任一权限即可管理对应签到；门店资料和员工资料分别按各自授权显示。")}</p>}
          {page === "Validate" && <p className="text-secondary">{t("Review the latest requested change, then approve or reject. New personnel are approved by the General manager.", "请审核最新的新增、修改或删除申请，再批准或拒绝。新增人员由 General manager 确认。")}</p>}
          {error && (
            <div role="alert" className="alert alert-danger">
              {error}
            </div>
          )}
          {notice && <div className="alert alert-success">{notice}</div>}
          {["Hours", "Records", "Validate"].includes(page) && (
            <div className="card mb-4">
              <div className="card-body">
                <div className="row g-3">
                <label className="col-md-4 form-label">
                  Month
                  <input
                    aria-label="Month"
                    type="month"
                    className="form-control mt-1"
                    value={month}
                    onChange={(e) => {
                      setMonth(e.target.value);
                      setRows([]); setHistory(null);
                      setCursor("");
                    }}
                  />
                </label>
                <label className="col-md-4 form-label">
                  Shop
                  <select
                    className="form-select mt-1"
                    value={shop}
                    onChange={(e) => {
                      setShop(e.target.value);
                      setRows([]); setHistory(null);
                      setCursor("");
                    }}
                  >
                    <option value="">All accessible stores</option>
                    {attendanceShops.map((s) => (
                      <option key={s.id} value={s.shopId}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="col-md-4 form-label">
                  Person
                  <select
                    className="form-select mt-1"
                    value={worker}
                    onChange={(e) => {
                      setWorker(e.target.value);
                      setRows([]); setHistory(null);
                      setCursor("");
                    }}
                  >
                    <option value="">All accessible groomers</option>
                    {attendanceWorkers.map((w) => (
                      <option key={w.id} value={w.workerId}>
                        {w.name} · {w.workerId}
                      </option>
                    ))}
                  </select>
                </label>
                </div>
              </div>
            </div>
          )}
          {busy && (
            <div className="text-secondary mb-3" role="status">
              Loading…
            </div>
          )}
          {page === "Hours" && (
            <>
              <div className="row g-3 mb-4">
                {[
                  [
                    "Confirmed hours",
                    rows.reduce(
                      (n, r) => n + Math.round(Number(r.confirmedHrs) * 100),
                      0,
                    ) / 100,
                  ],
                  [
                    "Pending periods",
                    rows.reduce((n, r) => n + r.pendingSegmentCount, 0),
                  ],
                  [
                    "Errors to review",
                    rows.reduce((n, r) => n + r.invalidSegmentCount, 0),
                  ],
                ].map(([label, value]) => (
                  <div className="col-md-4" key={label}>
                    <div className="card">
                      <div className="card-body">
                        <div className="text-secondary">{label}</div>
                        <div className="metric">
                          {label === "Confirmed hours"
                            ? value.toFixed(2)
                            : value}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Table
                headers={[
                  "Person",
                  "Shop",
                  "Confirmed hrs",
                  "Pending",
                  "Errors",
                ]}
                rows={rows.map((r) => [
                  r.worker_name + " · " + r.workerId,
                  r.shop_name,
                  r.confirmedHrs,
                  r.pendingSegmentCount,
                  r.invalidSegmentCount,
                ])}
              />
              <p className="text-secondary mt-3">
                Pending and invalid periods are excluded from confirmed hours.
              </p>
            </>
          )}
          {page === "Validate" && (
            <Table
              headers={[
                "Person / Shop",
                "Request / issue",
                "Source",
                "Original",
                "Requested",
                "Type before",
                "Type requested",
                "Action",
              ]}
              rows={rows.map((r) => [
                r.worker_name + " / " + (r.shop_name || r.email || "—"),
                r.item_type === "PERSON_APPROVAL" ? t("New person", "新增人员") : ({ ADD: t("Add record", "新增记录"), UPDATE: t("Change record", "修改记录"), DELETE: t("Remove record", "删除记录") }[r.action] || r.issue_code || "—"),
                r.source || "—",
                date(r.before_at || r.original_occurred_at),
                date(r.after_at),
                r.before_type || "—",
                r.after_type || "—",
                r.item_type === "PERSON_APPROVAL" ? (
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => task(async () => {
                    await api("/manager/accounts/" + r.account_id + "/approve", { method: "POST", body: JSON.stringify({ operationId: operationId() }) });
                    setNotice("Person approved; confirmation email queued."); setRefresh(x => x + 1);
                  })}>Approve new person</button>
                ) : r.item_type === "ADJUSTMENT" ? (
                  <div className="d-flex gap-2">
                    <button
                      disabled={busy}
                      className="btn btn-sm btn-primary"
                      onClick={() => decision(r, "APPROVE")}
                    >
                      Approve
                    </button>
                    <button
                      disabled={busy}
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => decision(r, "REJECT")}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      const selection=attendanceSelectionForDay({date:r.local_date,workerCode:r.worker_code,shopCode:r.shop_code});
                      setAttendanceInitial({...selection,staffOption:{id:r.worker_id,workerId:r.worker_code,name:r.worker_name,status:"ACTIVE"}});
                      setPage("PersonalAttendance");setRows([]);setError("");setNotice("");setHistory(null);
                    }}
                  >
                    {t("Review", "查看")}
                  </button>
                ),
              ])}
            />
          )}
          {page === "People" && <PeoplePage account={me} workers={workers} managers={managers} shops={attendanceShops}
            api={api} busy={busy} task={task} Table={Table}
            onChanged={message => { setNotice(message); setRefresh(x => x + 1); }} />}
          {page === "Invitations" && (
            <Table
              headers={[
                "Name",
                "Delivery status",
                "Created",
                "Expires",
                "Activated",
              ]}
              rows={rows.map((r) => [
                r.name,
                r.status,
                date(r.created_at),
                date(r.expires_at),
                date(r.used_at),
              ])}
            />
          )}
          {page === "Shops" && <ShopsPage account={me} shops={shops} api={api} task={task} busy={busy} Table={Table}
            onChanged={message => { setNotice(message); setRefresh(x => x + 1); }} />}
          {page === "Settings" && <SiteSettings language={language} onLanguage={setLanguage} />}
          {page === "Locations" && ["GENERAL_MANAGER","SUPER_MANAGER"].includes(me.role) && <AttendanceLocationPage key={refresh} api={api} language={language} />}
          {page === "Organization" && <OrganizationPage account={me} api={api} onChanged={() => setRefresh(x => x + 1)} />}

        </div>
      </main>
      {history && (
        <div className="detail-overlay">
          <section className="card detail">
            <div className="card-header d-flex justify-content-between">
              <h2 className="card-title">Record history & adjustment</h2>
              <button className="btn btn-sm" onClick={() => setHistory(null)}>
                Close
              </button>
            </div>
            <div className="card-body">
              {error && (
                <div role="alert" className="alert alert-danger">
                  {error}
                </div>
              )}
              <p>Original: {date(history.record.original_occurred_at)}</p>
              <p>Original type: {history.record.original_sign_type || history.record.sign_type}</p>
              <p>Current type: {history.record.sign_type}</p>
              <p>Planned: {date(history.record.planned_start_at)}</p>
              <p>Confirmed: {date(history.record.manager_confirmed ? history.record.confirmed_occurred_at : null)}</p>
              <Table
                headers={["Source", "Before", "After", "Type before", "Type after", "Result"]}
                rows={history.history.map((r) => [
                  r.source,
                  date(r.before_at),
                  date(r.after_at),
                  r.before_type || "—",
                  r.after_type || "—",
                  r.status,
                ])}
              />
              {history.record.effective_deleted ? <p className="mt-4 text-secondary">Status: removal. Original data and history are retained; time adjustment is unavailable.</p> : <form className="mt-4" onSubmit={correct}>
                {field(
                  "occurredAt",
                  "Time (Pacific/Auckland)",
                  "datetime-local",
                  true,
                  DateTime.fromISO(history.record.effective_occurred_at).setZone("Pacific/Auckland").toFormat("yyyy-MM-dd'T'HH:mm"),
                )}
                <label className="form-label mb-3">
                  Attendance type
                  <select name="type" className="form-select mt-1" defaultValue={history.record.sign_type} required>
                    <option value="SIGN_IN">Clock in / 上班</option>
                    <option value="SIGN_OUT">Clock out / 下班</option>
                  </select>
                </label>
                <button disabled={busy} className="btn btn-primary">
                  Save changes
                </button>
                <p className="text-secondary mt-2">
                  Manager changes take effect immediately.
                  Any pending request is superseded by this manager change and retained in history.
                </p>
              </form>}
            </div>
          </section>
        </div>
      )}
    </WorkspaceLayout>
  );
}
function Table({ headers, rows }) {
  return (
    <div className="card">
      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  className="text-secondary text-center py-5"
                  colSpan={headers.length}
                >
                  No records for this selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
