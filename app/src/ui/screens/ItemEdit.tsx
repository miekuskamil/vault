import { useEffect, useMemo, useRef, useState } from "react";
import { TbCamera, TbDice, TbEye, TbEyeOff, TbPaperclip, TbPlus, TbQrcode, TbStar, TbStarFilled, TbTrash } from "react-icons/tb";
import { hasLoginFields, ITEM_TYPES, presetFields, updateItem, UNCATEGORIZED, type AttachmentMeta, type CustomField, type ItemDraft, type ItemType } from "../../core/model";
import { session } from "../../core/session";
import { toasts } from "../../core/toasts";
import { newId } from "../../core/bytes";
import { parseTotp } from "../../core/totp";
import { DEFAULT_PASSPHRASE, DEFAULT_PASSWORD, generatePassphrase, generatePassword, passphraseEntropy, passwordEntropy, type PassphraseOptions, type PasswordOptions } from "../../core/generator";
import { Button, Dialog, IconButton, Page, StrengthBar, Switch, TextArea, TextInput, TYPE_ICON } from "../components";
import { useNav } from "../nav";
import { catClass, pickFiles, useSession } from "../util";
import { Thumb } from "./ItemView";

interface Draft { type: ItemType; title: string; category: string; username: string; password: string; url: string; totp: string; notes: string; fields: CustomField[]; attachments: AttachmentMeta[]; favorite: boolean }

const GEN_KEY = "pwvault_generator";
function loadGen(): { mode: "password" | "passphrase"; pw: PasswordOptions; pp: PassphraseOptions } {
  try { const g = JSON.parse(localStorage.getItem(GEN_KEY) ?? ""); if (g?.pw && g?.pp) return g; } catch { /* default */ }
  return { mode: "password", pw: DEFAULT_PASSWORD, pp: DEFAULT_PASSPHRASE };
}

export function ItemEdit({ id, type: initialType, category }: { id: string | null; type?: ItemType; category?: string }) {
  const s = useSession();
  const nav = useNav();
  const existing = id ? s.vault!.items.find(i => i.id === id) : undefined;
  const initial = useMemo<Draft>(() => existing
    ? { type: existing.type, title: existing.title, category: existing.category, username: existing.username, password: existing.password, url: existing.url, totp: existing.totp, notes: existing.notes, fields: existing.fields.map(f => ({ ...f })), attachments: [...existing.attachments], favorite: existing.favorite }
    : { type: initialType ?? "login", title: "", category: category ?? "", username: "", password: "", url: "", totp: "", notes: "", fields: presetFields(initialType ?? "login"), attachments: [], favorite: false },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);
  const [d, setD] = useState<Draft>(initial);
  const [showPw, setShowPw] = useState(!existing);
  const [gen, setGen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const [attBusy, setAttBusy] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nav.setGuard(() => { if (dirtyRef.current) { setDiscard(true); return false; } return true; });
    return () => nav.setGuard(null);
  }, []);
  useEffect(() => { if (!existing) setTimeout(() => titleRef.current?.focus(), 250); }, []);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(x => ({ ...x, [k]: v }));
  const changeType = (t: ItemType) => setD(x => {
    const blank = x.fields.every(f => !f.value);
    return { ...x, type: t, fields: blank ? presetFields(t) : x.fields };
  });
  const cats = useMemo(() => [...new Set(s.vault!.items.filter(i => i.deletedAt == null).map(i => i.category))], [s.vault]);
  // The text box is only for a new category; picking a chip clears it, clearing it goes back to the last chip.
  const [newCat, setNewCat] = useState(() => (cats.includes(d.category) ? "" : d.category));
  const lastChip = useRef(cats.includes(d.category) ? d.category : "");
  const totpBad = d.totp.trim() !== "" && !parseTotp(d.totp);

  const save = async () => {
    setError("");
    if (!d.title.trim()) { setError("Give it a name."); titleRef.current?.focus(); return; }
    if (totpBad) { setError("The 2FA secret isn't valid. Paste the setup key or otpauth:// link the site shows."); return; }
    const draft: ItemDraft = { ...d, title: d.title.trim(), category: d.category.trim() || UNCATEGORIZED, fields: d.fields.filter(f => f.label.trim() || f.value.trim()) };
    if (!hasLoginFields(d.type)) { draft.username = ""; draft.password = ""; draft.url = ""; draft.totp = ""; }
    setBusy(true);
    try {
      if (existing) {
        await session.commit(v => updateItem(v, existing.id, draft));
        dirtyRef.current = false;
        nav.setGuard(null);
        nav.back();
      } else {
        const item = await session.addItem(draft);
        dirtyRef.current = false;
        nav.replace({ kind: "item", id: item.id });
      }
      toasts.show("Saved");
    } catch (e) {
      setError("Couldn't save: " + (e as Error).message);
      setBusy(false);
    }
  };

  const addFiles = async (capture?: string) => {
    const files = await pickFiles(capture ? "image/*" : "image/*,application/pdf", !capture, capture);
    if (!files.length) return;
    setAttBusy(true);
    try {
      for (const f of files) { const meta = await session.addAttachment(f); setD(x => ({ ...x, attachments: [...x.attachments, meta] })); }
    } catch (e) { toasts.error((e as Error).message); }
    setAttBusy(false);
  };

  const scanQr = async () => {
    const [f] = await pickFiles("image/*", false, "environment");
    if (!f) return;
    try {
      const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(b: ImageBitmapSource): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
      if (!Detector) throw new Error("no detector");
      const codes = await new Detector({ formats: ["qr_code"] }).detect(await createImageBitmap(f));
      const hit = codes.find(c => /^otpauth:\/\//i.test(c.rawValue));
      if (!hit) throw new Error("No 2FA QR code found in that photo.");
      set("totp", hit.rawValue);
      toasts.show("2FA code added");
    } catch (e) { toasts.error((e as Error).message === "no detector" ? "This browser can't read QR codes. Paste the setup key instead." : (e as Error).message); }
  };
  const canScan = typeof window !== "undefined" && "BarcodeDetector" in window;

  return (
    <Page title={existing ? "Edit item" : "New item"} onBack={nav.back}
      footer={<><Button onClick={nav.back}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <div className="seg" role="radiogroup" aria-label="Item type">
          {ITEM_TYPES.map(t => (
            <button key={t.id} type="button" role="radio" aria-checked={d.type === t.id} className={d.type === t.id ? "on" : ""} onClick={() => changeType(t.id)}>
              {TYPE_ICON[t.id]}<span>{t.label.replace("Secure note", "Note").replace("ID document", "ID").replace("Bank account", "Bank")}</span>
            </button>
          ))}
        </div>

        <div className="group">
          <TextInput label="Name" inputRef={titleRef} value={d.title} onChange={e => set("title", e.target.value)} placeholder={d.type === "bank" ? "HSBC current account" : d.type === "card" ? "Visa debit" : d.type === "identity" ? "Passport" : d.type === "note" ? "Wi-Fi at home" : "Netflix"} autoCapitalize="sentences" />
          <div className="field">
            <label>Category</label>
            {cats.length > 0 && (
              <div className="chips" style={{ padding: 0, flexWrap: "wrap", maskImage: "none", WebkitMaskImage: "none" }}>
                {cats.map(c => <button key={c} type="button" className={`chip ${catClass(c)} ${d.category === c ? "on" : ""}`} onClick={() => { lastChip.current = c; setNewCat(""); set("category", c); }}><span className="dot" />{c}</button>)}
              </div>
            )}
            <div className="input"><input aria-label="Category name" value={newCat} onChange={e => { setNewCat(e.target.value); set("category", e.target.value.trim() ? e.target.value : lastChip.current); }} placeholder={cats.length ? "Or type a new one" : "Subscriptions"} /></div>
          </div>
          <label className="row" style={{ justifyContent: "space-between" }}>
            <span className="row" style={{ gap: 8 }}>{d.favorite ? <TbStarFilled style={{ color: "var(--warn)" }} /> : <TbStar />}Favorite</span>
            <Switch checked={d.favorite} onChange={v => set("favorite", v)} label="Favorite" />
          </label>
        </div>

        {hasLoginFields(d.type) && (
          <>
            <div className="group-title">{d.type === "bank" ? "Online banking" : "Login"}</div>
            <div className="group">
              <TextInput label="Username or email" value={d.username} onChange={e => set("username", e.target.value)} inputMode="email" />
              <div className="field">
                <label htmlFor="f-password">Password</label>
                <div className="input">
                  <input id="f-password" className={showPw ? "mono" : ""} type={showPw ? "text" : "password"} value={d.password} onChange={e => set("password", e.target.value)} autoComplete="new-password" autoCapitalize="off" spellCheck={false} />
                  <IconButton small label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw(v => !v)}>{showPw ? <TbEyeOff /> : <TbEye />}</IconButton>
                  <IconButton small label="Generate password" className={gen ? "accent" : ""} onClick={() => setGen(g => !g)}><TbDice /></IconButton>
                </div>
                <StrengthBar password={d.password} userInputs={[d.title, d.username, d.url]} />
                {existing?.password && d.password !== existing.password && <div className="hint">The old password is kept in this item's history.</div>}
              </div>
              {gen && <Generator onUse={p => { set("password", p); setShowPw(true); }} />}
              <TextInput label="Website" value={d.url} onChange={e => set("url", e.target.value)} inputMode="url" placeholder="netflix.com" />
              <TextInput label="2FA secret (optional)" value={d.totp} onChange={e => set("totp", e.target.value)} placeholder="Setup key or otpauth:// link" className="mono"
                error={totpBad ? "Not a valid setup key" : undefined} hint="Shows the 6-digit sign-in code here, like an authenticator app."
                right={canScan ? <IconButton small label="Scan QR code from a photo" onClick={() => void scanQr()}><TbQrcode /></IconButton> : undefined} />
            </div>
          </>
        )}

        <div className="group-title">{d.type === "login" ? "More fields" : "Details"}</div>
        <div className="group">
          {d.fields.map((f, i) => (
            <div className="cf" key={f.id}>
              <div className="cf-inputs">
                <div className="input"><input aria-label="Field name" placeholder="Field name" value={f.label} onChange={e => set("fields", d.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></div>
                <div className="input">
                  <input aria-label={`${f.label || "Field"} value`} placeholder="Value" className={f.hidden ? "mono" : ""} value={f.value} onChange={e => set("fields", d.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <IconButton small label={f.hidden ? "Hidden by default. Tap to show it by default" : "Shown by default. Tap to hide it by default"} onClick={() => set("fields", d.fields.map((x, j) => (j === i ? { ...x, hidden: !x.hidden } : x)))}>{f.hidden ? <TbEyeOff /> : <TbEye />}</IconButton>
                </div>
              </div>
              <IconButton label={`Remove ${f.label || "field"}`} onClick={() => set("fields", d.fields.filter((_, j) => j !== i))}><TbTrash /></IconButton>
            </div>
          ))}
          <Button variant="ghost" icon={<TbPlus />} onClick={() => set("fields", [...d.fields, { id: newId(), label: "", value: "", hidden: false }])}>Add field</Button>
        </div>

        <div className="group">
          <TextArea label="Notes" value={d.notes} onChange={v => set("notes", v)} rows={d.type === "note" ? 8 : 3} />
        </div>

        <div className="group-title">Attachments</div>
        <div className="group" style={{ padding: 0 }}>
          <div className="thumbs">
            {d.attachments.map(a => <Thumb key={a.id} meta={a} onRemove={() => set("attachments", d.attachments.filter(x => x.id !== a.id))} />)}
            <button type="button" className="thumb add" onClick={() => void addFiles("environment")} aria-label="Take a photo" disabled={attBusy}><TbCamera /></button>
            <button type="button" className="thumb add" onClick={() => void addFiles()} aria-label="Attach a photo or PDF" disabled={attBusy}><TbPaperclip /></button>
          </div>
          <div className="hint" style={{ padding: "0 16px 14px" }}>{attBusy ? "Encrypting…" : "Photos are resized to about 200 KB and encrypted like everything else."}</div>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>

      {discard && (
        <Dialog title="Discard changes?" onClose={() => setDiscard(false)} actions={<>
          <Button onClick={() => setDiscard(false)}>Keep editing</Button>
          <Button variant="danger" onClick={() => { setDiscard(false); dirtyRef.current = false; nav.setGuard(null); nav.forceBack(); }}>Discard</Button>
        </>}>
          <p>Your changes to this item haven't been saved.</p>
        </Dialog>
      )}
    </Page>
  );
}

function Generator({ onUse }: { onUse: (p: string) => void }) {
  const [g, setG] = useState(loadGen);
  const [value, setValue] = useState(() => (g.mode === "password" ? generatePassword(g.pw) : generatePassphrase(g.pp)));
  const regen = (next = g) => {
    const v = next.mode === "password" ? generatePassword(next.pw) : generatePassphrase(next.pp);
    setValue(v);
    onUse(v);
    try { localStorage.setItem(GEN_KEY, JSON.stringify(next)); } catch { /* not important */ }
  };
  useEffect(() => { onUse(value); }, []);
  const update = (next: typeof g) => { setG(next); regen(next); };
  const bits = g.mode === "password" ? passwordEntropy(g.pw) : passphraseEntropy(g.pp);
  return (
    <div className="gen" aria-label="Password generator">
      <div className="seg inline" role="radiogroup" aria-label="Kind">
        {(["password", "passphrase"] as const).map(m => <button key={m} type="button" role="radio" aria-checked={g.mode === m} className={g.mode === m ? "on" : ""} onClick={() => update({ ...g, mode: m })}>{m === "password" ? "Characters" : "Words"}</button>)}
      </div>
      {g.mode === "password" ? (
        <>
          <label className="range"><span className="faint" style={{ minWidth: 52 }}>Length</span><input type="range" min={8} max={64} step={1} value={g.pw.length} onChange={e => update({ ...g, pw: { ...g.pw, length: Number(e.target.value) } })} /><output>{g.pw.length}</output></label>
          <div className="opts">
            {([["upper", "A–Z"], ["lower", "a–z"], ["digits", "0–9"], ["symbols", "!@#"]] as const).map(([k, label]) => (
              <button key={k} type="button" className={`opt ${g.pw[k] ? "on" : ""}`} aria-pressed={g.pw[k]} onClick={() => update({ ...g, pw: { ...g.pw, [k]: !g.pw[k] } })}>{label}</button>
            ))}
          </div>
        </>
      ) : (
        <>
          <label className="range"><span className="faint" style={{ minWidth: 52 }}>Words</span><input type="range" min={3} max={10} step={1} value={g.pp.words} onChange={e => update({ ...g, pp: { ...g.pp, words: Number(e.target.value) } })} /><output>{g.pp.words}</output></label>
          <div className="opts">
            {([["-", "a-b"], [" ", "a b"], [".", "a.b"]] as const).map(([sep, label]) => <button key={label} type="button" className={`opt ${g.pp.separator === sep ? "on" : ""}`} onClick={() => update({ ...g, pp: { ...g.pp, separator: sep } })}>{label}</button>)}
            <button type="button" className={`opt ${g.pp.capitalize ? "on" : ""}`} aria-pressed={g.pp.capitalize} onClick={() => update({ ...g, pp: { ...g.pp, capitalize: !g.pp.capitalize } })}>Capitals</button>
            <button type="button" className={`opt ${g.pp.addNumber ? "on" : ""}`} aria-pressed={g.pp.addNumber} onClick={() => update({ ...g, pp: { ...g.pp, addNumber: !g.pp.addNumber } })}>Number</button>
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="faint">{bits} bits of randomness</span>
        <Button small icon={<TbDice />} onClick={() => regen()}>New one</Button>
      </div>
    </div>
  );
}
