import { useEffect, useRef, useState } from "react";
import { TbAlertTriangle, TbArchive, TbFingerprint, TbLifebuoy, TbRefresh, TbShieldLock, TbUpload } from "react-icons/tb";
import { LOCKED_MANUALLY, session, WrongPasswordError } from "../../core/session";
import { estimate, MASTER_MIN_BITS } from "../../core/strength";
import { generatePassphrase, DEFAULT_PASSPHRASE } from "../../core/generator";
import type { Retired } from "../../core/storage";
import { Banner, Button, Dialog, PasswordInput, StrengthBar, TypedConfirm } from "../components";
import { useSession, dateTime } from "../util";
import { RestoreFlow } from "./Restore";
import { RetiredList } from "./Retired";

function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="brand">
      <div className="mark"><TbShieldLock /></div>
      <h1>Vault</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export function SetupScreen() {
  const s = useSession();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restore, setRestore] = useState(false);
  const [retired, setRetired] = useState<Retired[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  useEffect(() => { void session.listRetired().then(setRetired).catch(() => undefined); }, []);
  const strength = estimate(pw);
  const strongEnough = strength.bits >= MASTER_MIN_BITS;

  const create = async () => {
    setError("");
    if (!strongEnough) return setError("Pick a stronger master password. Four or five random words work well.");
    if (pw !== pw2) return setError("The passwords don't match.");
    setBusy(true);
    try { await session.create(pw); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  if (restore) return <RestoreFlow mode="adopt" onClose={() => setRestore(false)} />;
  if (showRetired) return <RetiredList mode="adopt" items={retired} onClose={() => setShowRetired(false)} />;

  return (
    <div className="lock">
      <form className="lock-card" onSubmit={e => { e.preventDefault(); void create(); }}>
        <Brand subtitle="Create a master password. It's the only key to your vault and can't be recovered, so write it down somewhere safe." />
        {s.fatal && <Banner tone="danger" icon={<TbAlertTriangle />}>This browser won't let the app store data: {s.fatal}</Banner>}
        {suggested && (
          <div className="stack">
            <div className="faint">Suggested passphrase ({Math.round(5 * 12.9)}+ bits). Write it down:</div>
            <div className="passphrase-box" aria-live="polite">{suggested}</div>
          </div>
        )}
        <PasswordInput label="Master password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" placeholder="Four or five random words" reveal={!!suggested} />
        <StrengthBar password={pw} />
        <PasswordInput label="Confirm master password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" reveal={!!suggested} error={pw2 && pw !== pw2 ? "The passwords don't match" : undefined} />
        {error && <div className="error-text" role="alert">{error}</div>}
        <Button type="submit" variant="primary" block loading={busy} disabled={!pw || !pw2}>Create vault</Button>
        <Button variant="ghost" block icon={<TbRefresh />} onClick={() => { const p = generatePassphrase(DEFAULT_PASSPHRASE); setSuggested(p); setPw(p); setPw2(p); }}>Suggest a passphrase</Button>
        <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
          <Button variant="ghost" small icon={<TbUpload />} onClick={() => setRestore(true)}>Restore from a backup</Button>
          {retired.length > 0 && <Button variant="ghost" small icon={<TbArchive />} onClick={() => setShowRetired(true)}>Recover a previous vault</Button>}
        </div>
      </form>
    </div>
  );
}

export function LockScreen() {
  const s = useSession();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, force] = useState(0);
  const [trouble, setTrouble] = useState(false);
  const [restore, setRestore] = useState(false);
  const [reset, setReset] = useState(false);
  const [keepCopy, setKeepCopy] = useState(true);
  const [retired, setRetired] = useState<Retired[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bioTried = useRef(false);

  useEffect(() => { void session.listRetired().then(setRetired).catch(() => undefined); }, [trouble]);
  useEffect(() => {
    if (!waitUntil) return;
    const t = setInterval(() => { if (Date.now() >= waitUntil) setWaitUntil(0); force(n => n + 1); }, 500);
    return () => clearInterval(t);
  }, [waitUntil]);

  const bio = async () => {
    setError("");
    try { await session.unlockWithBiometric(); } catch (e) { setError((e as Error).message); }
  };
  // Ask for the fingerprint once when the lock screen comes into view. Right after "Lock now" it
  // waits until you come back to the app, so locking doesn't immediately ask to unlock.
  useEffect(() => {
    if (!s.biometric.enrolled || s.biometric.support !== "available") return;
    const tryOnce = () => { if (!bioTried.current && document.visibilityState === "visible") { bioTried.current = true; void bio(); } };
    if (s.lockReason !== LOCKED_MANUALLY) tryOnce();
    document.addEventListener("visibilitychange", tryOnce);
    return () => document.removeEventListener("visibilitychange", tryOnce);
  }, [s.biometric.enrolled, s.biometric.support, s.lockReason]);

  const unlock = async () => {
    if (!pw || Date.now() < waitUntil) return;
    setBusy(true); setError("");
    try {
      await session.unlock(pw);
    } catch (e) {
      const n = attempts + 1;
      setAttempts(n);
      setError(e instanceof WrongPasswordError ? "Wrong password." : (e as Error).message);
      if (n >= 5) setWaitUntil(Date.now() + Math.min(30, 3 * (n - 4)) * 1000);
      setBusy(false);
      inputRef.current?.select();
    }
  };

  if (restore) return <RestoreFlow mode="adopt" onClose={() => setRestore(false)} />;
  if (showRetired) return <RetiredList mode="adopt" items={retired} onClose={() => setShowRetired(false)} />;
  const wait = waitUntil ? Math.ceil((waitUntil - Date.now()) / 1000) : 0;

  return (
    <div className="lock">
      <form className="lock-card" onSubmit={e => { e.preventDefault(); void unlock(); }}>
        <Brand subtitle={s.legacy ? "Your vault will be upgraded to the new format after you unlock. The old copy is kept." : undefined} />
        {s.lockReason && <div className="faint" style={{ textAlign: "center" }} role="status">{s.lockReason}</div>}
        {s.fatal && <Banner tone="danger" icon={<TbAlertTriangle />}>{s.fatal}</Banner>}
        <PasswordInput label="Master password" inputRef={inputRef} value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" autoFocus={!s.biometric.enrolled} error={error || undefined} />
        <Button type="submit" variant="primary" block loading={busy} disabled={!pw || wait > 0}>{wait > 0 ? `Wait ${wait} s` : busy && s.legacy ? "Upgrading" : "Unlock"}</Button>
        {s.biometric.enrolled && s.biometric.support === "available" && <Button block icon={<TbFingerprint />} onClick={() => void bio()}>Unlock with fingerprint</Button>}
        {attempts > 0 && <div className="faint" style={{ textAlign: "center" }}>{attempts} failed attempt{attempts === 1 ? "" : "s"}</div>}
        <Button variant="ghost" block icon={<TbLifebuoy />} onClick={() => setTrouble(true)}>Trouble unlocking?</Button>
      </form>

      {trouble && (
        <Dialog title="Trouble unlocking?" onClose={() => setTrouble(false)}>
          <p>Your master password can't be recovered or reset by anyone. Without it or a backup, this vault stays locked.</p>
          <div className="menu" style={{ padding: 0 }}>
            <button type="button" onClick={() => { setTrouble(false); setRestore(true); }}><TbUpload />Restore from a backup file</button>
            {retired.length > 0 && <button type="button" onClick={() => { setTrouble(false); setShowRetired(true); }}><TbArchive />Recover a replaced vault ({retired.length})</button>}
            <button type="button" className="danger" onClick={() => { setTrouble(false); setReset(true); }}><TbAlertTriangle />Reset this vault</button>
          </div>
        </Dialog>
      )}
      {reset && (
        <TypedConfirm
          title="Reset this vault?"
          message="This erases the vault on this device and starts over with a new master password."
          word="RESET" action="Reset vault" onClose={() => setReset(false)}
          onConfirm={() => session.reset(keepCopy)}
        >
          <label className="row" style={{ margin: "0 0 14px", fontSize: 14 }}>
            <input type="checkbox" checked={keepCopy} onChange={e => setKeepCopy(e.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--accent-fill)" }} />
            <span>Keep an encrypted copy for 30 days in case this was a mistake (you'd still need its password)</span>
          </label>
        </TypedConfirm>
      )}
    </div>
  );
}

export function RetiredWhen({ r }: { r: Retired }) { return <>{r.reason}, {dateTime(r.at)}</>; }
