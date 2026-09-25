import { useEffect, useState } from "react";
import {
  TbAlertTriangle, TbArchive, TbCategory, TbChevronRight, TbClipboard, TbClock, TbCloudUpload, TbDatabaseExport, TbFileSpreadsheet,
  TbFingerprint, TbHistory, TbInfoCircle, TbKey, TbLock, TbLogout, TbPalette, TbRestore, TbTrash, TbUpload, TbDoorExit,
} from "react-icons/tb";
import { session, WrongPasswordError } from "../../core/session";
import { categoriesOf, liveItems, purgeItems, renameCategory, restoreItems, trashItems, UNCATEGORIZED, type Item } from "../../core/model";
import { toCsv } from "../../core/exporters";
import { backupFileName } from "../../core/backup";
import { estimate, MASTER_MIN_BITS } from "../../core/strength";
import type { Snapshot } from "../../core/storage";
import { toasts } from "../../core/toasts";
import { Avatar, Banner, Button, Dialog, Empty, Page, PasswordInput, StrengthBar, Switch, TextInput, TypedConfirm } from "../components";
import { useNav } from "../nav";
import { ago, catClass, dateTime, download, getThemePref, setThemePref, shareOrDownload, useSession, type ThemePref } from "../util";
import { SaveBanner } from "../Shell";

function SRow({ icon, tone, title, sub, value, onClick, right, danger, disabled }: { icon: React.ReactNode; tone?: string; title: string; sub?: React.ReactNode; value?: React.ReactNode; onClick?: () => void; right?: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  const inner = <>
    <span className={`ic ${tone ?? ""}`}>{icon}</span>
    <span className="txt"><div>{title}</div>{sub && <div className="sub">{sub}</div>}</span>
    {value && <span className="val">{value}</span>}
    {right ?? (onClick && <TbChevronRight className="chev" />)}
  </>;
  return onClick ? <button type="button" className={`srow ${danger ? "danger" : ""}`} onClick={onClick} disabled={disabled}>{inner}</button> : <div className={`srow ${danger ? "danger" : ""}`}>{inner}</div>;
}

function SelectRow<T extends number | string>({ icon, tone, title, sub, value, options, onChange }: { icon: React.ReactNode; tone?: string; title: string; sub?: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="srow">
      <span className={`ic ${tone ?? ""}`}>{icon}</span>
      <span className="txt"><div>{title}</div>{sub && <div className="sub">{sub}</div>}</span>
      <select value={String(value)} aria-label={title} onChange={e => { const o = options.find(o => String(o.v) === e.target.value); if (o) onChange(o.v); }}>
        {options.map(o => <option key={String(o.v)} value={String(o.v)}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function SettingsScreen() {
  const s = useSession();
  const nav = useNav();
  const v = s.vault!;
  const st = v.settings;
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const [bioDialog, setBioDialog] = useState(false);
  const [exportCsv, setExportCsv] = useState(false);
  const [deleteAll, setDeleteAll] = useState(false);
  const [reset, setReset] = useState(false);
  const trashCount = v.items.filter(i => i.deletedAt != null).length;
  const update = (p: Partial<typeof st>) => void session.updateSettings(p).catch(e => toasts.error((e as Error).message));

  return (
    <>
      <header className="topbar"><div className="topbar-row"><h1>Settings</h1></div></header>
      <main className="content">
        <SaveBanner />
        <section className="settings-group"><h3>Security</h3><div className="rows">
          <SelectRow icon={<TbClock />} tone="violet" title="Auto-lock" sub="After this long without a tap" value={st.idleLockMin} onChange={n => update({ idleLockMin: n })}
            options={[{ v: 1, label: "1 minute" }, { v: 2, label: "2 minutes" }, { v: 5, label: "5 minutes" }, { v: 15, label: "15 minutes" }, { v: 30, label: "30 minutes" }]} />
          <SelectRow icon={<TbDoorExit />} tone="violet" title="Lock when you leave" sub="After switching to another app" value={st.leaveLockSec} onChange={n => update({ leaveLockSec: n })}
            options={[{ v: 0, label: "Immediately" }, { v: 30, label: "After 30 s" }, { v: 120, label: "After 2 min" }, { v: 600, label: "After 10 min" }]} />
          <SelectRow icon={<TbClipboard />} tone="violet" title="Clear copied passwords" sub="Clears when you're back in the app if you left" value={st.clipboardSec} onChange={n => update({ clipboardSec: n })}
            options={[{ v: 30, label: "After 30 s" }, { v: 60, label: "After 1 min" }, { v: 120, label: "After 2 min" }, { v: 0, label: "Never" }]} />
          {s.biometric.support === "available" ? (
            <SRow icon={<TbFingerprint />} tone="violet" title="Unlock with fingerprint" sub="Your master password still works too"
              right={<Switch checked={s.biometric.enrolled} label="Unlock with fingerprint" onChange={on => { if (on) setBioDialog(true); else void session.disableBiometric().then(() => toasts.show("Fingerprint unlock turned off")); }} />} />
          ) : (
            <SRow icon={<TbFingerprint />} title="Unlock with fingerprint" sub={s.biometric.support === "needs-install" ? "Available when the app is installed from its web address" : "Not supported on this device"} />
          )}
          <SRow icon={<TbKey />} tone="violet" title="Change master password" onClick={() => nav.push({ kind: "password" })} />
          <SRow icon={<TbLock />} tone="violet" title="Lock now" onClick={() => session.lockNow()} right={<span />} />
        </div></section>

        <section className="settings-group"><h3>Backup and restore</h3><div className="rows">
          <SRow icon={<TbCloudUpload />} tone="green" title="Back up now" sub={st.lastBackupAt ? `Last backup ${ago(st.lastBackupAt)}` : "No backup yet"} onClick={() => nav.push({ kind: "backup" })} />
          <SRow icon={<TbUpload />} tone="green" title="Restore or merge a backup" onClick={() => nav.push({ kind: "restore" })} />
          <SRow icon={<TbHistory />} tone="green" title="Version history" sub="Earlier copies saved before big changes" onClick={() => nav.push({ kind: "history" })} />
          <SRow icon={<TbArchive />} tone="green" title="Replaced vaults" onClick={() => nav.push({ kind: "retired" })} />
        </div></section>

        <section className="settings-group"><h3>Import and export</h3><div className="rows">
          <SRow icon={<TbFileSpreadsheet />} tone="blue" title="Import a spreadsheet" sub="Excel, CSV, or exports from Chrome, Bitwarden, 1Password" onClick={() => nav.push({ kind: "import" })} />
          <SRow icon={<TbDatabaseExport />} tone="blue" title="Export as spreadsheet" sub="Not encrypted. For moving to another app" onClick={() => setExportCsv(true)} />
        </div></section>

        <section className="settings-group"><h3>Organize</h3><div className="rows">
          <SRow icon={<TbCategory />} tone="amber" title="Categories" value={categoriesOf(v).length} onClick={() => nav.push({ kind: "categories" })} />
          <SRow icon={<TbTrash />} tone="amber" title="Trash" sub="Emptied automatically after 30 days" value={trashCount || undefined} onClick={() => nav.push({ kind: "trash" })} />
        </div></section>

        <section className="settings-group"><h3>Appearance</h3><div className="rows">
          <SelectRow icon={<TbPalette />} tone="teal" title="Theme" value={theme} onChange={t => { setTheme(t); setThemePref(t); }}
            options={[{ v: "dark", label: "Dark" }, { v: "light", label: "Light" }, { v: "system", label: "Match phone" }]} />
        </div></section>

        <section className="settings-group"><h3>Danger zone</h3><div className="rows">
          <SRow icon={<TbTrash />} tone="red" danger title="Delete all items" sub="Moves everything to trash" onClick={() => setDeleteAll(true)} />
          <SRow icon={<TbLogout />} tone="red" danger title="Reset vault" sub="Erase this vault and start over" onClick={() => setReset(true)} />
        </div></section>

        <section className="settings-group"><div className="rows">
          <SRow icon={<TbInfoCircle />} title="About and security" sub={`Version ${__VERSION__}`} onClick={() => nav.push({ kind: "about" })} />
        </div></section>
      </main>

      {bioDialog && <BiometricDialog onClose={() => setBioDialog(false)} />}
      {exportCsv && (
        <TypedConfirm title="Export unencrypted?" word="EXPORT" action="Export CSV" onClose={() => setExportCsv(false)}
          message="The file contains every password in plain text. Anyone who gets it can read them. Delete it once you've imported it elsewhere."
          onConfirm={() => { download(new Blob([toCsv(v)], { type: "text/csv;charset=utf-8" }), `vault-export-${new Date().toISOString().slice(0, 10)}.csv`); toasts.show("CSV saved to Downloads. Delete it when you're done."); }} />
      )}
      {deleteAll && (
        <TypedConfirm title="Delete all items?" word="DELETE" action="Delete all" onClose={() => setDeleteAll(false)}
          message={`All ${liveItems(v).length} items move to trash. You can restore them from Trash or Version history for 30 days.`}
          onConfirm={async () => { const ids = liveItems(session.vault!).map(i => i.id); await session.commit(x => trashItems(x, ids), { snapshot: "Before deleting all items" }); toasts.show("All items moved to trash", { action: { label: "Undo", run: () => void session.commit(x => restoreItems(x, ids)) } }); }} />
      )}
      {reset && <ResetDialog onClose={() => setReset(false)} />}
    </>
  );
}

function ResetDialog({ onClose }: { onClose: () => void }) {
  const [keep, setKeep] = useState(true);
  return (
    <TypedConfirm title="Reset vault?" word="RESET" action="Reset vault" onClose={onClose}
      message="This erases the vault on this device, including its version history, and starts over with a new master password."
      onConfirm={() => session.reset(keep)}>
      <label className="row" style={{ margin: "0 0 14px", fontSize: 14 }}>
        <input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--accent-fill)" }} />
        <span>Keep an encrypted copy for 30 days in case this was a mistake</span>
      </label>
    </TypedConfirm>
  );
}

function BiometricDialog({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true); setError("");
    try { await session.enableBiometric(pw); toasts.show("Fingerprint unlock is on"); onClose(); }
    catch (e) { setError(e instanceof WrongPasswordError ? "Wrong master password." : (e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Turn on fingerprint unlock" onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!pw} onClick={() => void go()}>Continue</Button></>}>
      <p>Confirm your master password, then your phone asks for your fingerprint to create a passkey for this vault.</p>
      <PasswordInput label="Master password" value={pw} onChange={e => setPw(e.target.value)} autoFocus error={error || undefined} onKeyDown={e => { if (e.key === "Enter") void go(); }} />
    </Dialog>
  );
}

export function BackupPage() {
  const s = useSession();
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const v = s.vault!;
  const run = async () => {
    setBusy(true);
    try {
      const blob = await session.exportBackup(__VERSION__);
      const how = await shareOrDownload(blob, backupFileName(), "Vault backup");
      if (how !== "cancelled") {
        await session.updateSettings({ lastBackupAt: Date.now() });
        toasts.show(how === "shared" ? "Backup shared" : "Backup saved to Downloads");
      }
    } catch (e) { toasts.error((e as Error).message); }
    setBusy(false);
  };
  const attachments = liveItems(v).reduce((n, i) => n + i.attachments.length, 0);
  return (
    <Page title="Back up" onBack={nav.back}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>A backup is one encrypted <b>.vault</b> file with every item{attachments ? ` and ${attachments} attachment${attachments === 1 ? "" : "s"}` : ""}. It opens with your master password, in this app on any device.</p>
        <Banner tone="info" icon={<TbInfoCircle />}>Keep it somewhere other than this phone, like Google Drive or email to yourself. It's safe to store there: without your master password it's unreadable.</Banner>
        <Button variant="primary" block icon={<TbCloudUpload />} loading={busy} onClick={() => void run()}>Back up now</Button>
        <div className="faint" style={{ textAlign: "center" }}>{v.settings.lastBackupAt ? `Last backup ${dateTime(v.settings.lastBackupAt)}` : "You haven't backed up yet"}</div>
      </div>
    </Page>
  );
}

export function HistoryPage() {
  const nav = useNav();
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [pick, setPick] = useState<Snapshot | null>(null);
  useEffect(() => { void session.listSnapshots().then(setSnaps); }, []);
  return (
    <Page title="Version history" onBack={nav.back}>
      <p className="muted" style={{ marginTop: 0 }}>A copy is saved before deletes, imports and restores, and once a day you make changes. The last 15 are kept.</p>
      {snaps && snaps.length === 0 && <Empty icon={<TbHistory />} title="No earlier versions yet" />}
      {snaps && snaps.length > 0 && (
        <div className="settings-group"><div className="rows">
          {snaps.map(sn => <SRow key={sn.at} icon={<TbHistory />} tone="green" title={sn.reason} sub={`${dateTime(sn.at)}, ${sn.count} item${sn.count === 1 ? "" : "s"}`} onClick={() => setPick(sn)} />)}
        </div></div>
      )}
      {pick && (
        <Dialog title="Restore this version?" onClose={() => setPick(null)} actions={<>
          <Button onClick={() => setPick(null)}>Cancel</Button>
          <Button variant="primary" onClick={async () => { const p = pick; setPick(null); try { await session.restoreSnapshot(p); toasts.show("Earlier version restored"); nav.back(); } catch (e) { toasts.error((e as Error).message); } }}>Restore</Button>
        </>}>
          <p>Your vault goes back to how it was on {dateTime(pick.at)} ({pick.count} items). The current version is saved here first, so you can undo this.</p>
        </Dialog>
      )}
    </Page>
  );
}

export function TrashPage() {
  const s = useSession();
  const nav = useNav();
  const [pick, setPick] = useState<Item | null>(null);
  const [empty, setEmpty] = useState(false);
  const trashed = s.vault!.items.filter(i => i.deletedAt != null).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  const purge = async (ids: string[]) => { await session.commit(v => purgeItems(v, ids).vault, { snapshot: "Before emptying trash" }); void session.collectGarbage(); };
  return (
    <Page title="Trash" onBack={nav.back} actions={trashed.length ? <Button variant="ghost" small onClick={() => setEmpty(true)}>Empty</Button> : undefined}>
      {trashed.length === 0 ? <Empty icon={<TbTrash />} title="Trash is empty">Deleted items stay here for 30 days.</Empty> : (
        <div className="list">
          {trashed.map(it => (
            <div className="item-row" key={it.id}>
              <button type="button" className="main" onClick={() => setPick(it)}>
                <Avatar item={it} />
                <span className="grow"><span className="t ellipsis" style={{ display: "block" }}>{it.title}</span><span className="s">Deleted {ago(it.deletedAt)}, removed in {Math.max(0, 30 - Math.floor((Date.now() - (it.deletedAt ?? 0)) / 86_400_000))} days</span></span>
              </button>
              <Button variant="ghost" small icon={<TbRestore />} onClick={() => void session.commit(v => restoreItems(v, [it.id])).then(() => toasts.show("Restored"))}>Restore</Button>
            </div>
          ))}
        </div>
      )}
      {pick && (
        <Dialog title={pick.title} onClose={() => setPick(null)} actions={<>
          <Button variant="danger-outline" onClick={async () => { const id = pick.id; setPick(null); await purge([id]); toasts.show("Deleted forever"); }}>Delete forever</Button>
          <Button variant="primary" onClick={async () => { const id = pick.id; setPick(null); await session.commit(v => restoreItems(v, [id])); toasts.show("Restored"); }}>Restore</Button>
        </>}><p>Restore it to {pick.category}, or delete it for good.</p></Dialog>
      )}
      {empty && (
        <Dialog title="Empty trash?" onClose={() => setEmpty(false)} actions={<>
          <Button onClick={() => setEmpty(false)}>Cancel</Button>
          <Button variant="danger" onClick={async () => { setEmpty(false); await purge(trashed.map(i => i.id)); toasts.show("Trash emptied"); }}>Empty trash</Button>
        </>}><p>{trashed.length} item{trashed.length === 1 ? "" : "s"} will be deleted. Version history still has a copy for a while.</p></Dialog>
      )}
    </Page>
  );
}

export function CategoriesPage() {
  const s = useSession();
  const nav = useNav();
  const cats = categoriesOf(s.vault!);
  const [edit, setEdit] = useState<string | null>(null);
  const [name, setName] = useState("");
  return (
    <Page title="Categories" onBack={nav.back}>
      <p className="muted" style={{ marginTop: 0 }}>Rename a category, or give it the name of another one to merge them.</p>
      {cats.length === 0 ? <Empty icon={<TbCategory />} title="No categories yet" /> : (
        <div className="settings-group"><div className="rows">
          {cats.map(c => (
            <button key={c.name} type="button" className={`srow ${catClass(c.name)}`} onClick={() => { setEdit(c.name); setName(c.name); }}>
              <span className="ic" style={{ background: "color-mix(in srgb, var(--cat) 18%, transparent)", color: "var(--cat)" }}><TbCategory /></span>
              <span className="txt">{c.name}</span><span className="val">{c.count}</span><TbChevronRight className="chev" />
            </button>
          ))}
        </div></div>
      )}
      {edit && (
        <Dialog title={`Rename “${edit}”`} onClose={() => setEdit(null)} actions={<>
          <Button onClick={() => setEdit(null)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={async () => { const from = edit; setEdit(null); await session.commit(v => renameCategory(v, from, name.trim())); toasts.show("Category updated"); }}>Save</Button>
        </>}>
          <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} autoFocus />
          <div className="hint" style={{ marginTop: 8 }}>To remove a category, rename it to {UNCATEGORIZED} or to another category.</div>
        </Dialog>
      )}
    </Page>
  );
}

export function PasswordPage() {
  const nav = useNav();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const strong = estimate(next).bits >= MASTER_MIN_BITS;
  const go = async () => {
    setError("");
    if (!strong) return setError("Pick a stronger master password. Four or five random words work well.");
    if (next !== next2) return setError("The new passwords don't match.");
    setBusy(true);
    try { await session.changePassword(cur, next); toasts.show("Master password changed"); nav.back(); }
    catch (e) { setError(e instanceof WrongPasswordError ? "Your current master password is wrong." : (e as Error).message); setBusy(false); }
  };
  return (
    <Page title="Change master password" onBack={nav.back} footer={<Button variant="primary" loading={busy} disabled={!cur || !next || !next2} onClick={() => void go()}>Change password</Button>}>
      <form className="stack" onSubmit={e => { e.preventDefault(); void go(); }}>
        <PasswordInput label="Current master password" value={cur} onChange={e => setCur(e.target.value)} autoComplete="current-password" />
        <PasswordInput label="New master password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" />
        <StrengthBar password={next} />
        <PasswordInput label="Confirm new master password" value={next2} onChange={e => setNext2(e.target.value)} autoComplete="new-password" />
        {error && <div className="error-text" role="alert">{error}</div>}
        <Banner tone="warn" icon={<TbAlertTriangle />}>Backups you made before keep the old password. Make a new backup after changing it.</Banner>
        <button type="submit" hidden />
      </form>
    </Page>
  );
}

export function AboutPage() {
  const s = useSession();
  const nav = useNav();
  const kdf = session.kdfInfo();
  const v = s.vault!;
  return (
    <Page title="About and security" onBack={nav.back}>
      <div className="card">
        {[
          ["Version", `${__VERSION__} (${__BUILD__ === "pwa" ? "installed app" : "single file"})`],
          ["Encryption", "AES-256-GCM, one random data key"],
          ["Key from master password", kdf ? `${kdf.alg}, ${kdf.iterations.toLocaleString()} rounds` : "—"],
          ["Storage", s.storeKind === "indexeddb" ? "IndexedDB on this device" : "Local storage on this device"],
          ["Protected from browser cleanup", s.persisted ? "Yes" : "Not granted by the browser (back up regularly)"],
          ["Items", `${liveItems(v).length} (${v.items.length - liveItems(v).length} in trash)`],
          ["Network", "None. The app never connects to the internet"],
        ].map(([k, val]) => <div className="fieldrow" key={k}><div className="grow"><div className="lbl">{k}</div><div className="val" style={{ fontSize: 15 }}>{val}</div></div></div>)}
      </div>
      <p className="faint">Your master password never leaves this device and isn't stored. There's no recovery: without it or a backup, the data can't be opened by anyone, including you. Passphrase words come from the EFF long wordlist (CC BY 3.0).</p>
    </Page>
  );
}
