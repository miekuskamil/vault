import { useEffect, useMemo, useRef, useState } from "react";
import {
  TbAlertTriangle, TbArrowsSort, TbCheck, TbCloudUpload, TbCopy, TbFileSpreadsheet, TbFolderSymlink, TbHome, TbLock, TbPlus,
  TbSearch, TbSettings, TbShieldCheck, TbStar, TbTrash, TbUpload, TbX, TbArchive,
} from "react-icons/tb";
import { categoriesOf, liveItems, moveItems, queryItems, setFavorites, sortItems, trashItems, restoreItems, type Item, type SortMode } from "../core/model";
import { session } from "../core/session";
import { toasts } from "../core/toasts";
import { Avatar, Banner, Button, Check, Dialog, Empty, FavStar, IconButton, TextInput, ToastHost } from "./components";
import { NavProvider, useNav, type Page } from "./nav";
import { ago, catClass, setCategoryOrder, useSession } from "./util";
import { quickCopy, subtitle } from "./itemText";
import { ItemView } from "./screens/ItemView";
import { ItemEdit } from "./screens/ItemEdit";
import { Viewer } from "./screens/Viewer";
import { HealthScreen } from "./screens/Health";
import { SettingsScreen, BackupPage, HistoryPage, TrashPage, CategoriesPage, PasswordPage, AboutPage } from "./screens/Settings";
import { ImportPage } from "./screens/Import";
import { RestoreFlow } from "./screens/Restore";
import { RetiredPage } from "./screens/RetiredPage";

type Tab = "vault" | "favorites" | "health" | "settings";

export function Shell() {
  return <NavProvider><ShellInner /></NavProvider>;
}

const SORTS: { id: SortMode; label: string }[] = [
  { id: "category", label: "By category" },
  { id: "az", label: "Name A–Z" },
  { id: "recent", label: "Recently used" },
  { id: "updated", label: "Recently changed" },
];

function ShellInner() {
  const s = useSession();
  const nav = useNav();
  const vault = s.vault!;
  const [tab, setTab] = useState<Tab>("vault");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortOpen, setSortOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [backupHidden, setBackupHidden] = useState(false);

  const cats = useMemo(() => categoriesOf(vault), [vault]);
  setCategoryOrder(vault.categoryOrder); // before any child picks a category colour this render
  useEffect(() => { if (category && !cats.some(c => c.name === category)) setCategory(null); }, [cats, category]);

  const items = useMemo(() => {
    const q = queryItems(vault, { text: query, category: tab === "vault" ? category : null, favoritesOnly: tab === "favorites" });
    return sortItems(q, vault.settings.sort, vault.categoryOrder);
  }, [vault, query, category, tab]);

  const exitSelect = () => { setSelecting(false); setSelected(new Set()); };
  useEffect(() => { exitSelect(); }, [tab]);

  const toggle = (id: string) => setSelected(sel => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const startSelect = (id?: string) => { setSelecting(true); setSelected(id ? new Set([id]) : new Set()); if (navigator.vibrate) navigator.vibrate(12); };

  const bulkDelete = async () => {
    const ids = [...selected];
    exitSelect();
    try {
      await session.commit(v => trashItems(v, ids), { snapshot: `Before deleting ${ids.length} items` });
      toasts.show(`Moved ${ids.length} item${ids.length === 1 ? "" : "s"} to trash`, { action: { label: "Undo", run: () => void session.commit(v => restoreItems(v, ids)) } });
    } catch (e) { toasts.error((e as Error).message); }
  };
  const bulkFavorite = async () => {
    const ids = [...selected];
    const allFav = ids.every(id => vault.items.find(i => i.id === id)?.favorite);
    exitSelect();
    await session.commit(v => setFavorites(v, ids, !allFav)).catch(e => toasts.error((e as Error).message));
    toasts.show(allFav ? "Removed from favorites" : "Added to favorites");
  };

  const pageOpen = nav.stack.length > 0;
  const total = liveItems(vault).length;
  const needsBackup = total >= 3 && !backupHidden && (!vault.settings.lastBackupAt || Date.now() - vault.settings.lastBackupAt > 14 * 86_400_000);
  const grouped = vault.settings.sort === "category" && !category && !query && tab === "vault";

  return (
    <>
      <div className="app" aria-hidden={pageOpen || undefined} inert={pageOpen || undefined}>
        {(tab === "vault" || tab === "favorites") && (
          <>
            <header className="topbar">
              {selecting ? (
                <div className="topbar-row">
                  <IconButton label="Cancel selection" onClick={exitSelect}><TbX /></IconButton>
                  <h1 style={{ fontSize: 19 }}>{selected.size} selected</h1>
                  <Button variant="ghost" small onClick={() => setSelected(new Set(items.map(i => i.id)))}>Select all</Button>
                </div>
              ) : (
                <div className="topbar-row">
                  <h1>{tab === "vault" ? "Vault" : "Favorites"}</h1>
                  <IconButton label="Lock now" className="accent" onClick={() => session.lockNow()}><TbLock /></IconButton>
                </div>
              )}
              <div className="search">
                <TextInput aria-label="Search" placeholder={tab === "vault" ? (total ? `Search ${total} item${total === 1 ? "" : "s"}` : "Search") : "Search favorites"} value={query} onChange={e => setQuery(e.target.value)} type="search" enterKeyHint="search"
                  left={<TbSearch />} right={query ? <IconButton small label="Clear search" onClick={() => setQuery("")}><TbX /></IconButton> : undefined} />
              </div>
            </header>
            {tab === "vault" && cats.length > 0 && (
              <nav className="chips" aria-label="Categories">
                <button type="button" className={`chip ${!category ? "on" : ""}`} aria-pressed={!category} onClick={() => setCategory(null)}>All <span className="count">{total}</span></button>
                {cats.map(c => (
                  <button key={c.name} type="button" className={`chip ${catClass(c.name)} ${category === c.name ? "on" : ""}`} aria-pressed={category === c.name} onClick={() => setCategory(category === c.name ? null : c.name)}>
                    <span className="dot" />{c.name} <span className="count">{c.count}</span>
                  </button>
                ))}
              </nav>
            )}
            <main className="content">
              <SaveBanner />
              {tab === "vault" && s.legacyExtra && !selecting && (
                <Banner tone="info" icon={<TbArchive />} actions={<><Button small variant="primary" onClick={() => nav.push({ kind: "legacy" })}>Bring its items in</Button><Button small variant="ghost" onClick={() => session.dismissLegacy()}>Dismiss</Button></>}>
                  A vault from the old version of this app is still on this device.
                </Banner>
              )}
              {tab === "vault" && needsBackup && !selecting && (
                <Banner tone="warn" icon={<TbCloudUpload />} actions={<><Button small variant="primary" onClick={() => nav.push({ kind: "backup" })}>Back up now</Button><Button small variant="ghost" onClick={() => setBackupHidden(true)}>Later</Button></>}>
                  {vault.settings.lastBackupAt ? `Last backup ${ago(vault.settings.lastBackupAt)}.` : "You haven't backed up yet."} If this phone is lost or the browser clears its data, a backup file is the only way back.
                </Banner>
              )}
              {total === 0 && tab === "vault" ? (
                <Empty icon={<TbShieldCheck />} title="Your vault is empty" actions={<>
                  <Button variant="primary" icon={<TbPlus />} onClick={() => nav.push({ kind: "edit", id: null })}>Add an item</Button>
                  <Button icon={<TbFileSpreadsheet />} onClick={() => nav.push({ kind: "import" })}>Import a spreadsheet</Button>
                  <Button icon={<TbUpload />} onClick={() => nav.push({ kind: "restore" })}>Restore a backup</Button>
                </>}>Add logins, bank details, cards and notes. Everything is encrypted on this device.</Empty>
              ) : items.length === 0 ? (
                tab === "favorites" && !query
                  ? <Empty icon={<TbStar />} title="No favorites yet">Tap the star on an item to keep it here.</Empty>
                  : <Empty icon={<TbSearch />} title="No matches">Nothing matches “{query}”{category ? ` in ${category}` : ""}.</Empty>
              ) : (
                <>
                  <div className="list-head">
                    <span className="title">{items.length} item{items.length === 1 ? "" : "s"}{category ? ` in ${category}` : ""}</span>
                    {!selecting && <Button variant="ghost" small onClick={() => startSelect()}>Select</Button>}
                    <IconButton small label="Sort" onClick={() => setSortOpen(true)}><TbArrowsSort /></IconButton>
                  </div>
                  <ItemList items={items} grouped={grouped} selecting={selecting} selected={selected} onToggle={toggle} onLongPress={startSelect}
                    onOpen={it => nav.push({ kind: "item", id: it.id })} />
                </>
              )}
            </main>
          </>
        )}
        {tab === "health" && <HealthScreen />}
        {tab === "settings" && <SettingsScreen />}
      </div>

      {selecting ? (
        <div className="bulkbar" aria-hidden={pageOpen || undefined}>
          <div className="nav-inner">
            <Button icon={<TbStar />} disabled={!selected.size} onClick={() => void bulkFavorite()}>Favorite</Button>
            <Button icon={<TbFolderSymlink />} disabled={!selected.size} onClick={() => setMoveOpen(true)}>Move</Button>
            <Button variant="danger-outline" icon={<TbTrash />} disabled={!selected.size} onClick={() => void bulkDelete()}>Delete</Button>
          </div>
        </div>
      ) : (
        <nav className="nav" aria-label="Main" aria-hidden={pageOpen || undefined}>
          <div className="nav-inner">
            <NavBtn cls="tab-home" on={tab === "vault"} label="Vault" icon={<TbHome />} onClick={() => { if (tab === "vault") { setCategory(null); setQuery(""); window.scrollTo({ top: 0 }); } setTab("vault"); }} />
            <NavBtn cls="tab-fav" on={tab === "favorites"} label="Favorites" icon={<TbStar />} onClick={() => setTab("favorites")} />
            <button type="button" className="add" aria-label="Add item" onClick={() => nav.push({ kind: "edit", id: null, category: tab === "vault" ? category ?? undefined : undefined })}><span className="fab"><TbPlus /></span></button>
            <NavBtn cls="tab-health" on={tab === "health"} label="Health" icon={<TbShieldCheck />} onClick={() => setTab("health")} />
            <NavBtn cls="tab-settings" on={tab === "settings"} label="Settings" icon={<TbSettings />} onClick={() => setTab("settings")} />
          </div>
        </nav>
      )}

      {nav.stack.map((p, i) => <PageView key={i + ":" + p.kind} page={p} />)}

      {sortOpen && (
        <Dialog title="Sort items" onClose={() => setSortOpen(false)}>
          <div className="menu" style={{ padding: 0 }}>
            {SORTS.map(o => (
              <button key={o.id} type="button" className={vault.settings.sort === o.id ? "on" : ""} onClick={() => { setSortOpen(false); void session.updateSettings({ sort: o.id }); }}>
                {vault.settings.sort === o.id ? <TbCheck /> : <span style={{ width: 20 }} />}{o.label}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {moveOpen && <MoveDialog count={selected.size} cats={cats.map(c => c.name)} onClose={() => setMoveOpen(false)} onMove={async to => {
        const ids = [...selected]; setMoveOpen(false); exitSelect();
        await session.commit(v => moveItems(v, ids, to)).catch(e => toasts.error((e as Error).message));
        toasts.show(`Moved to ${to}`);
      }} />}
      <ToastHost onPage={pageOpen || selecting} />
    </>
  );
}

function NavBtn({ on, label, icon, onClick, cls }: { on: boolean; label: string; icon: React.ReactNode; onClick: () => void; cls: string }) {
  return <button type="button" className={`${cls} ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span></button>;
}

export function SaveBanner() {
  const s = useSession();
  const nav = useNav();
  if (s.save.state !== "error") return null;
  return (
    <Banner tone="danger" icon={<TbAlertTriangle />} actions={<>
      <Button small variant="primary" onClick={() => session.retrySave().then(() => toasts.show("Saved")).catch(() => undefined)}>Try again</Button>
      <Button small onClick={() => nav.push({ kind: "backup" })}>Back up now</Button>
    </>}>
      Your last change wasn't saved. {s.save.error} Until it saves, it exists only in this open app, so export a backup before closing.
    </Banner>
  );
}

function ItemList({ items, grouped, selecting, selected, onToggle, onLongPress, onOpen }: { items: Item[]; grouped: boolean; selecting: boolean; selected: Set<string>; onToggle: (id: string) => void; onLongPress: (id: string) => void; onOpen: (it: Item) => void }) {
  if (!grouped) return <div className="list">{items.map(it => <Row key={it.id} it={it} selecting={selecting} selected={selected.has(it.id)} onToggle={onToggle} onLongPress={onLongPress} onOpen={onOpen} />)}</div>;
  const groups: { name: string; items: Item[] }[] = [];
  for (const it of items) { const g = groups[groups.length - 1]; if (g && g.name === it.category) g.items.push(it); else groups.push({ name: it.category, items: [it] }); }
  return (
    <>
      {groups.map(g => (
        <section key={g.name} aria-label={g.name}>
          <div className={`section-title ${catClass(g.name)}`}><span className="dot" />{g.name}<span className="count">{g.items.length}</span></div>
          <div className="list">{g.items.map(it => <Row key={it.id} it={it} selecting={selecting} selected={selected.has(it.id)} onToggle={onToggle} onLongPress={onLongPress} onOpen={onOpen} />)}</div>
        </section>
      ))}
    </>
  );
}

function Row({ it, selecting, selected, onToggle, onLongPress, onOpen }: { it: Item; selecting: boolean; selected: boolean; onToggle: (id: string) => void; onLongPress: (id: string) => void; onOpen: (it: Item) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const copy = quickCopy(it);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  return (
    <div className={`item-row ${selected ? "selected" : ""}`}>
      <button type="button" className="main"
        aria-label={`${it.title}${selecting ? (selected ? ", selected" : ", not selected") : ""}`}
        onPointerDown={e => { fired.current = false; start.current = { x: e.clientX, y: e.clientY }; clear(); if (!selecting) timer.current = setTimeout(() => { fired.current = true; onLongPress(it.id); }, 480); }}
        onPointerMove={e => { if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear(); }}
        onPointerUp={clear} onPointerCancel={clear} onPointerLeave={clear}
        onContextMenu={e => { e.preventDefault(); if (!selecting && !fired.current) { fired.current = true; clear(); onLongPress(it.id); } }}
        onClick={() => { if (fired.current) { fired.current = false; return; } if (selecting) onToggle(it.id); else onOpen(it); }}>
        {selecting ? <Check on={selected} /> : <Avatar item={it} />}
        <span className="grow">
          <span className="row" style={{ gap: 6 }}><span className="t ellipsis">{it.title}</span>{it.favorite && <FavStar />}</span>
          <span className="s ellipsis" style={{ display: "block" }}>{subtitle(it)}</span>
        </span>
      </button>
      {!selecting && copy && (
        <IconButton label={`Copy ${copy.label.toLowerCase()} for ${it.title}`} onClick={() => void session.copy(copy.value, copy.label, it.id)}><TbCopy /></IconButton>
      )}
    </div>
  );
}

function MoveDialog({ count, cats, onClose, onMove }: { count: number; cats: string[]; onClose: () => void; onMove: (to: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog title={`Move ${count} item${count === 1 ? "" : "s"}`} onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => onMove(name.trim())}>Move</Button></>}>
      <div className="chips" style={{ padding: "0 0 12px", flexWrap: "wrap", maskImage: "none", WebkitMaskImage: "none" }}>
        {cats.map(c => <button key={c} type="button" className={`chip ${catClass(c)} ${name === c ? "on" : ""}`} onClick={() => setName(c)}><span className="dot" />{c}</button>)}
      </div>
      <TextInput label="Or a new category" value={name} onChange={e => setName(e.target.value)} placeholder="Category name" />
    </Dialog>
  );
}

function PageView({ page }: { page: Page }) {
  const nav = useNav();
  switch (page.kind) {
    case "item": return <ItemView id={page.id} />;
    case "edit": return <ItemEdit id={page.id} type={page.type} category={page.category} />;
    case "viewer": return <Viewer itemId={page.itemId} attId={page.attId} />;
    case "import": return <ImportPage />;
    case "backup": return <BackupPage />;
    case "restore": return <RestoreFlow mode="unlocked" onClose={nav.back} />;
    case "legacy": return <RestoreFlow mode="legacy" onClose={nav.back} />;
    case "history": return <HistoryPage />;
    case "retired": return <RetiredPage />;
    case "trash": return <TrashPage />;
    case "categories": return <CategoriesPage />;
    case "password": return <PasswordPage />;
    case "about": return <AboutPage />;
  }
}
