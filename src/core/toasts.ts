// Tiny toast store (one visible at a time; the newest wins).

export interface Toast { id: number; text: string; tone: "info" | "error"; action?: { label: string; run: () => void }; ms: number }

type Listener = () => void;
let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit() { for (const l of listeners) l(); }

export const toasts = {
  subscribe(l: Listener) { listeners.add(l); return () => listeners.delete(l); },
  get(): Toast | null { return current; },
  show(text: string, opts: { tone?: Toast["tone"]; action?: Toast["action"]; ms?: number } = {}) {
    const t: Toast = { id: ++seq, text, tone: opts.tone ?? "info", action: opts.action, ms: opts.ms ?? (opts.action ? 6000 : 2600) };
    current = t;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { if (current?.id === t.id) { current = null; emit(); } }, t.ms);
    emit();
  },
  dismiss() { current = null; if (timer) clearTimeout(timer); emit(); },
  error(text: string) { toasts.show(text, { tone: "error", ms: 5000 }); },
};
