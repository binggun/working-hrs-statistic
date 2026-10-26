import React, { useEffect, useRef } from "react";
export default function MultiSelectFilter({ label, options, value, onChange, allLabel, disabled }) {
  const container=useRef(null);
  useEffect(()=>{const close=event=>{if(container.current&&!container.current.contains(event.target))container.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
  const names=options.filter(option=>value.includes(option.value)).map(option=>option.label);
  return <div className="form-label">{label}<details className="attendance-multiselect mt-1" ref={container} onKeyDown={event=>{if(event.key==='Escape')container.current.open=false;}}>
    <summary className="form-select" aria-disabled={disabled} onClick={event=>{if(disabled)event.preventDefault();}}>{names.length?names.join(', '):allLabel}</summary>
    <div className="attendance-multiselect-options"><label className="form-check"><input type="checkbox" className="form-check-input" checked={!value.length} disabled={disabled} onChange={()=>onChange([])}/><span className="form-check-label">{allLabel}</span></label>
      {options.map(option=><label key={option.value} className="form-check"><input className="form-check-input" type="checkbox" checked={value.includes(option.value)} disabled={disabled} onChange={()=>onChange(value.includes(option.value)?value.filter(id=>id!==option.value):[...value,option.value])}/><span className="form-check-label">{option.label}</span></label>)}
    </div>
  </details></div>;
}
