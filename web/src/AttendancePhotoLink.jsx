import React, { useEffect, useRef, useState } from "react";

export default function AttendancePhotoLink({ photoId, api, description, children }) {
  const dialog = useRef(null);
  const request = useRef(null);
  const objectUrl = useRef(null);
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);

  function release() {
    request.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }
  useEffect(() => () => release(), []);

  async function viewPhoto(event) {
    event.preventDefault();
    release();
    const controller = new AbortController();
    request.current = controller;
    setPhoto(null); setError(""); setLoading(true);
    dialog.current.showModal();
    try {
      const metadata = await api(`/photos/${photoId}`, { signal: controller.signal });
      let blob;
      if (metadata.requiresAuthentication) {
        // Keep the bearer inside our authenticated API client, never in a URL.
        blob = await api(`/photos/${photoId}/file`, { responseType: "blob", signal: controller.signal });
      } else {
        const url = new URL(metadata.url);
        if (url.protocol !== "https:") throw Error("Invalid photo address.");
        if (!controller.signal.aborted) setPhoto(url.href);
        return;
      }
      if (controller.signal.aborted) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type)) throw Error("Unsupported photo format.");
      objectUrl.current = URL.createObjectURL(blob);
      setPhoto(objectUrl.current);
    } catch (e) {
      if (!controller.signal.aborted) { if(e.status===410)setExpired(true); setError(e.message || "Unable to load photo."); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <>
    {expired ? <span className="text-secondary">Photo expired / 照片已清理</span> : <a href={`#photo-${photoId}`} onClick={viewPhoto}>{children || "View photo"}</a>}
    <dialog ref={dialog} className="attendance-photo-dialog" aria-label="Attendance photo" onClose={release}>
      <div className="d-flex align-items-center justify-content-between gap-3 mb-3">
        <h2 className="h3 mb-0">Attendance photo</h2>
        <form method="dialog"><button className="btn btn-sm" aria-label="Close photo">Close</button></form>
      </div>
      <p className="text-secondary">{description}</p>
      {loading && <p role="status">Loading photo…</p>}
      {error && <div role="alert" className="alert alert-danger">{error}</div>}
      {photo && <img src={photo} alt={`Attendance selfie: ${description}`} className="attendance-photo-image" referrerPolicy="no-referrer"
        onError={() => { setPhoto(null); setError("Unable to load photo. Close this preview and try again."); }} />}
    </dialog>
  </>;
}
