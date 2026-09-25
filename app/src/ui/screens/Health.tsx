import { useMemo, useState } from "react";
import { TbAlertTriangle, TbClockHour4, TbCopy, TbShieldCheck } from "react-icons/tb";
import { analyzeHealth } from "../../core/health";
import type { Item } from "../../core/model";
import { estimate } from "../../core/strength";
import { Avatar, Empty } from "../components";
import { useNav } from "../nav";
import { ago, useSession } from "../util";
import { SaveBanner } from "../Shell";

export function HealthScreen() {
  const s = useSession();
  const nav = useNav();
  const report = useMemo(() => analyzeHealth(s.vault!), [s.vault]);
  const [open, setOpen] = useState<"weak" | "reused" | "old" | null>(null);
  const r = 44, c = 2 * Math.PI * r;
  const color = report.score >= 80 ? "var(--ok)" : report.score >= 50 ? "var(--warn)" : "var(--danger)";

  const row = (it: Item, note: string) => (
    <div className="item-row" key={it.id}>
      <button type="button" className="main" onClick={() => nav.push({ kind: "item", id: it.id })}>
        <Avatar item={it} />
        <span className="grow"><span className="t ellipsis" style={{ display: "block" }}>{it.title}</span><span className="s ellipsis" style={{ display: "block" }}>{note}</span></span>
      </button>
    </div>
  );

  return (
    <>
      <header className="topbar"><div className="topbar-row"><h1>Password health</h1></div></header>
      <main className="content">
        <SaveBanner />
        {report.checked === 0 ? (
          <Empty icon={<TbShieldCheck />} title="Nothing to check yet">Logins and bank items with passwords show up here.</Empty>
        ) : (
          <>
            <div className="score">
              <svg viewBox="0 0 100 100" role="img" aria-label={`Health score ${report.score} out of 100`}>
                <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="9" />
                <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - report.score / 100)} transform="rotate(-90 50 50)" />
                <text x="50" y="57" textAnchor="middle" fontSize="24" fontWeight="750" fill="var(--text)">{report.score}</text>
              </svg>
              <div>
                <div className="big">{report.flagged.size === 0 ? "All clear" : `${report.flagged.size} to fix`}</div>
                <div className="muted">{report.checked} passwords checked on this device. Nothing is sent anywhere.</div>
              </div>
            </div>

            <HealthCard id="weak" open={open} setOpen={setOpen} icon={<TbAlertTriangle />} tone="danger" n={report.weak.length} title="Weak passwords" sub="Easy to guess. Change them first." />
            {open === "weak" && <div className="hlist">{report.weak.map(it => row(it, estimate(it.password, [it.title, it.username]).warning || "Too short or too simple"))}</div>}

            <HealthCard id="reused" open={open} setOpen={setOpen} icon={<TbCopy />} tone="warn" n={report.reused.reduce((a, g) => a + g.length, 0)} title="Reused passwords" sub={report.reused.length ? `${report.reused.length} password${report.reused.length === 1 ? " is" : "s are"} used on more than one account` : "Each account has its own password"} />
            {open === "reused" && <div className="hlist">{report.reused.map((g, i) => <div key={i}><div className="group-label">Same password on {g.length} accounts</div>{g.map(it => row(it, it.username || it.category))}</div>)}</div>}

            <HealthCard id="old" open={open} setOpen={setOpen} icon={<TbClockHour4 />} tone="info" n={report.old.length} title="Old passwords" sub="Not changed in over a year" />
            {open === "old" && <div className="hlist">{report.old.map(it => row(it, `Changed ${ago(it.passwordChangedAt)}`))}</div>}
            <p className="faint" style={{ padding: "4px 4px 0" }}>Imported passwords have no known age until you change them here.</p>
          </>
        )}
      </main>
    </>
  );
}

function HealthCard({ id, open, setOpen, icon, tone, n, title, sub }: { id: "weak" | "reused" | "old"; open: string | null; setOpen: (v: "weak" | "reused" | "old" | null) => void; icon: React.ReactNode; tone: "danger" | "warn" | "info"; n: number; title: string; sub: string }) {
  const isOpen = open === id;
  const colors = { danger: ["var(--danger-soft)", "var(--danger)"], warn: ["var(--warn-soft)", "var(--warn)"], info: ["var(--accent-soft)", "var(--accent)"] }[tone];
  return (
    <button type="button" className={`hcard ${isOpen ? "open" : ""}`} aria-expanded={isOpen} disabled={n === 0} onClick={() => setOpen(isOpen ? null : id)} style={n === 0 ? { opacity: 0.75, cursor: "default" } : undefined}>
      <span className="ic" style={{ width: 40, height: 40, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: n ? colors[0] : "var(--ok-soft)", color: n ? colors[1] : "var(--ok)", flex: "none" }}>{n ? icon : <TbShieldCheck />}</span>
      <span className="grow"><div style={{ fontWeight: 650 }}>{title}</div><div className="faint">{sub}</div></span>
      <span className="n" style={{ color: n ? colors[1] : "var(--ok)" }}>{n}</span>
    </button>
  );
}
