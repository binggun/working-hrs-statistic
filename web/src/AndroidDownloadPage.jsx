import React,{useEffect,useState} from 'react';
import {DateTime} from 'luxon';
const origin=(import.meta.env.VITE_API_URL||'').replace(/\/$/,'');
export default function AndroidDownloadPage({language}){
  const t=(en,zh)=>language==='zh'?zh:en;
  const [metadata,setMetadata]=useState(null),[error,setError]=useState(false);
  useEffect(()=>{const controller=new AbortController();fetch(origin+'/api/v1/downloads/android',{signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('Unable to load app details.');return response.json();}).then(result=>setMetadata(result.data)).catch(error=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[]);
  return <section className="card card-body android-download-card">
    <h1 className="h2">{t('Pawhub Android App','Pawhub Android App 下载')}</h1>
    <p className="text-secondary">{t('Sign in with the same account and password as the website.','使用与网站相同的账号和密码登录。')}</p>
    {error&&<div className="alert alert-danger" role="alert">{t('Unable to load app details. Please try again later.','无法加载安装包信息，请稍后重试。')}</div>}
    {!metadata&&!error&&<p role="status">{t('Loading…','正在加载…')}</p>}
    {metadata?.available?<><dl className="row mt-3"><dt className="col-sm-4">{t('Version','版本')}</dt><dd className="col-sm-8">{metadata.versionName}{metadata.buildType==='debug'?t(' · Test build',' · 测试版'):''}</dd><dt className="col-sm-4">{t('File size','文件大小')}</dt><dd className="col-sm-8">{(metadata.sizeBytes/1024/1024).toFixed(2)} MiB</dd><dt className="col-sm-4">{t('Built','构建日期')}</dt><dd className="col-sm-8">{DateTime.fromISO(metadata.builtAt).setZone('Pacific/Auckland').toFormat('yyyy-MM-dd HH:mm')}</dd><dt className="col-sm-4">{t('Requires','系统要求')}</dt><dd className="col-sm-8">Android 8.0+</dd></dl>
      <a className="btn btn-primary align-self-start mt-2" href={metadata.downloadUrl || origin+metadata.downloadPath} download="pawhub-signin-app.apk">{t('Download APK','下载 APK 安装包')}</a>
      <details className="mt-4"><summary>SHA-256</summary><code className="text-break">{metadata.sha256}</code></details>
    </>:metadata&&!metadata.available?<p role="status">{t('The Android installer is not available yet.','暂未提供 Android 安装包。')}</p>:null}
    <h2 className="h3 mt-4">{t('Install on your phone','手机安装方法')}</h2>
    <ol className="mb-0"><li>{t('Open this page on your Android phone and download the APK.','在 Android 手机上打开此页面并下载安装包。')}</li><li>{t('Open the downloaded file and follow the phone prompts to allow installation from this source.','打开下载的文件，按手机提示允许此来源安装应用。')}</li><li>{t('Install Pawhub and sign in with an internet connection.','完成安装后，连接互联网并登录。')}</li></ol>
  </section>;
}
