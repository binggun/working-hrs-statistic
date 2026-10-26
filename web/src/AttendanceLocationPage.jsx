import React, {useEffect,useState} from 'react';
import {DateTime} from 'luxon';
import AttendancePhotoThumbnail from './AttendancePhotoThumbnail.jsx';
import MultiSelectFilter from './MultiSelectFilter.jsx';
export default function AttendanceLocationPage({api,language}) {
  const t=(en,zh)=>language==='zh'?zh:en;
  const [staff,setStaff]=useState([]),[shops,setShops]=useState([]),[workers,setWorkers]=useState([]),[stores,setStores]=useState([]);
  const [from,setFrom]=useState(()=>DateTime.now().setZone('Pacific/Auckland').startOf('month').toISODate());
  const [to,setTo]=useState(()=>DateTime.now().setZone('Pacific/Auckland').endOf('month').toISODate());
  const [selection,setSelection]=useState(null),[cursor,setCursor]=useState(''),[next,setNext]=useState(null),[rows,setRows]=useState([]),[total,setTotal]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false),[ready,setReady]=useState(false);
  useEffect(()=>{let active=true;Promise.all([api('/manager/staff-attendance/staff'),api('/me/stores')]).then(([people,places])=>{if(active){setStaff(people);setShops(places);setReady(true);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  useEffect(()=>{let active=true;setRows([]);setNext(null);if(!selection)return;setLoading(true);setError('');const query=new URLSearchParams({...selection,cursor});api('/manager/attendance/locations?'+query).then(data=>{if(active){setRows(data.items);setTotal(data.total);setNext(data.nextCursor);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[selection,cursor]);
  const clear=()=>{setSelection(null);setRows([]);setNext(null);setCursor('');setError('');setLoading(false);};
  const time=value=>value?DateTime.fromISO(value).setZone('Pacific/Auckland').toFormat('dd/MM/yyyy HH:mm'):'—';
  return <>
    <div className="card card-body mb-4"><div className="row g-3">
      <div className="col-md-3"><MultiSelectFilter label={t('Staff','人员')} options={staff.map(person=>({value:person.workerId,label:person.name}))} value={workers} allLabel={t('All staff','全部人员')} disabled={loading||!ready} onChange={value=>{setWorkers(value);clear();}}/></div>
      <div className="col-md-3"><MultiSelectFilter label={t('Shop','门店')} options={shops.map(shop=>({value:shop.shopId,label:shop.name}))} value={stores} allLabel={t('All shops','全部门店')} disabled={loading||!ready} onChange={value=>{setStores(value);clear();}}/></div>
      <label className="col-md-3 form-label">{t('From','开始日期')}<input type="date" className="form-control mt-1" value={from} disabled={loading} onChange={event=>{setFrom(event.target.value);clear();}}/></label>
      <label className="col-md-3 form-label">{t('To','结束日期')}<input type="date" className="form-control mt-1" value={to} disabled={loading} onChange={event=>{setTo(event.target.value);clear();}}/></label>
      <div><button className="btn btn-primary" disabled={loading||!ready} onClick={()=>{const start=DateTime.fromISO(from),end=DateTime.fromISO(to);if(!start.isValid||!end.isValid||start>end||end.diff(start,'days').days>30){setError(t('Choose a valid date range of up to 31 days.','请选择有效日期范围，最多31天。'));return;}setCursor('');setSelection({fromDate:from,toDate:to,...(workers.length?{workerIds:workers.join(',')}:{}),...(stores.length?{shopIds:stores.join(',')}: {})});}}>{t('Search','查询')}</button></div>
    </div></div>
    {error&&<div className="alert alert-danger" role="alert">{error}</div>}
    {loading&&<p role="status">{t('Loading…','正在加载…')}</p>}
    {!selection&&!error&&<p className="text-secondary">{t('Select a date range to query attendance.','请选择日期范围查询签到记录。')}</p>}
    {selection&&!loading&&!error&&<><div className="card table-responsive"><table className="table table-vcenter card-table"><thead><tr>{[t('Staff','人员'),t('Shop','门店'),t('Type','类型'),t('Attendance time','签到时间'),t('Confirmed time','确认时间'),t('Photo','照片'),t('Latitude','纬度'),t('Longitude','经度'),t('Distance to shop (m)','距门店（米）'),t('Accuracy (m)','精度（米）')].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.workerName}</td><td>{row.shopName}</td><td>{row.type==='SIGN_IN'?t('Clock in','上班'):t('Clock out','下班')}</td><td>{time(row.originalTime)}</td><td>{time(row.confirmedTime)}</td><td>{row.photoId&&<AttendancePhotoThumbnail photoId={row.photoId} api={api} language={language} description={`${row.workerName} · ${row.shopName} · ${time(row.originalTime)}`} />}</td><td>{row.latitude==null?"":row.latitude.toFixed(6)}</td><td>{row.longitude==null?"":row.longitude.toFixed(6)}</td><td>{row.distanceMeters==null?'':row.distanceMeters.toFixed(1)}</td><td>{row.accuracyMeters==null?'':row.accuracyMeters.toFixed(1)}</td></tr>)}</tbody></table>{!rows.length&&<p className="p-4 text-secondary mb-0">{t('No attendance records in this range.','查询范围内没有签到记录。')}</p>}</div><div className="d-flex gap-2 align-items-center mt-3"><span className="text-secondary me-auto">{t('Records','签到记录')}: {total}</span><button className="btn" disabled={!cursor} onClick={()=>setCursor('')}>{t('First page','首页')}</button><button className="btn" disabled={!next} onClick={()=>setCursor(next)}>{t('Next page','下一页')}</button></div></>}
  </>;
}
