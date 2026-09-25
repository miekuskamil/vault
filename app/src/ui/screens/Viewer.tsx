import { useEffect, useState } from "react";
import { TbArrowLeft, TbDownload, TbFile } from "react-icons/tb";
import { session } from "../../core/session";
import { formatBytes, isImage } from "../../core/image";
import { Button, IconButton } from "../components";
import { useNav } from "../nav";
import { download, useSession } from "../util";
import { toasts } from "../../core/toasts";

export function Viewer({ itemId, attId }: { itemId: string; attId: string }) {
  const s = useSession();
  const nav = useNav();
  const meta = s.vault?.items.find(i => i.id === itemId)?.attachments.find(a => a.id === attId);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let live = true;
    if (meta) session.attachmentUrl(meta).then(u => { if (live) setUrl(u); }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [attId]);
  if (!meta) return null;

  const save = async () => {
    try { download(new Blob([await session.attachmentBytes(meta)], { type: meta.mime }), meta.name); toasts.show("Saved to Downloads, unencrypted"); }
    catch (e) { toasts.error((e as Error).message); }
    setConfirm(false);
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={meta.name}>
      <div className="bar">
        <IconButton label="Back" onClick={nav.back}><TbArrowLeft /></IconButton>
        <span className="name">{meta.name}</span>
        <IconButton label="Save a copy to this device" onClick={() => setConfirm(true)}><TbDownload /></IconButton>
      </div>
      <div className="stage">
        {error ? <p style={{ color: "#fff" }}>{error}</p>
          : isImage(meta.mime) ? (url ? <img src={url} alt={meta.name} /> : null)
          : (
            <div style={{ color: "#fff", textAlign: "center", padding: 24 }}>
              <TbFile size={48} /><p>{meta.name}<br /><span style={{ opacity: 0.7 }}>{formatBytes(meta.size)}</span></p>
              {url && <Button variant="primary" onClick={() => window.open(url, "_blank", "noopener")}>Open</Button>}
            </div>
          )}
      </div>
      {confirm && (
        <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) setConfirm(false); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Save a copy">
            <h2>Save an unencrypted copy?</h2>
            <p>The file goes to your Downloads folder without encryption. Delete it when you're done.</p>
            <div className="actions"><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save copy</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}
