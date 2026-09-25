import { useEffect, useState } from "react";
import { session } from "../../core/session";
import type { Retired } from "../../core/storage";
import { useNav } from "../nav";
import { RetiredList } from "./Retired";

export function RetiredPage() {
  const nav = useNav();
  const [items, setItems] = useState<Retired[]>([]);
  useEffect(() => { void session.listRetired().then(setItems); }, []);
  return <RetiredList mode="unlocked" items={items} onClose={nav.back} />;
}
