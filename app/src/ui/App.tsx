import { LockScreen, SetupScreen } from "./screens/Auth";
import { Shell } from "./Shell";
import { ToastHost } from "./components";
import { useSession } from "./util";

export function App() {
  const s = useSession();
  if (s.status === "loading") return <div className="lock" aria-busy="true" />;
  if (s.status === "setup") return <><SetupScreen /><ToastHost onPage /></>;
  if (s.status === "locked") return <><LockScreen /><ToastHost onPage /></>;
  return <Shell />;
}
