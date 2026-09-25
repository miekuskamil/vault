import { useState } from "react";
import { TbAlertTriangle, TbFileUpload, TbGitMerge, TbReplace } from "react-icons/tb";
import { session, WrongPasswordError } from "../../core/session";
import { BackupFormatError, type OpenedBackup, type ParsedBackup } from "../../core/backup";
import { categoriesOf, liveItems } from "../../core/model";
import { toasts } from "../../core/toasts";
import { Banner, Button, Page, PasswordInput, TypedConfirm } from "../components";
import { dateTime, pickFiles, useSession } from "../util";

/**
 * Restore a backup file.
 *  adopt    — lock/setup screen: the backup becomes this device's vault, with the backup's password.
 *  unlocked — settings: merge into or replace the open vault; your master password stays the same.
 *  legacy   — an old-format vault found on this device: merge it in.
 */
export function RestoreFlow({ mode, onClose, onDone }: { mode: "adopt" | "unlocked" | "legacy"; onClose: () => void; onDone?: () => void }) {
  const s = useSession();
  const [parsed, setParsed] = useState<ParsedBackup | null>(mode === "legacy" ? ({ kind: "v1" } as ParsedBackup) : null);
  const [fileName, setFileName] = useState("");
  const [pw, setPw] = useState("");
  const [opened, setOpened] = useState<OpenedBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmReplace, setConfirmReplace] = useState(false);

  const pick = async () => {
    setError("");
    const [f] = await pickFiles(".vault,.json,application/json");
    if (!f) return;
    try {
      setParsed(session.parseBackup(await f.text()));
      setFileName(f.name);
    } catch (e) {
      setError(e instanceof BackupFormatError ? "That file isn't a vault backup. Pick the .vault file you exported." : (e as Error).message);
    }
  };

  const open = async () => {
    if (!parsed || !pw) return;
    setBusy(true); setError("");
    try {
      const o = mode === "legacy" ? await session.openLegacy(pw) : await session.openBackup(parsed, pw);
      if (!o) throw new Error("The old vault is no longer on this device.");
      setOpened(o);
    } catch (e) {
      setError(e instanceof WrongPasswordError ? "That password doesn't open this backup." : (e as Error).message);
    } finally { setBusy(false); }
  };

  const finish = (msg: string) => { toasts.show(msg, { ms: 4000 }); onDone?.(); onClose(); };

  const adopt = async () => {
    setBusy(true);
    try { await session.adoptBackup(opened!, pw); finish("Backup restored"); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const merge = async () => {
    setBusy(true);
    try {
      const r = await session.mergeBackup(opened!);
      if (mode === "legacy") session.dismissLegacy();
      finish(r.added ? `Added ${r.added} item${r.added === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} already here` : ""}` : "Nothing new: everything in the backup is already here");
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const count = opened ? liveItems(opened.vault).length : 0;
  const cats = opened ? categoriesOf(opened.vault) : [];
  const hasVault = s.status !== "setup";

  return (
    <Page title={mode === "legacy" ? "Old vault on this device" : "Restore a backup"} onBack={onClose}>
      <div className="stack">
        {!parsed && (
          <>
            <p className="muted" style={{ margin: 0 }}>Pick a <b>.vault</b> backup file. Backups from the old version of this app work too.</p>
            <div className="drop"><TbFileUpload /><p>Your backup stays encrypted until you enter its password.</p><Button variant="primary" onClick={() => void pick()}>Choose backup file</Button></div>
          </>
        )}
        {parsed && !opened && (
          <form className="stack" onSubmit={e => { e.preventDefault(); void open(); }}>
            {mode === "legacy"
              ? <p className="muted" style={{ margin: 0 }}>A vault from the old version of this app is still on this device. Enter the password you used for it to bring its items in.</p>
              : <p className="muted" style={{ margin: 0 }}>{fileName}{parsed.kind === "v1" ? " (old format)" : ""}. Enter the master password the backup was made with.</p>}
            <PasswordInput label="Backup's master password" value={pw} onChange={e => setPw(e.target.value)} autoFocus error={error || undefined} autoComplete="off" />
            <Button type="submit" variant="primary" block loading={busy} disabled={!pw}>Open backup</Button>
            {mode !== "legacy" && <Button variant="ghost" block onClick={() => { setParsed(null); setPw(""); setError(""); }}>Choose a different file</Button>}
          </form>
        )}
        {opened && (
          <div className="stack">
            <div className="stats">
              <div><b>{count}</b><span className="faint">items</span></div>
              <div><b>{cats.length}</b><span className="faint">categories</span></div>
            </div>
            <div className="faint">{opened.exportedAt ? `Backed up ${dateTime(opened.exportedAt)}` : "Old-format backup"}{cats.length ? `. Categories: ${cats.slice(0, 6).map(c => c.name).join(", ")}${cats.length > 6 ? "…" : ""}` : ""}</div>
            {opened.missing > 0 && <Banner tone="warn" icon={<TbAlertTriangle />}>{opened.missing} attachment{opened.missing === 1 ? " isn't" : "s aren't"} in this file and will be missing.</Banner>}
            {error && <div className="error-text" role="alert">{error}</div>}
            {mode === "adopt" ? (
              <>
                {hasVault && <Banner tone="info" icon={<TbAlertTriangle />}>This replaces the vault on this device. It's kept, encrypted, for 30 days in case you need it back. After this you unlock with the backup's password.</Banner>}
                <Button variant="primary" block loading={busy} onClick={() => (hasVault ? setConfirmReplace(true) : void adopt())}>Use this backup</Button>
              </>
            ) : (
              <>
                <Button variant="primary" block icon={<TbGitMerge />} loading={busy} onClick={() => void merge()}>Add its items to your vault</Button>
                <div className="faint">Items already in your vault are skipped. Your master password doesn't change.</div>
                {mode === "unlocked" && <Button variant="danger-outline" block icon={<TbReplace />} disabled={busy} onClick={() => setConfirmReplace(true)}>Replace your vault with it</Button>}
              </>
            )}
          </div>
        )}
        {error && !parsed && <div className="error-text" role="alert">{error}</div>}
      </div>
      {confirmReplace && (
        <TypedConfirm
          title={mode === "adopt" ? "Replace this device's vault?" : "Replace your vault's contents?"}
          message={mode === "adopt" ? "The current vault is kept encrypted for 30 days, then removed." : `Your ${s.vault ? liveItems(s.vault).length : 0} items are replaced by the backup's ${count}. A copy of your current vault is saved in Version history first.`}
          word="REPLACE" action="Replace" onClose={() => setConfirmReplace(false)}
          onConfirm={async () => {
            if (mode === "adopt") await adopt();
            else { await session.replaceWithBackup(opened!); finish("Vault replaced with the backup"); }
          }}
        />
      )}
    </Page>
  );
}
