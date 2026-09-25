import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { TbArrowLeft, TbBuildingBank, TbCheck, TbCreditCard, TbEye, TbEyeOff, TbId, TbKey, TbNotes, TbStarFilled } from "react-icons/tb";
import type { Item, ItemType } from "../core/model";
import { estimate } from "../core/strength";
import { catClass, initials, useToast } from "./util";
import { toasts } from "../core/toasts";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-outline"; block?: boolean; small?: boolean; loading?: boolean; icon?: ReactNode };

export function Button({ variant = "secondary", block, small, loading, icon, className = "", children, disabled, ...rest }: BtnProps) {
  const cls = ["btn", variant !== "secondary" ? variant : "", block ? "block" : "", small ? "small" : "", loading ? "loading" : "", className].filter(Boolean).join(" ");
  return <button type="button" className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>{icon}{children}</button>;
}

export function IconButton({ label, children, className = "", small, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; small?: boolean }) {
  return <button type="button" className={`icon-btn ${small ? "small" : ""} ${className}`} aria-label={label} title={label} {...rest}>{children}</button>;
}

export function Field({ label, hint, error, children, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="error-text" role="alert">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

type TextProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: ReactNode; right?: ReactNode; left?: ReactNode; inputRef?: React.Ref<HTMLInputElement> };
export function TextInput({ label, hint, error, right, left, inputRef, id, className = "", ...rest }: TextProps) {
  const auto = useId();
  const iid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={iid}>
      <div className={`input ${error ? "error" : ""} ${className}`}>
        {left}
        <input id={iid} ref={inputRef} autoComplete="off" autoCapitalize="off" spellCheck={false} {...rest} />
        {right}
      </div>
    </Field>
  );
}

export function PasswordInput({ reveal: initial = false, ...props }: TextProps & { reveal?: boolean }) {
  const [show, setShow] = useState(initial);
  return (
    <TextInput
      {...props}
      type={show ? "text" : "password"}
      className={`${props.className ?? ""} ${show ? "mono" : ""}`}
      right={<>{props.right}<IconButton small label={show ? "Hide" : "Show"} onClick={() => setShow(s => !s)}>{show ? <TbEyeOff /> : <TbEye />}</IconButton></>}
    />
  );
}

export function TextArea({ label, hint, value, onChange, placeholder, rows = 4, id }: { label?: ReactNode; hint?: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; id?: string }) {
  const auto = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = ref.current; if (t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 480) + "px"; } }, [value]);
  return (
    <Field label={label} hint={hint} htmlFor={id ?? auto}>
      <div className="input"><textarea id={id ?? auto} ref={ref} rows={rows} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></div>
    </Field>
  );
}

export function Select<T extends string | number>({ label, value, options, onChange, id }: { label?: ReactNode; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; id?: string }) {
  const auto = useId();
  return (
    <Field label={label} htmlFor={id ?? auto}>
      <div className="input select">
        <select id={id ?? auto} value={String(value)} onChange={e => { const o = options.find(o => String(o.value) === e.target.value); if (o) onChange(o.value); }}>
          {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      </div>
    </Field>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <span className="switch"><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span /></span>;
}

export function Check({ on }: { on: boolean }) {
  return <span className={`check ${on ? "on" : ""}`} aria-hidden="true">{on && <TbCheck />}</span>;
}

export const TYPE_ICON: Record<ItemType, ReactNode> = {
  login: <TbKey />, bank: <TbBuildingBank />, card: <TbCreditCard />, identity: <TbId />, note: <TbNotes />,
};

export function Avatar({ item, large }: { item: Pick<Item, "title" | "category" | "type">; large?: boolean }) {
  const content = item.type === "login" ? initials(item.title) : TYPE_ICON[item.type];
  return <span className={`avatar ${large ? "lg" : ""} ${catClass(item.category)}`} aria-hidden="true">{content}</span>;
}

export function FavStar() { return <TbStarFilled className="star" aria-label="Favorite" />; }

export function StrengthBar({ password, userInputs = [] }: { password: string; userInputs?: string[] }) {
  if (!password) return null;
  const s = estimate(password, userInputs);
  return (
    <div>
      <div className={`strength s${s.score}`} aria-hidden="true"><i style={{ width: `${Math.max(8, Math.min(100, (s.bits / 80) * 100))}%` }} /></div>
      <div className="hint"><span className={s.score <= 1 ? "danger-text" : s.score === 2 ? "warn-text" : "ok-text"}>{s.label}</span>, about {s.bits} bits{s.warning ? `. ${s.warning}` : ""}</div>
    </div>
  );
}

/** Full-screen page frame with its own top bar and optional sticky actions. */
export function Page({ title, onBack, actions, footer, children, label }: { title?: ReactNode; onBack: () => void; actions?: ReactNode; footer?: ReactNode; children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="page" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} ref={ref} tabIndex={-1}>
      <div className="page-inner">
        <div className="page-bar">
          <IconButton label="Back" onClick={onBack}><TbArrowLeft /></IconButton>
          <h2>{title}</h2>
          {actions}
        </div>
        <div className={`page-body ${footer ? "with-actions" : ""}`}>{children}</div>
        {footer && <div className="page-actions"><div className="inner">{footer}</div></div>}
      </div>
    </div>
  );
}

export function Dialog({ title, children, onClose, actions, label }: { title?: ReactNode; children?: ReactNode; onClose: () => void; actions?: ReactNode; label?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : "Dialog")}>
        {title && <h2>{title}</h2>}
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Destructive confirmation that needs a typed word. */
export function TypedConfirm({ title, message, word, action, onConfirm, onClose, children }: { title: string; message: ReactNode; word: string; action: string; onConfirm: () => Promise<void> | void; onClose: () => void; children?: ReactNode }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = text.trim().toUpperCase() === word;
  return (
    <Dialog title={title} onClose={onClose} actions={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="danger" disabled={!ok} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { toasts.error((e as Error).message); setBusy(false); } }}>{action}</Button>
    </>}>
      <p>{message}</p>
      {children}
      <TextInput label={<>Type <b>{word}</b> to confirm</>} value={text} onChange={e => setText(e.target.value)} autoFocus />
    </Dialog>
  );
}

export function Banner({ tone, icon, children, actions }: { tone: "warn" | "danger" | "info"; icon: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "danger" ? "alert" : "status"}>{icon}<div className="grow">{children}{actions && <div className="actions">{actions}</div>}</div></div>;
}

export function Empty({ icon, title, children, actions }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return <div className="empty"><div className="ico">{icon}</div><h2>{title}</h2>{children && <p>{children}</p>}{actions && <div className="stack">{actions}</div>}</div>;
}

export function ToastHost({ onPage }: { onPage?: boolean }) {
  const t = useToast();
  if (!t) return null;
  return (
    <div className={`toast ${t.tone === "error" ? "error" : ""} ${onPage ? "on-page" : ""}`} role={t.tone === "error" ? "alert" : "status"} aria-live="polite">
      <span className="grow">{t.text}</span>
      {t.action && <button type="button" onClick={() => { t.action!.run(); toasts.dismiss(); }}>{t.action.label}</button>}
    </div>
  );
}

export function Ring({ fraction, low }: { fraction: number; low?: boolean }) {
  const r = 12, c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${low ? "low" : ""}`} viewBox="0 0 30 30" aria-hidden="true">
      <circle className="bg" cx="15" cy="15" r={r} />
      <circle className="fg" cx="15" cy="15" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
    </svg>
  );
}
