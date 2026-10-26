import React, { useEffect, useRef, useState } from 'react';
import AttendancePhotoLink from './AttendancePhotoLink.jsx';
export default function AttendancePhotoThumbnail({photoId,api,description,language}) {
  const container=useRef(null),[source,setSource]=useState(null),[loading,setLoading]=useState(true),[expired,setExpired]=useState(false);
  const label=language==='zh'?'查看照片':'View photo';
  useEffect(()=>{
    const controller=new AbortController();let objectUrl=null,started=false;
    setSource(null);setLoading(true);setExpired(false);
    async function load(){
      if(started)return;started=true;
      try{
        const metadata=await api(`/photos/${photoId}`,{signal:controller.signal});
        let url;
        if(metadata.requiresAuthentication){
          const blob=await api(`/photos/${photoId}/file`,{responseType:'blob',signal:controller.signal});
          if(controller.signal.aborted)return;
          if(!['image/jpeg','image/png','image/webp'].includes(blob.type))throw Error('Invalid photo');
          objectUrl=URL.createObjectURL(blob);url=objectUrl;
        }else{url=new URL(metadata.url);if(url.protocol!=='https:')throw Error('Invalid photo URL');url=url.href;}
        if(!controller.signal.aborted)setSource(url);
      }catch(error){ if(!controller.signal.aborted && error.status===410)setExpired(true); }
      finally{if(!controller.signal.aborted)setLoading(false);}
    }
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load();}},{rootMargin:'64px'}):null;
    if(observer)observer.observe(container.current);else load();
    return()=>{observer?.disconnect();controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[photoId]);
  if(expired)return <span className="small text-secondary">{language==='zh'?'照片已清理':'Photo expired'}</span>;
  return <span ref={container} className="attendance-selfie-thumbnail"><AttendancePhotoLink photoId={photoId} api={api} description={description}>
    {source?<img src={source} alt={description} title={label} referrerPolicy="no-referrer" onError={()=>{setSource(null);setLoading(false);}}/>:<span className="attendance-selfie-placeholder" title={label}>{loading?'…':label}</span>}
  </AttendancePhotoLink></span>;
}
