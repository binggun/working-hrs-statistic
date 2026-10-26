import React, { useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";
import { operationId } from "./operationId.js";

export default function AttendanceAdjustDialog({ record, api, manager, language, onClose, onDone, onBusy }) {
  const dialog=useRef(null), request=useRef(null), titleId=useId();
  const [saving,setSaving]=useState(false),[error,setError]=useState(""),[pending,setPending]=useState(false),[conflict,setConflict]=useState(false);
  const t=(en,zh)=>language==='zh'?zh:en;
  const zone='Pacific/Auckland';
  useEffect(()=>{dialog.current.showModal();},[]);
  async function submit(event) {
    event.preventDefault(); if(saving||conflict)return;
    if(!request.current){
      const form=new FormData(event.currentTarget), raw=String(form.get('time'));
      const time=DateTime.fromISO(raw,{zone});
      if(!time.isValid||time.toFormat("yyyy-MM-dd'T'HH:mm")!==raw){setError(t('Enter a valid Auckland date and time.','请输入有效的奥克兰日期和时间。'));return;}
      const common={operationId:operationId(),occurredAt:time.toUTC().toISO(),type:form.get('type')};
      request.current=manager?{...common,expectedRecordVersion:record.version}:{...common,action:'UPDATE',recordId:record.id,expectedVersion:record.version};
    }
    setSaving(true);onBusy?.(true);setError('');
    try{
      await api(manager?`/manager/attendance/${record.id}/corrections`:'/attendance-adjustments',{method:'POST',body:JSON.stringify(request.current)});
      onDone();
    }catch(e){
      setError(e.message);
      if(e.status>=400&&e.status<500){request.current=null;setPending(false);if(e.status===409)setConflict(true);}
      else setPending(true);
    }finally{setSaving(false);onBusy?.(false);}
  }
  return <dialog ref={dialog} className="attendance-record-dialog" aria-labelledby={titleId} onClose={()=>onClose(conflict)} onCancel={event=>{if(saving)event.preventDefault();}}>
    <h2 className="h3" id={titleId}>{t('Adjust attendance','修改签到记录')}</h2>
    <p>{[record.worker_name,record.shop_name].filter(Boolean).join(' · ')}</p>
    {error&&<div className="alert alert-danger" role="alert">{error}</div>}
    {pending&&<p>{t('The result is uncertain. Retry the same request.','暂时无法确认结果，请重试同一请求。')}</p>}
    {conflict&&<p>{t('Close this dialog to reload the latest record.','请关闭对话框，重新加载最新记录。')}</p>}
    <form onSubmit={submit}>
      <fieldset disabled={saving||pending||conflict}>
        <label className="form-label mb-3">{t('Date and time (Auckland)','日期和时间（奥克兰）')}<input autoFocus required name="time" type="datetime-local" className="form-control mt-1" defaultValue={DateTime.fromISO(record.effective_occurred_at).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm")} /></label>
        <label className="form-label mb-3">{t('Type','类型')}<select name="type" required className="form-select mt-1" defaultValue={record.pending_sign_type||record.sign_type}><option value="SIGN_IN">{t('Clock in','上班')}</option><option value="SIGN_OUT">{t('Clock out','下班')}</option></select></label>
      </fieldset>
      <div className="d-flex gap-2 mt-3"><button className="btn btn-primary" disabled={saving||conflict}>{saving?t('Saving…','正在保存…'):pending?t('Retry','重试'):t('Save changes','保存修改')}</button><button className="btn" type="button" disabled={saving} onClick={()=>dialog.current.close()}>{conflict?t('Close and reload','关闭并刷新'):t('Cancel','取消')}</button></div>
    </form>
  </dialog>;
}
