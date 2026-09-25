import { useState } from "react";
import { TbArchive } from "react-icons/tb";
import { session, WrongPasswordError } from "../../core/session";
import type { Retired } from "../../core/storage";
import { toasts } from "../../core/toasts";
import { Button, Dialog, Empty, Page, PasswordInput } from "../components";
import { ago, dateTime } from "../util";

/** Vaults that were replaced or reset on this device (kept encrypted for 30 days). */
export function RetiredList({ items, onClose, mode }: { items: Retired[]; onClose: () => void; mode: "adopt" | "unlocked" }) {
  const [pick, setPick] = useState<Retired | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const recover = async () => {
    if (!pick) return;
    setBusy(true); setError("");
    try {
      await session.recoverRetired(pick, pw);
      toasts.show("Previous vault recovered");
      onClose();
    } catch (e) {
      setError(e instanceof WrongPasswordError ? "That password doesn't open this vault." : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Page title="Replaced vaults" onBack={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>These were replaced or reset on this device. Each is kept encrypted for 30 days and opens only with the password it had.{mode === "unlocked" ? " Recovering one swaps it with your current vault, which is kept here the same way." : ""}</p>
      {items.length === 0 ? <Empty icon={<TbArchive />} title="Nothing here" /> : (
        <div className="settings-group"><div className="rows">
          {items.map(r => (
            <button key={r.at} type="button" className="srow" onClick={() => { setPick(r); setPw(""); setError(""); }}>
              <span className="ic amber"><TbArchive /></span>
              <span className="txt"><div>{r.reason}</div><div className="sub">{dateTime(r.at)} ({ago(r.at)})</div></span>
            </button>
          ))}
        </div></div>
      )}
      {pick && (
        <Dialog title="Recover this vault" onClose={() => setPick(null)} actions={<>
          <Button onClick={() => setPick(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!pw} onClick={() => void recover()}>Recover</Button>
        </>}>
          <p>Enter the master password this vault had.</p>
          <PasswordInput label="Master password" value={pw} onChange={e => setPw(e.target.value)} autoFocus error={error || undefined} onKeyDown={e => { if (e.key === "Enter") void recover(); }} />
        </Dialog>
      )}
    </Page>
  );
}
