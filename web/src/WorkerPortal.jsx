import React, { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import { operationId } from "./operationId.js";
import { attendanceSelectionForDay } from "./attendanceSelection.js";
import MultiSelectFilter from "./MultiSelectFilter.jsx";
import WorkspaceLayout from "./WorkspaceLayout.jsx";
import SiteSettings from "./SiteSettings.jsx";
import AccountSettings from "./AccountSettings.jsx";
import AttendanceAdjustDialog from "./AttendanceAdjustDialog.jsx";
import AttendanceHistoryDialog from "./AttendanceHistoryDialog.jsx";
import AttendancePhotoLink from "./AttendancePhotoLink.jsx";
import AttendanceRecordDialog from "./AttendanceRecordDialog.jsx";

const zone = "Pacific/Auckland";
const displayTime = (value) => value ? DateTime.fromISO(value).setZone(zone).toFormat("dd/MM/yyyy HH:mm") : "—";

export default function WorkerPortal({ account, api, logout, session, onAccountSaved, language, onLanguage, view = "attendance", navigationPage = "PersonalAttendance", onNavigate, initialSelection = null }) {
  const page = view;
  const managesStaff = ["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"].includes(account.role);
  const attendanceEndpoint = managesStaff ? "/manager/staff-attendance" : "/attendance";
  const [staff, setStaff] = useState([]);
  const [worker, setWorker] = useState(initialSelection?.workerIds || []);
  const t = (en, zh) => language === "zh" ? zh : en;
  const exportRequest = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [shops, setShops] = useState([]);
  const [shop, setShop] = useState(initialSelection?.shopIds || []);
  const [fromDate, setFromDate] = useState(() => initialSelection?.fromDate || DateTime.now().setZone(zone).startOf("month").toISODate());
  const [toDate, setToDate] = useState(() => initialSelection?.toDate || DateTime.now().setZone(zone).endOf("month").toISODate());
  const [records, setRecords] = useState([]);
  const [dailyHours, setDailyHours] = useState([]);
  const [totalHours, setTotalHours] = useState(null);
  const [querySelection, setQuerySelection] = useState(initialSelection ? {shopIds:initialSelection.shopIds,workerIds:initialSelection.workerIds,fromDate:initialSelection.fromDate,toDate:initialSelection.toDate} : null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(null);
  const [historyRecord, setHistoryRecord] = useState(null);
  const [recordDialog, setRecordDialog] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [shopsLoaded, setShopsLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([api("/me/stores"), managesStaff ? api("/manager/staff-attendance/staff") : Promise.resolve([])]).then(([items, people]) => {
      if (!active) return;
      const reviewed=initialSelection?.staffOption;
      setStaff(reviewed&&!people.some(person=>person.id===reviewed.id)?[...people,reviewed]:people);
      setShops(items);
      setShop(current=>current.filter(code=>items.some(item=>item.shopId===code)));
      setShopsLoaded(true);
    }).catch((e) => { if (active) { setError(e.message); setShopsLoaded(true); } });
    return () => { active = false; };
  }, [session, refresh]);

  useEffect(() => {
    let active = true;
    setRecords([]); setDailyHours([]); setTotalHours(null); setEditor(null); setLoading(false); exportRequest.current = null;
    if (!querySelection) return;
    const { shopIds, workerIds, fromDate, toDate } = querySelection;
    const start = DateTime.fromISO(fromDate, { zone });
    const end = DateTime.fromISO(toDate, { zone });
    if (!start.isValid || !end.isValid || start > end || end.diff(start, "days").days > 30) {
      setError(t("Choose a valid date range of up to 31 days.", "请选择有效日期范围，最多 31 天。")); return;
    }
    setLoading(true); setError("");
    const query = new URLSearchParams({ ...(shopIds?.length ? { shopIds:shopIds.join(",") } : {}), ...(workerIds?.length ? { workerIds:workerIds.join(",") } : {}), fromDate, toDate });
    api(attendanceEndpoint + "?" + query).then((data) => {
      if (active) { setRecords(data.items); setDailyHours(data.dailyHours || []); setTotalHours(data.totalHours); }
    }).catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session, querySelection, refresh]);

  function viewDailyRecords(day) {
    const selectedStaff=staff.find(person=>person.id===day.workerId)?.workerId || day.workerCode;
    const staffCodes=managesStaff?[selectedStaff]:[];
    setFromDate(day.date);setToDate(day.date);setShop([day.shopCode]);
    if(managesStaff)setWorker(staffCodes);
    setError("");setNotice("");setHistoryRecord(null);setRecordDialog(null);
    setQuerySelection(attendanceSelectionForDay({...day,workerCode:selectedStaff},managesStaff));
  }
  async function exportRecords() {
    if (exporting || loading || !querySelection || !records.length) return;
    exportRequest.current ||= { operationId: operationId(), ...querySelection, records: records.map(r => ({ id: r.id, version: r.version })) };
    setExporting(true); setError(""); setNotice("");
    try { const result = await api(attendanceEndpoint + "/exports", { method: "POST", body: JSON.stringify(exportRequest.current) }); exportRequest.current = null; setNotice(t(`PDF queued for delivery to ${result.recipientEmail}.`, `PDF 已加入发送队列，将发送至 ${result.recipientEmail}。`)); }
    catch (e) { setError(e.message); if (e.status >= 400 && e.status < 500) exportRequest.current = null; }
    finally { setExporting(false); }
  }
  return <WorkspaceLayout account={account} active={navigationPage} onNavigate={onNavigate} logout={logout} language={language} busy={saving || exporting}>
    <main className="page-wrapper"><div className="container-xl worker-workspace">
    <header className="d-flex justify-content-between align-items-center mb-4">
      <div><h1 className="h2">{page === "settings" ? t("Website settings", "网站设置") : page === "profile" ? t("My account", "我的账号") : t("Attendance", "签到记录")}</h1><p className="text-secondary mb-0">{account.name}</p></div>
    </header>
    {page === "settings" ? <SiteSettings language={language} onLanguage={onLanguage} /> : page === "profile" ? <AccountSettings api={api} logout={logout} language={language} onSaved={onAccountSaved} /> : <>
    {managesStaff && <nav className="d-flex gap-2 mb-3" aria-label={t("Attendance views", "签到视图")}><button className="btn btn-primary">{t("Records & daily hours", "记录与每日工时")}</button><button className="btn" disabled={saving || exporting} onClick={() => onNavigate("Hours")}>{t("Monthly summary", "月度汇总")}</button></nav>}
    {account.attendanceEnabled === false && <div role="status" className="alert alert-warning">{t("General manager approval is required before you can record attendance or request changes.", "账号须经 General manager 确认后才能签到或提交修改。")}</div>}
    <p>{managesStaff ? t("Your changes take effect immediately and are recorded in history. Staff includes your own account.", "你的更改直接生效，并记录在历史中。Staff 包含你本人的账号。") : t("Unconfirmed changes require manager approval; only your latest proposal is reviewed. Confirmed records can only be changed by a manager. Times use Pacific/Auckland.", "未确认记录的修改需要管理人员审批，只保留最后一次申请；确认后仅管理人员可以更改。时间采用 Pacific/Auckland。")}</p>
    {error && <div role="alert" className="alert alert-danger">{error}</div>}
    {notice && <div role="status" className="alert alert-success">{notice}</div>}
    <div className="card card-body mb-4">
      <div className="row g-3">
        <div className="col-md-3">{managesStaff ? <MultiSelectFilter label={t("Staff", "员工")} options={staff.map(person=>({value:person.workerId,label:person.name+(person.workerId==='__self__'?` · ${t("Me","本人")}`:person.workerId.startsWith("__worker__")?"":` · ${person.workerId}`)}))} value={worker} allLabel={t("All accessible staff","全部可访问人员")} disabled={saving||exporting} onChange={codes=>{setWorker(codes);setQuerySelection(null);}}/> : <label className="form-label">{t("Staff","员工")}<input className="form-control mt-1" value={account.name} disabled readOnly/></label>}</div>
        <div className="col-md-3"><MultiSelectFilter label={t("Shop","门店")} options={shops.map(item=>({value:item.shopId,label:item.name}))} value={shop} allLabel={t("All shops","全部门店")} disabled={saving||exporting} onChange={codes=>{setShop(codes);setQuerySelection(null);}}/></div>
        <label className="col-md-3 form-label">{t("From", "开始日期")}
          <input className="form-control mt-1" type="date" value={fromDate} disabled={saving || exporting} onChange={(e) => { setFromDate(e.target.value); setQuerySelection(null); }} />
        </label>
        <label className="col-md-3 form-label">{t("To", "结束日期")}
          <input className="form-control mt-1" type="date" value={toDate} disabled={saving || exporting} onChange={(e) => { setToDate(e.target.value); setQuerySelection(null); }} />
        </label>
        <div className="col-md-2 align-self-end mb-2"><button className="btn" disabled={loading || saving || exporting} onClick={() => {
          const start = DateTime.fromISO(fromDate, { zone }), end = DateTime.fromISO(toDate, { zone });
          if (!start.isValid || !end.isValid || start > end || end.diff(start, "days").days > 30) { setError(t("Select a valid date range of up to 31 days.", "请选择有效日期范围，最多 31 天。")); return; }
          setQuerySelection({ shopIds:shop, ...(managesStaff ? {workerIds:worker} : {}), fromDate, toDate });
        }}>{t("Search", "查询")}</button></div>
      </div>
    </div>
    {historyRecord && <AttendanceHistoryDialog record={historyRecord} api={api} language={language} onClose={() => setHistoryRecord(null)} />}
    {recordDialog && <AttendanceRecordDialog mode={recordDialog.mode} record={recordDialog.record}
      shops={shops} workers={managesStaff ? staff : undefined} defaultWorker={recordDialog.record?.worker_code || (worker.length===1?worker[0]:"")} defaultShop={recordDialog.record?.shop_code || (shop.length===1?shop[0]:"")} api={api} endpoint={managesStaff ? "/manager/attendance-adjustments" : "/attendance-adjustments"}
      onClose={() => setRecordDialog(null)} onDone={() => {
        setRecordDialog(null); setEditor(null); setRefresh((v) => v + 1);
        setNotice(managesStaff ? t("Attendance updated; change recorded in history.", "签到记录已更新，更改已记录在历史中。") : recordDialog.mode === "REMOVE" ? t("Removal requested. Pending approval.", "删除申请已提交，等待确认。") : t("Record added. Pending approval.", "记录已新增，等待确认。"));
      }} />}
    {querySelection && !loading && dailyHours.length > 0 && <section className="card mb-4 table-responsive">
      <div className="card-header"><h2 className="h3 mb-0">{t("Daily working hours", "每日工作小时")}</h2></div>
      <table className="table table-vcenter"><thead><tr>{managesStaff && <th>{t("Staff", "员工")}</th>}<th>{t("Shop", "门店")}</th><th>{t("Date", "日期")}</th><th>{t("Working hours", "工作小时")}</th><th>{t("Status", "状态")}</th><th>{t("View", "查看")}</th></tr></thead>
      <tbody>{dailyHours.map(day=><tr key={`${day.workerId}-${day.shopId}-${day.date}`}>
        {managesStaff&&<td>{day.workerName}</td>}<td>{day.shopName}</td><td>{day.date}</td><td className={day.valid?"":"text-danger"}>{day.valid?day.hours:t("Adjust attendance records","需要调整签到记录")}</td><td>{day.pending?t("Changes awaiting manager confirmation","待 Manager 确认修改"):"—"}</td>
        <td><button className="btn btn-sm" disabled={saving||exporting||loading} onClick={()=>viewDailyRecords(day)}>{t("View","查看")}</button></td>
      </tr>)}</tbody>
      {totalHours&&<tfoot><tr className="fw-bold"><td colSpan={managesStaff?3:2}>{t("Total hours","总计工时")}</td><td className={totalHours.valid?"":"text-danger"}>{totalHours.valid?totalHours.hours:t("Adjust attendance records","需要调整签到记录")}</td><td>{totalHours.pending?t("Changes awaiting manager confirmation","待 Manager 确认修改"):"—"}</td><td></td></tr></tfoot>}</table>
    </section>}
    {editor && <AttendanceAdjustDialog record={editor} api={api} manager={managesStaff} language={language} onBusy={setSaving}
      onClose={reload=>{setEditor(null);if(reload)setRefresh(value=>value+1);}}
      onDone={()=>{setEditor(null);setRefresh(value=>value+1);setNotice(managesStaff?t("Attendance updated; change recorded in history.","签到记录已更新，更改已记录在历史中。"):t("Change submitted for manager approval.","修改申请已提交，等待管理人员确认。"));}} />}
    {!querySelection ? <p className="text-secondary">{t("Select a date range, optionally select a store, then search.", "请选择日期范围后查询；未选门店表示全部门店。")}</p> : loading ? <p role="status">{t("Loading records…", "正在加载记录…")}</p> : <div className="card table-responsive"><table className="table table-vcenter">
      <thead><tr>{managesStaff && <th>{t("Staff", "员工")}</th>}<th>{t("Store", "门店")}</th><th>{t("Type", "类型")}</th><th>{t("Original", "原始时间")}</th><th>{t("Current", "当前时间")}</th><th>{t("Confirmed", "已确认")}</th><th>{t("Status", "状态")}</th><th>{t("Photo", "照片")}</th><th>{t("Action", "操作")}</th></tr></thead>
      <tbody>{records.map((record) => <tr key={record.id}>
        {managesStaff && <td>{record.worker_name}</td>}
        <td>{record.shop_name || shops.find(s => s.id === record.shop_id)?.name || "—"}</td>
        <td>{(record.pending_sign_type || record.sign_type) === "SIGN_IN" ? t("Clock in", "上班") : t("Clock out", "下班")}</td>
        <td>{displayTime(record.original_occurred_at)}</td><td>{displayTime(record.effective_occurred_at)}</td>
        <td>{displayTime(record.manager_confirmed ? record.confirmed_occurred_at : null)}</td>
        <td>{record.pending ? (record.effective_deleted ? t("Removal pending approval", "删除待审批") : t("Pending approval", "待审批")) : record.effective_deleted ? t("Deleted", "已删除") : record.manager_confirmed ? t("Confirmed", "已确认") : t("Submitted", "已提交")}</td>
        <td>{record.photo_id ? <AttendancePhotoLink photoId={record.photo_id} api={api}
          description={`${(record.pending_sign_type || record.sign_type) === "SIGN_IN" ? t("Clock in", "上班") : t("Clock out", "下班")} · ${displayTime(record.original_occurred_at)}`} /> : "—"}</td>
        <td><div className="d-flex gap-2">{managesStaff && <button className="btn btn-sm" onClick={() => setHistoryRecord(record)}>{t("History", "历史")}</button>}<button className="btn btn-sm" disabled={saving || exporting || (!managesStaff && record.manager_confirmed) || record.confirmed_deleted} onClick={() => {
          setEditor(record);
          setError(""); setNotice("");
        }}>{t("Adjust", "修改")}</button>
          <button className="btn btn-sm btn-outline-danger" disabled={saving || exporting || (!managesStaff && record.manager_confirmed) || record.confirmed_deleted}
            onClick={() => setRecordDialog({ mode: "REMOVE", record })}>{t("Remove", "删除")}</button>
        </div></td>
      </tr>)}</tbody>
    </table>{!records.length && <p className="p-3 mb-0">{error ? t("Unable to display records. Check the message above.", "无法显示记录，请查看上方提示。") : t("No records for this selection.", "查询范围内没有记录。")}</p>}</div>}
    <div className="d-flex gap-2 mb-3"><button className="btn btn-primary" disabled={saving || loading || !shops.length} onClick={() => setRecordDialog({ mode: "ADD" })}>{t("Add attendance record", "添加记录")}</button><button className="btn" disabled={exporting || loading || saving || !querySelection || !records.length || !!error} onClick={exportRecords}>{exporting ? t("Exporting…", "正在导出…") : t("Export PDF to email", "导出 PDF 到邮箱")}</button></div>
    </>}
  </div></main></WorkspaceLayout>;
}
