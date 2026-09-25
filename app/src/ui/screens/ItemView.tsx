import { useEffect, useState } from "react";
import { TbCopy, TbDotsVertical, TbEdit, TbExternalLink, TbEye, TbEyeOff, TbFile, TbFolderSymlink, TbHistory, TbStar, TbStarFilled, TbTrash } from "react-icons/tb";
import { hasLoginFields, ITEM_TYPES, moveItems, restoreItems, setFavorite, trashItems, type AttachmentMeta, type Item } from "../../core/model";
import { session } from "../../core/session";
import { toasts } from "../../core/toasts";
import { formatCode, parseTotp, totpAt } from "../../core/totp";
import { isImage } from "../../core/image";
import { Avatar, Button, Dialog, IconButton, Page, Ring, StrengthBar, TextInput } from "../components";
import { useNav } from "../nav";
import { ago, catClass, dateTime, host, linkify, safeHref, useNow, useSession } from "../util";

export function ItemView({ id }: { id: string }) {
  const s = useSession();
  const nav = useNav();
  const it = s.vault?.items.find(i => i.id === id);
  const [menu, setMenu] = useState(false);
  const [move, setMove] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  if (!it || it.deletedAt != null) {
    return <Page title="" onBack={nav.back}><p className="muted">This item was deleted.</p></Page>;
  }
  const copy = (v: string, label: string) => void session.copy(v, label, it.id);
  const del = async () => {
    setMenu(false);
    await session.commit(v => trashItems(v, [it.id]), { snapshot: `Before deleting ${it.title}` }).catch(e => toasts.error((e as Error).message));
    nav.back();
    toasts.show(`Moved “${it.title}” to trash`, { action: { label: "Undo", run: () => void session.commit(v => restoreItems(v, [it.id])) } });
  };
  const typeLabel = ITEM_TYPES.find(t => t.id === it.type)?.label ?? "";
  const fields = it.fields.filter(f => f.value);

  return (
    <Page title="" label={it.title} onBack={nav.back}
      actions={<>
        <IconButton label={it.favorite ? "Remove from favorites" : "Add to favorites"} className={it.favorite ? "on" : ""} onClick={() => void session.commit(v => setFavorite(v, it.id, !it.favorite))}>{it.favorite ? <TbStarFilled /> : <TbStar />}</IconButton>
        <IconButton label="More" onClick={() => setMenu(true)}><TbDotsVertical /></IconButton>
      </>}
      footer={<Button variant="primary" icon={<TbEdit />} onClick={() => nav.push({ kind: "edit", id: it.id })}>Edit</Button>}>
      <div className="hero">
        <Avatar item={it} large />
        <div className="grow">
          <h1>{it.title}</h1>
          <div className="meta">
            <span className={`tag ${catClass(it.category)}`}><span className="dot" />{it.category}</span>
            {it.type !== "login" && <span className="tag">{typeLabel}</span>}
          </div>
        </div>
      </div>

      {(hasLoginFields(it.type) && (it.username || it.password || it.url || it.totp)) && (
        <div className="card">
          {it.username && <FieldRow label="Username" value={it.username} onCopy={() => copy(it.username, "Username")} />}
          {it.password && <PasswordRow it={it} onCopy={() => copy(it.password, "Password")} onHistory={() => setShowHistory(true)} />}
          {it.totp && <TotpRow secret={it.totp} onCopy={code => copy(code, "Code")} />}
          {it.url && <UrlRow url={it.url} onCopy={() => copy(it.url, "Website")} />}
        </div>
      )}

      {fields.length > 0 && (
        <div className="card">
          {fields.map(f => f.hidden
            ? <SecretRow key={f.id} label={f.label || "Hidden"} value={f.value} onCopy={() => copy(f.value, f.label || "Value")} />
            : <FieldRow key={f.id} label={f.label || "Field"} value={f.value} onCopy={() => copy(f.value, f.label || "Value")} />)}
        </div>
      )}

      {it.notes && (
        <div className="card">
          <div className="fieldrow" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <div className="lbl">Notes</div>
              <div className="val pre">{linkify(it.notes).map((p, i) => p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a> : <span key={i}>{p.text}</span>)}</div>
            </div>
            <IconButton small label="Copy notes" onClick={() => copy(it.notes, "Notes")}><TbCopy /></IconButton>
          </div>
        </div>
      )}

      {it.attachments.length > 0 && (
        <div className="card">
          <div className="fieldrow" style={{ minHeight: 0, paddingBottom: 0, borderBottom: "none" }}><div className="lbl">Attachments</div></div>
          <div className="thumbs">{it.attachments.map(a => <Thumb key={a.id} meta={a} onOpen={() => nav.push({ kind: "viewer", itemId: it.id, attId: a.id })} />)}</div>
        </div>
      )}

      <div className="meta-list">
        Created {dateTime(it.createdAt)}<br />
        Changed {dateTime(it.updatedAt)}{it.lastUsedAt ? <><br />Last used {ago(it.lastUsedAt)}</> : null}
      </div>

      {menu && (
        <Dialog title={it.title} onClose={() => setMenu(false)}>
          <div className="menu" style={{ padding: 0 }}>
            <button type="button" onClick={() => { setMenu(false); nav.push({ kind: "edit", id: it.id }); }}><TbEdit />Edit</button>
            <button type="button" onClick={() => { setMenu(false); setMove(true); }}><TbFolderSymlink />Move to category</button>
            {it.history.length > 0 && <button type="button" onClick={() => { setMenu(false); setShowHistory(true); }}><TbHistory />Password history ({it.history.length})</button>}
            <button type="button" className="danger" onClick={() => void del()}><TbTrash />Delete</button>
          </div>
        </Dialog>
      )}
      {move && <MoveOne it={it} onClose={() => setMove(false)} />}
      {showHistory && <HistoryDialog it={it} onClose={() => setShowHistory(false)} onCopy={v => copy(v, "Old password")} />}
    </Page>
  );
}

function FieldRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="fieldrow">
      <div className="grow"><div className="lbl">{label}</div><div className="val">{value}</div></div>
      <IconButton small label={`Copy ${label.toLowerCase()}`} onClick={onCopy}><TbCopy /></IconButton>
    </div>
  );
}

function SecretRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="fieldrow">
      <div className="grow"><div className="lbl">{label}</div><div className="val secret">{show ? value : "•".repeat(Math.min(12, Math.max(6, value.length)))}</div></div>
      <IconButton small label={show ? `Hide ${label}` : `Show ${label}`} onClick={() => setShow(v => !v)}>{show ? <TbEyeOff /> : <TbEye />}</IconButton>
      <IconButton small label={`Copy ${label.toLowerCase()}`} onClick={onCopy}><TbCopy /></IconButton>
    </div>
  );
}

function PasswordRow({ it, onCopy, onHistory }: { it: Item; onCopy: () => void; onHistory: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="fieldrow" style={{ alignItems: "flex-start" }}>
      <div className="grow">
        <div className="lbl">Password</div>
        <div className="val secret" style={{ overflowWrap: "anywhere" }}>{show ? it.password : "•".repeat(12)}</div>
        <StrengthBar password={it.password} userInputs={[it.title, it.username, it.url]} />
        <div className="hint row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span>{it.passwordChangedAt ? `Changed ${ago(it.passwordChangedAt)}` : "Age unknown (imported)"}</span>
          {it.history.length > 0 && <button type="button" className="link-btn" onClick={onHistory}>Earlier passwords ({it.history.length})</button>}
        </div>
      </div>
      <IconButton small label={show ? "Hide password" : "Show password"} onClick={() => setShow(v => !v)}>{show ? <TbEyeOff /> : <TbEye />}</IconButton>
      <IconButton small label="Copy password" onClick={onCopy}><TbCopy /></IconButton>
    </div>
  );
}

function TotpRow({ secret, onCopy }: { secret: string; onCopy: (code: string) => void }) {
  const cfg = parseTotp(secret);
  const now = useNow(1000);
  const [code, setCode] = useState<{ code: string; remaining: number } | null>(null);
  useEffect(() => { let live = true; if (cfg) void totpAt(cfg, now).then(r => { if (live) setCode(r); }); return () => { live = false; }; }, [secret, Math.floor(now / 1000)]);
  if (!cfg) return <FieldRow label="2FA secret (not a valid code setup)" value={secret} onCopy={() => onCopy(secret)} />;
  return (
    <div className="fieldrow">
      <div className="grow"><div className="lbl">{cfg.issuer ? `2FA code for ${cfg.issuer}` : "2FA code"}</div><div className="totp" aria-live="off">{code ? formatCode(code.code) : "··· ···"}</div></div>
      {code && <span className="row" style={{ gap: 6 }}><span className="faint">{code.remaining}s</span><Ring fraction={code.remaining / cfg.period} low={code.remaining <= 5} /></span>}
      <IconButton small label="Copy code" onClick={() => code && onCopy(code.code)}><TbCopy /></IconButton>
    </div>
  );
}

function UrlRow({ url, onCopy }: { url: string; onCopy: () => void }) {
  const href = safeHref(url);
  return (
    <div className="fieldrow">
      <div className="grow"><div className="lbl">Website</div><div className="val">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{host(url)}</a> : url}</div></div>
      {href && <a className="icon-btn small" href={href} target="_blank" rel="noopener noreferrer" aria-label="Open website"><TbExternalLink /></a>}
      <IconButton small label="Copy website" onClick={onCopy}><TbCopy /></IconButton>
    </div>
  );
}

export function Thumb({ meta, onOpen, onRemove }: { meta: AttachmentMeta; onOpen?: () => void; onRemove?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    if (isImage(meta.mime)) session.attachmentUrl(meta).then(u => { if (live) setUrl(u); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [meta.id]);
  return (
    <div className="thumb" style={{ padding: 0 }}>
      <button type="button" aria-label={`Open ${meta.name}`} onClick={onOpen} style={{ border: "none", background: "none", padding: 0, width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "inherit" }}>
        {url ? <img src={url} alt={meta.name} /> : <><TbFile size={28} /><span className="fname">{failed ? "Missing" : meta.name}</span></>}
      </button>
      {onRemove && <button type="button" className="rm" aria-label={`Remove ${meta.name}`} onClick={onRemove}>✕</button>}
    </div>
  );
}

function MoveOne({ it, onClose }: { it: Item; onClose: () => void }) {
  const s = useSession();
  const [name, setName] = useState(it.category);
  const cats = [...new Set(s.vault!.items.filter(i => i.deletedAt == null).map(i => i.category))];
  return (
    <Dialog title="Move to category" onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => { void session.commit(v => moveItems(v, [it.id], name)); onClose(); }}>Move</Button></>}>
      <div className="chips" style={{ padding: "0 0 12px", flexWrap: "wrap", maskImage: "none", WebkitMaskImage: "none" }}>
        {cats.map(c => <button key={c} type="button" className={`chip ${catClass(c)} ${name === c ? "on" : ""}`} onClick={() => setName(c)}><span className="dot" />{c}</button>)}
      </div>
      <TextInput label="Or a new category" value={name} onChange={e => setName(e.target.value)} />
    </Dialog>
  );
}

function HistoryDialog({ it, onClose, onCopy }: { it: Item; onClose: () => void; onCopy: (v: string) => void }) {
  const [show, setShow] = useState<number | null>(null);
  return (
    <Dialog title="Password history" onClose={onClose} actions={<Button onClick={onClose}>Close</Button>}>
      <p>Earlier passwords for {it.title}, newest first. Kept so you can get back in if a password change went wrong.</p>
      <div className="card" style={{ background: "var(--surface-2)" }}>
        {it.history.map((h, i) => (
          <div key={i} className="fieldrow">
            <div className="grow"><div className="lbl">Until {dateTime(h.changedAt)}</div><div className="val secret">{show === i ? h.password : "•".repeat(12)}</div></div>
            <IconButton small label={show === i ? "Hide" : "Show"} onClick={() => setShow(show === i ? null : i)}>{show === i ? <TbEyeOff /> : <TbEye />}</IconButton>
            <IconButton small label="Copy old password" onClick={() => onCopy(h.password)}><TbCopy /></IconButton>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
