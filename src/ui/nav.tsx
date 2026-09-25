// Page stack synced with browser history, so Android's back button closes the top page
// instead of leaving the app. A page can register a guard (unsaved changes).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ItemType } from "../core/model";

export type Page =
  | { kind: "item"; id: string }
  | { kind: "edit"; id: string | null; type?: ItemType; category?: string }
  | { kind: "viewer"; itemId: string; attId: string }
  | { kind: "import" }
  | { kind: "backup" }
  | { kind: "restore" }
  | { kind: "history" }
  | { kind: "retired" }
  | { kind: "legacy" }
  | { kind: "trash" }
  | { kind: "categories" }
  | { kind: "password" }
  | { kind: "about" };

export interface Nav {
  stack: Page[];
  top: Page | null;
  push(p: Page): void;
  back(): void;
  replace(p: Page): void;
  /** Return false from the guard to keep the page (e.g. to ask about unsaved changes). */
  setGuard(g: (() => boolean) | null): void;
  forceBack(): void;
}

const Ctx = createContext<Nav | null>(null);
export const useNav = () => { const n = useContext(Ctx); if (!n) throw new Error("no nav"); return n; };

export function NavProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Page[]>([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const guard = useRef<(() => boolean) | null>(null);
  const skipGuard = useRef(false);

  useEffect(() => {
    history.replaceState({ vaultDepth: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      const depth = typeof e.state?.vaultDepth === "number" ? e.state.vaultDepth : 0;
      const cur = stackRef.current.length;
      if (depth >= cur) return;
      if (!skipGuard.current && guard.current && !guard.current()) {
        history.pushState({ vaultDepth: cur }, ""); // stay; the page shows its own prompt
        return;
      }
      skipGuard.current = false;
      guard.current = null;
      const next = stackRef.current.slice(0, depth);
      stackRef.current = next;
      setStack(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const push = useCallback((p: Page) => {
    guard.current = null;
    const next = [...stackRef.current, p];
    stackRef.current = next;
    history.pushState({ vaultDepth: next.length }, "");
    setStack(next);
  }, []);
  const back = useCallback(() => { if (stackRef.current.length) history.back(); }, []);
  const forceBack = useCallback(() => { skipGuard.current = true; if (stackRef.current.length) history.back(); }, []);
  const replace = useCallback((p: Page) => {
    guard.current = null;
    const s = stackRef.current;
    if (!s.length) { push(p); return; }
    const next = [...s.slice(0, -1), p];
    stackRef.current = next;
    setStack(next);
  }, [push]);
  const setGuard = useCallback((g: (() => boolean) | null) => { guard.current = g; }, []);

  const api = useMemo<Nav>(() => ({ stack, top: stack[stack.length - 1] ?? null, push, back, replace, setGuard, forceBack }), [stack, push, back, replace, setGuard, forceBack]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && stackRef.current.length && !document.querySelector(".scrim")) back(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [back]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
