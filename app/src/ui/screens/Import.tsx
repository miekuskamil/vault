import { useEffect, useMemo, useRef, useState } from "react";
import { TbAlertTriangle, TbArrowBackUp, TbFileSpreadsheet, TbLock, TbPhoto } from "react-icons/tb";
import { parseDelimited } from "../../core/importers/csv";
import { readXlsx, SpreadsheetError, isCfb, type Sheet, type SheetPicture } from "../../core/importers/xlsx";
import { decryptXlsx, describeContainer, OfficeCryptoError } from "../../core/importers/officecrypto";
import { planSheet, planToImports, TARGETS, withHeaderRow, type PlannedItem, type SheetPlan, type Target } from "../../core/importers/mapping";
import { ITEM_TYPES, liveItems, purgeItems, type ItemType } from "../../core/model";
import { session } from "../../core/session";
import { toasts } from "../../core/toasts";
import { Banner, Button, Page, PasswordInput, Select, Switch, TextInput } from "../components";
import { useNav } from "../nav";
import { pickFiles, useSession } from "../util";

type Step = "pick" | "password" | "map" | "saving" | "done";

const sig = (d: { title?: unknown; username?: unknown }) => String(d.title ?? "").trim().toLowerCase() + "\u0000" + String(d.username ?? "").trim().toLowerCase();
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function ImportPage() {
  const s = useSession();
  const nav = useNav();
  const [step, setStep] = useState<Step>("pick");
  const [plans, setPlans] = useState<SheetPlan[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<React.ReactNode>(null);
  const [reading, setReading] = useState(false);
  const [skipDup, setSkipDup] = useState(true);
  const [result, setResult] = useState<{ added: string[]; skipped: number; sheets: number; pictures: number; badPictures: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const [locked, setLocked] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [filePw, setFilePw] = useState("");
  const [pwError, setPwError] = useState("");
  const [progress, setProgress] = useState(0);
  const [wasProtected, setWasProtected] = useState(false);
  const opening = useRef<AbortController | null>(null);
  useEffect(() => () => opening.current?.abort(), []);
  const cancelOpen = () => { opening.current?.abort(); opening.current = null; setReading(false); setLocked(null); setFilePw(""); setStep("pick"); };

  const toPlans = (sheets: Sheet[]) => {
    sheets = sheets.filter(sh => sh.rows.length > 1 || (sh.rows.length === 1 && sh.rows[0].length > 0));
    if (!sheets.length) throw new SpreadsheetError("empty", "");
    setPlans(sheets.map(sh => planSheet(sh.name, sh.rows, sh.pictures ?? [])));
    setStep("map");
  };

  const showError = (e: unknown) => {
    if (e instanceof SpreadsheetError && e.code === "empty") setError("There's nothing to import in this file.");
    else if ((e instanceof OfficeCryptoError && e.code === "legacy") || (e instanceof SpreadsheetError && e.code === "encrypted")) setError(<>
      <b>This is an old Excel .xls file.</b> Open it in Excel or a phone spreadsheet app and save it as .xlsx or .csv, then import that.
    </>);
    else setError((e as Error).message || "Couldn't read that file. Save it as .xlsx or .csv and try again.");
  };

  const load = async (file: File) => {
    setError(null); setReading(true); setFileName(file.name); setWasProtected(false);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("That file is too large to import.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isCfb(bytes)) {
        const kind = describeContainer(bytes);
        if (kind === "encrypted") { setLocked(bytes); setFilePw(""); setPwError(""); setStep("password"); setReading(false); return; }
        throw new OfficeCryptoError("legacy", "");
      }
      if (/\.(xlsx|xlsm)$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) toPlans(await readXlsx(bytes));
      else toPlans([{ name: file.name.replace(/\.[^.]+$/, ""), rows: parseDelimited(new TextDecoder().decode(bytes)).rows }]);
    } catch (e) { showError(e); }
    setReading(false);
  };

  const unlockFile = async () => {
    if (!locked || !filePw || reading) return;
    const ctl = new AbortController();
    opening.current = ctl;
    setReading(true); setPwError(""); setProgress(0);
    try {
      const plain = await decryptXlsx(locked, filePw, f => { if (!ctl.signal.aborted) setProgress(f); }, ctl.signal);
      const sheets = await readXlsx(plain);
      if (ctl.signal.aborted) return;
      toPlans(sheets);
      setLocked(null); setFilePw(""); setWasProtected(true);
    } catch (e) {
      if (ctl.signal.aborted) return; // the person chose another file meanwhile
      if (e instanceof OfficeCryptoError && e.code === "password") setPwError("Wrong password for this spreadsheet.");
      else { setLocked(null); setFilePw(""); setStep("pick"); showError(e); }
    } finally {
      if (opening.current === ctl) { opening.current = null; setReading(false); }
    }
  };

  const pick = async () => { const [f] = await pickFiles(".xlsx,.xlsm,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); if (f) void load(f); };

  const existing = useMemo(() => new Set(s.vault ? liveItems(s.vault).map(sig) : []), [s.vault]);
  const planned = useMemo(() => {
    const seen = new Set(skipDup ? existing : []);
    const out: PlannedItem[] = [];
    let skipped = 0;
    for (const p of plans) for (const it of planToImports(p)) {
      const k = sig(it.draft);
      if (skipDup && seen.has(k)) { skipped++; continue; }
      seen.add(k); out.push(it);
    }
    return { out, skipped, pictures: out.reduce((n, it) => n + it.pictures.length, 0) };
  }, [plans, skipDup, existing]);

  const run = async () => {
    setStep("saving"); setProgress(0);
    const before = new Set(s.vault!.items.map(i => i.id));
    try {
      const r = await session.importItems(planned.out.map(p => p.draft), planned.out.map(p => p.pictures), (d, total) => setProgress(total ? d / total : 1));
      const added = session.vault!.items.filter(i => !before.has(i.id)).map(i => i.id);
      setResult({ added, skipped: planned.skipped, sheets: plans.filter(p => p.include).length, pictures: r.pictures, badPictures: r.skipped });
      setStep("done");
    } catch (e) { toasts.error("Import failed: " + (e as Error).message); setStep("map"); }
  };

  const undo = async () => {
    if (!result) return;
    await session.commit(v => purgeItems(v, result.added).vault);
    toasts.show(`Removed the ${result.added.length} imported items`);
    nav.back();
  };

  const setPlan = (i: number, p: SheetPlan) => setPlans(ps => ps.map((x, j) => (j === i ? p : x)));

  return (
    <Page title="Import" onBack={nav.back}
      footer={step === "map" ? <Button variant="primary" disabled={!planned.out.length} onClick={() => void run()}>Import {plural(planned.out.length, "item")}</Button>
        : step === "password" ? <Button variant="primary" loading={reading} disabled={!filePw} onClick={() => void unlockFile()}>Open spreadsheet</Button>
        : step === "done" ? <><Button icon={<TbArrowBackUp />} onClick={() => void undo()}>Undo import</Button><Button variant="primary" onClick={nav.back}>Done</Button></> : undefined}>
      {step === "pick" && (
        <div className="stack">
          <div className={`drop ${drag ? "drag" : ""}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}>
            <TbFileSpreadsheet />
            <p><b>Excel (.xlsx) or CSV</b><br /><span className="faint">Every tab becomes a category and pictures stay with their row. Columns you don't map are kept as fields, so nothing is lost.</span></p>
            <Button variant="primary" loading={reading} onClick={() => void pick()}>Choose file</Button>
          </div>
          {error && <Banner tone="danger" icon={<TbAlertTriangle />}>{error}</Banner>}
          <p className="faint">Password-protected Excel files open here with their password. Also reads password exports from Chrome (Settings, Passwords, Export), Bitwarden, 1Password and Firefox. Everything is read on this phone only.</p>
        </div>
      )}

      {step === "password" && (
        <form className="stack" onSubmit={e => { e.preventDefault(); void unlockFile(); }}>
          <div className="drop solid">
            <TbLock />
            <p><b>{fileName}</b><br /><span className="faint">This spreadsheet has a password. It's opened on this phone only and never saved unprotected.</span></p>
          </div>
          <PasswordInput label="Spreadsheet password" value={filePw} onChange={e => { setFilePw(e.target.value); setPwError(""); }} autoFocus autoComplete="off" error={pwError || undefined} />
          {reading && <div className="progress" role="progressbar" aria-label="Opening spreadsheet" aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${Math.max(4, progress * 100)}%` }} /></div>}
          <Button variant="ghost" onClick={cancelOpen}>{reading ? "Cancel" : "Choose a different file"}</Button>
        </form>
      )}

      {step === "map" && (
        <div className="stack">
          <div className="faint">{fileName}: {plural(plans.length, "sheet")}{planned.pictures ? `, ${plural(planned.pictures, "picture")}` : ""}{planned.skipped ? `, ${plural(planned.skipped, "duplicate")} skipped` : ""}</div>
          <label className="row" style={{ justifyContent: "space-between", background: "var(--surface)", borderRadius: 12, padding: "10px 14px" }}>
            <span>Skip items already in the vault<br /><span className="faint">Same name and username</span></span>
            <Switch checked={skipDup} onChange={setSkipDup} label="Skip duplicates" />
          </label>
          {plans.map((p, i) => <SheetCard key={i} plan={p} onChange={np => setPlan(i, np)} />)}
        </div>
      )}

      {step === "saving" && (
        <div className="stack" style={{ paddingTop: 40, textAlign: "center" }}>
          <p>Encrypting and saving {plural(planned.out.length, "item")}{planned.pictures ? ` and ${plural(planned.pictures, "picture")}` : ""}…</p>
          <div className="progress" role="progressbar" aria-label="Import progress" aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${Math.max(6, progress * 100)}%` }} /></div>
        </div>
      )}

      {step === "done" && result && (
        <div className="stack">
          <h2 style={{ margin: "8px 0 0" }}>{result.added.length ? "Imported" : "Nothing new to import"}</h2>
          <div className="stats">
            <div><b>{result.added.length}</b><span className="faint">added</span></div>
            {result.pictures > 0 && <div><b>{result.pictures}</b><span className="faint">pictures</span></div>}
            <div><b>{result.skipped}</b><span className="faint">skipped</span></div>
            <div><b>{result.sheets}</b><span className="faint">sheets</span></div>
          </div>
          {result.badPictures > 0 && <Banner tone="warn" icon={<TbPhoto />}>{plural(result.badPictures, "picture")} couldn't be read and {result.badPictures === 1 ? "was" : "were"} left out.</Banner>}
          {wasProtected
            ? <Banner tone="info" icon={<TbLock />}>The spreadsheet is still on your phone, protected by its own password. Delete it if you no longer need it.</Banner>
            : <Banner tone="warn" icon={<TbAlertTriangle />}>Now delete the spreadsheet from your phone. It isn't encrypted.</Banner>}
        </div>
      )}
    </Page>
  );
}

function SheetCard({ plan, onChange }: { plan: SheetPlan; onChange: (p: SheetPlan) => void }) {
  const headers = plan.rows[plan.headerRow] ?? [];
  const items = planToImports({ ...plan, include: true });
  const drafts = items.map(x => x.draft);
  const pics = items.reduce((n, x) => n + x.pictures.length, 0);
  const colOptions = [{ value: -1, label: "None" }, ...headers.map((h, i) => ({ value: i, label: (h || "").trim() || `Column ${i + 1}` }))];
  const setMap = (t: Target, i: number) => onChange({ ...plan, mapping: { ...plan.mapping, [t]: i < 0 ? undefined : i } });
  return (
    <div className="sheet-card">
      <div className="head">
        <span className="grow"><div style={{ fontWeight: 650 }}>{plan.name}</div><div className="faint">{plural(drafts.length, "item")}{pics ? `, ${plural(pics, "picture")}` : ""}{plan.preset ? `, ${plan.preset} format` : ""}</div></span>
        <Switch checked={plan.include} onChange={v => onChange({ ...plan, include: v })} label={`Import ${plan.name}`} />
      </div>
      {plan.include && (
        <div className="body">
          <div className="map-grid">
            <Select label="Item type" value={plan.type} options={ITEM_TYPES.map(t => ({ value: t.id, label: t.label }))} onChange={v => onChange({ ...plan, type: v as ItemType })} />
            <Select label="Headings are in" value={plan.headerRow} options={plan.rows.slice(0, 5).map((r, i) => ({ value: i, label: `Row ${i + 1}: ${(r.find(c => c.trim()) ?? "").slice(0, 18)}` }))} onChange={v => onChange(withHeaderRow(plan, v))} />
          </div>
          {plan.mapping.category == null && <TextInput label="Put these items in category" value={plan.category} onChange={e => onChange({ ...plan, category: e.target.value })} />}
          <div className="faint" style={{ fontSize: 13 }}>Which column holds what</div>
          <div className="map-grid">
            {TARGETS.map(t => <Select key={t.id} label={t.label} value={plan.mapping[t.id] ?? -1} options={colOptions} onChange={v => setMap(t.id, v)} />)}
          </div>
          <label className="row" style={{ justifyContent: "space-between" }}>
            <span>Keep other columns as fields</span>
            <Switch checked={plan.keepExtra} onChange={v => onChange({ ...plan, keepExtra: v })} label="Keep other columns as fields" />
          </label>
          {drafts.length > 0 && (
            <div className="preview" aria-label="Preview">
              {items.slice(0, 3).map(({ draft: d, pictures }, i) => (
                <div className="pr" key={i}>
                  <span className="grow ellipsis"><b>{d.title}</b>{d.username ? <span className="faint"> {d.username}</span> : null}</span>
                  <span className="faint nowrap">{d.password ? "•".repeat(Math.min(8, d.password.length)) : ""}{d.fields?.length ? ` +${plural(d.fields.length, "field")}` : ""}</span>
                  {pictures.length > 0 && <PicCount pictures={pictures} />}
                </div>
              ))}
              {drafts.length > 3 && <div className="pr faint">and {drafts.length - 3} more</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PicCount({ pictures }: { pictures: SheetPicture[] }) {
  return <span className="pic-count" aria-label={plural(pictures.length, "picture")}><TbPhoto />{pictures.length}</span>;
}
