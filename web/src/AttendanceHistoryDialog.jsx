import React, { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
export default function AttendanceHistoryDialog({ record, api, language, onClose }) {
  const dialog = useRef(null), [data, setData] = useState(null), [error, setError] = useState("");
  const t = (en, zh) => language === "zh" ? zh : en;
  const time = value => value ? DateTime.fromISO(value).setZone("Pacific/Auckland").toFormat("dd/MM/yyyy HH:mm") : "—";
  useEffect(() => {
    dialog.current.showModal(); let active = true;
    api(`/manager/attendance/${record.id}/history`).then(result => { if (active) setData(result); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [record.id]);
  return <dialog ref={dialog} className="attendance-record-dialog" onClose={onClose} aria-label={t("Attendance history", "签到历史")}>
    <h2 className="h3">{t("Attendance history", "签到历史")}</h2>
    <p>{record.worker_name} · {record.shop_name}</p>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {!data && !error && <p role="status">{t("Loading…", "正在加载…")}</p>}
    {data && <><p>{t("Original", "原始时间")}: {time(data.record.original_occurred_at)}</p><div className="table-responsive"><table className="table"><thead><tr>{[t("Action", "操作"),t("Before", "修改前"),t("After", "修改后"),t("Type", "类型"),t("Status", "状态")].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{data.history.map(item => <tr key={item.id}><td>{item.action}</td><td>{time(item.before_at)}</td><td>{time(item.after_at)}</td><td>{item.before_type || "—"} → {item.after_type || "—"}</td><td>{item.status}</td></tr>)}</tbody></table>{!data.history.length && <p>{t("No changes.", "暂无修改记录。")}</p>}</div></>}
    <button className="btn mt-3" onClick={() => dialog.current.close()}>{t("Close", "关闭")}</button>
  </dialog>;
}
