import React, { useState } from "react";

export function useSiteLanguage() {
  const [language, setLanguage] = useState(() => localStorage.getItem("pawhubLanguage") || (navigator.language.startsWith("zh") ? "zh" : "en"));
  return [language, value => { localStorage.setItem("pawhubLanguage", value); setLanguage(value); document.documentElement.lang = value; }];
}

export default function SiteSettings({ language, onLanguage }) {
  const t = (en, zh) => language === "zh" ? zh : en;
  return <section className="card card-body">
    <h2 className="h3">{t("Website settings", "网站设置")}</h2>
    <label className="form-label">{t("Language", "语言")}
      <select className="form-select mt-2" value={language} onChange={event => {
        const next = event.target.value;
        if (next !== language && window.confirm(t(`Switch website language to ${next === "zh" ? "中文" : "English"}?`, `确认将网站语言切换为 ${next === "zh" ? "中文" : "English"}？`))) onLanguage(next);
      }}><option value="en">English</option><option value="zh">中文</option></select>
    </label>
  </section>;
}
