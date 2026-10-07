import { DateTime } from "luxon";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@tabler/core/dist/css/tabler.min.css";
import "./style.css";
const API =
  (import.meta.env.VITE_API_URL || "http://localhost:3000") + "/api/v1";
function App() {
  const [session, setSession] = useState(
    sessionStorage.getItem("pawhubSession") || "",
  );
  const [me, setMe] = useState(null);
  const [page, setPage] = useState("Hours");
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
    const response = await fetch(API + path, {
      ...options,
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
        setMe(null);
      }
      throw Error(e.error?.message || "Request failed");
    }
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
      const [a, s, w] = await Promise.all([
        api("/me"),
        api("/manager/shops"),
        api("/manager/workers"),
      ]);
      if (active) {
        setMe(a);
        setShops(s);
        setWorkers(w);
        if (a.role === "SUPER_MANAGER")
          setManagers(await api("/manager/managers"));
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
    if (!me) return;
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
  function field(name, label, type = "text", required = true) {
    return (
      <label className="form-label mb-3">
        {label}
        <input
          name={name}
          type={type}
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
      const a = await api("/manager/auth/login", {
        method: "POST",
        body: JSON.stringify(b),
      });
      sessionStorage.setItem("pawhubSession", a.sessionToken);
      setSession(a.sessionToken);
    });
  }
  async function requestReset(e) {
    e.preventDefault();
    const email = new FormData(e.target).get("email");
    await task(async () => {
      await api("/auth/password-links", {
        method: "POST",
        body: JSON.stringify({ email }),
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
      await api("/auth/password-links/consume", {
        method: "POST",
        body: JSON.stringify({ token: activation, ...b }),
      });
      setActivation(null);
      historyReplace();
      setNotice("Password set. Please sign in.");
    });
  }
  function historyReplace() {
    window.history.replaceState(null, "", location.pathname);
  }
  async function addPerson(e) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    const kind = b.kind;
    delete b.kind;
    b.shopIds = new FormData(e.target).getAll("shopIds");
    b.operationId = crypto.randomUUID();
    await task(async () => {
      await api("/manager/" + (kind === "manager" ? "managers" : "workers"), {
        method: "POST",
        body: JSON.stringify(b),
      });
      e.target.reset();
      setNotice("Account created; invitation queued.");
      setRefresh((x) => x + 1);
    });
  }
  async function decision(r, value) {
    await task(async () => {
      await api("/manager/validations/" + r.id + "/decision", {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
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
    const value = new FormData(e.target).get("occurredAt");
    await task(async () => {
      await api("/manager/attendance/" + history.record.id + "/corrections", {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedRecordVersion: history.record.version,
          occurredAt: DateTime.fromISO(value, { zone: "Pacific/Auckland" })
            .toUTC()
            .toISO(),
        }),
      });
      setHistory(null);
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
          operationId: crypto.randomUUID(),
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
      a.download = "pawhub-" + month + ".pdf";
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  if (!session || activation)
    return (
      <div className="page page-center">
        <div className="container-tight py-4">
          <div className="brand text-center mb-4">
            pawhub<span>Manager workspace</span>
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
                  "New password (12+ characters)",
                  "password",
                )
              ) : (
                <>
                  {field("email", "Email", "email")}
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
  return (
    <div className="page">
      <aside className="navbar navbar-vertical navbar-expand-lg">
        <div className="container-fluid">
          <div className="brand my-4">
            pawhub<span>Manager workspace</span>
          </div>
          <nav className="nav flex-column w-100">
            {[
              "Hours",
              "Records",
              "Validate",
              "People",
              "Invitations",
              ...(me?.role === "SUPER_MANAGER" ? ["Shops"] : []),
            ].map((x) => (
              <button
                key={x}
                className={
                  "nav-link text-start " + (page === x ? "active" : "")
                }
                onClick={() => {
                  setRows([]);
                  setPage(x);
                  setCursor("");
                  setError("");
                }}
              >
                {
                  {
                    Hours: "Monthly hours",
                    Records: "Attendance records",
                    Validate: "Validation queue",
                    People: "People",
                    Invitations: "Invitations",
                    Shops: "Shops",
                  }[x]
                }
              </button>
            ))}
          </nav>
          <div className="mt-auto small text-secondary py-4">
            {me?.name}
            <button
              className="btn btn-sm mt-2 w-100"
              onClick={() =>
                task(async () => {
                  await api("/auth/logout", { method: "POST" });
                  sessionStorage.removeItem("pawhubSession");
                  setSession("");
                  setMe(null);
                })
              }
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="page-wrapper">
        <div className="container-xl py-4">
          <header className="d-flex justify-content-between align-items-center mb-4">
            <div>
              <div className="text-secondary small text-uppercase">
                Pawhub · Pacific/Auckland
              </div>
              <h1 className="mt-1">
                {
                  {
                    Hours: "Monthly hours",
                    Records: "Attendance records",
                    Validate: "Validation queue",
                    People: "People & accounts",
                    Invitations: "Invitation status",
                    Shops: "Manage shops",
                  }[page]
                }
              </h1>
            </div>
            {["Hours", "Records"].includes(page) && (
              <button className="btn btn-primary" disabled={busy} onClick={pdf}>
                Download PDF
              </button>
            )}
          </header>
          {error && (
            <div role="alert" className="alert alert-danger">
              {error}
            </div>
          )}
          {notice && <div className="alert alert-success">{notice}</div>}
          {["Hours", "Records", "Validate"].includes(page) && (
            <div className="card mb-4">
              <div className="card-body row g-3">
                <label className="col-md-4 form-label">
                  Month
                  <input
                    aria-label="Month"
                    type="month"
                    className="form-control mt-1"
                    value={month}
                    onChange={(e) => {
                      setMonth(e.target.value);
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
                      setCursor("");
                    }}
                  >
                    <option value="">All managed shops</option>
                    {shops.map((s) => (
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
                      setCursor("");
                    }}
                  >
                    <option value="">All people</option>
                    {workers.map((w) => (
                      <option key={w.id} value={w.workerId}>
                        {w.name} · {w.workerId}
                      </option>
                    ))}
                  </select>
                </label>
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
          {page === "Records" && (
            <>
              <Table
                headers={[
                  "Person / Shop",
                  "Type",
                  "Original time",
                  "Confirmed time",
                  "State",
                  "Details",
                ]}
                rows={rows.map((r) => [
                  r.worker_name + " / " + r.shop_name,
                  r.sign_type,
                  date(r.original_occurred_at),
                  date(r.confirmed_occurred_at),
                  r.pending
                    ? "Pending"
                    : r.confirmed_deleted
                      ? "Deleted"
                      : "Confirmed",
                  <button
                    className="btn btn-sm"
                    onClick={() => showHistory(r.id)}
                  >
                    View / adjust
                  </button>,
                ])}
              />
              <div className="mt-3">
                <button
                  className="btn me-2"
                  disabled={!cursor || busy}
                  onClick={() => setCursor("")}
                >
                  First page
                </button>
                <button
                  className="btn"
                  disabled={!nextCursor || busy}
                  onClick={() => setCursor(nextCursor)}
                >
                  Next page
                </button>
              </div>
            </>
          )}
          {page === "Validate" && (
            <Table
              headers={[
                "Person / Shop",
                "Reason",
                "Original",
                "Requested",
                "Action",
              ]}
              rows={rows.map((r) => [
                r.worker_name + " / " + r.shop_name,
                r.source || r.issue_code,
                date(r.before_at || r.original_occurred_at),
                date(r.after_at),
                r.item_type === "ADJUSTMENT" ? (
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
                    onClick={() =>
                      showHistory(r.sign_out_record_id || r.sign_in_record_id)
                    }
                  >
                    Review / correct
                  </button>
                ),
              ])}
            />
          )}
          {page === "People" && (
            <>
              <div className="card mb-4">
                <div className="card-header">
                  <h2 className="card-title">Add an account</h2>
                </div>
                <form className="card-body" onSubmit={addPerson}>
                  <div className="row">
                    <div className="col-md-6">
                      {field("name", "Name")}
                      {field("email", "Email", "email")}
                      <label className="form-label mb-3">
                        Account type
                        <select className="form-select" name="kind">
                          <option value="worker">Groomer</option>
                          {me?.role === "SUPER_MANAGER" && (
                            <option value="manager">Manager</option>
                          )}
                        </select>
                      </label>
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Assigned shops</label>
                      {shops.map((s) => (
                        <label key={s.id} className="form-check mb-2">
                          <input
                            type="checkbox"
                            name="shopIds"
                            value={s.shopId}
                            className="form-check-input"
                          />
                          <span className="form-check-label">{s.name}</span>
                        </label>
                      ))}
                      <p className="text-secondary">
                        An invitation email lets the person set their password.
                      </p>
                    </div>
                  </div>
                  <button disabled={busy} className="btn btn-primary">
                    Create & invite
                  </button>
                </form>
              </div>
              <Table
                headers={["Name", "ID", "Email", "Status", "Invitation"]}
                rows={workers.map((w) => [
                  w.name,
                  w.workerId,
                  w.email,
                  w.status,
                  w.status === "PENDING" ? (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        task(async () => {
                          await api(
                            "/manager/accounts/" + w.accountId + "/invitations",
                            {
                              method: "POST",
                              body: JSON.stringify({
                                operationId: crypto.randomUUID(),
                              }),
                            },
                          );
                          setNotice("Invitation queued");
                          setRefresh((x) => x + 1);
                        })
                      }
                    >
                      Resend invitation
                    </button>
                  ) : (
                    "—"
                  ),
                ])}
              />
            </>
          )}
          {page === "People" && me?.role === "SUPER_MANAGER" && (
            <div className="mt-4">
              <h2>Managers</h2>
              <Table
                headers={["Name", "Email", "Status", "Invitation"]}
                rows={managers.map((m) => [
                  m.name,
                  m.email,
                  m.status,
                  m.status === "PENDING" ? (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        task(async () => {
                          await api(
                            "/manager/accounts/" + m.accountId + "/invitations",
                            {
                              method: "POST",
                              body: JSON.stringify({
                                operationId: crypto.randomUUID(),
                              }),
                            },
                          );
                          setNotice("Invitation queued");
                          setRefresh((x) => x + 1);
                        })
                      }
                    >
                      Resend invitation
                    </button>
                  ) : (
                    "—"
                  ),
                ])}
              />
            </div>
          )}
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
          {page === "Shops" && (
            <>
              <form
                className="card card-body mb-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const b = Object.fromEntries(new FormData(e.target));
                  b.latitude = Number(b.latitude);
                  b.longitude = Number(b.longitude);
                  b.operationId = crypto.randomUUID();
                  task(async () => {
                    await api("/manager/shops", {
                      method: "POST",
                      body: JSON.stringify(b),
                    });
                    e.target.reset();
                    setNotice("Shop created");
                    setRefresh((x) => x + 1);
                  });
                }}
              >
                <h2>Add shop</h2>
                <div className="row">
                  <div className="col-md-6">
                    {field("shopId", "Four digit ID (0001–0099)")}
                    {field("name", "Shop name")}
                    {field("address", "Address")}
                  </div>
                  <div className="col-md-6">
                    {field("latitude", "Latitude", "number")}
                    {field("longitude", "Longitude", "number")}
                    {field(
                      "password",
                      "Shop password (12+ characters)",
                      "password",
                    )}
                  </div>
                </div>
                <button
                  disabled={busy}
                  className="btn btn-primary align-self-start"
                >
                  Create shop
                </button>
              </form>
              <Table
                headers={["ID", "Name", "Address"]}
                rows={shops.map((s) => [s.shopId, s.name, s.address])}
              />
            </>
          )}
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
              <p>Planned: {date(history.record.planned_start_at)}</p>
              <p>Confirmed: {date(history.record.confirmed_occurred_at)}</p>
              <Table
                headers={["Source", "Before", "After", "Result"]}
                rows={history.history.map((r) => [
                  r.source,
                  date(r.before_at),
                  date(r.after_at),
                  r.status,
                ])}
              />
              <form className="mt-4" onSubmit={correct}>
                {field(
                  "occurredAt",
                  "New time (Pacific/Auckland)",
                  "datetime-local",
                )}
                <button disabled={busy} className="btn btn-primary">
                  Confirm time adjustment
                </button>
                <p className="text-secondary mt-2">
                  The original record remains unchanged. Reject a pending
                  adjustment before making a manual correction.
                </p>
              </form>
            </div>
          </section>
        </div>
      )}
    </div>
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
