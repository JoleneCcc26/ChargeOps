import { useState } from "react";
import { ShieldCheck, Zap } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { cn, inputShell } from "../lib/cn";

/**
 * The five roles, in the order they make sense to try.
 *
 * Listed here rather than only in server/auth.js because a demo nobody can log
 * into is not a demo. The server remains the authority on what each one may
 * actually do.
 */
const DEMO_ACCOUNTS = [
  { username: "ops", description: "Operations manager — the whole network, and the dispatch board" },
  { username: "tech", description: "Field technician — only the jobs assigned to them" },
  { username: "finance", description: "Finance — the approval inbox and reconciliation" },
  { username: "host", description: "Site host — a landlord, not an operator; their own sites only" },
  { username: "viewer", description: "Read-only — can see, cannot change anything" },
];

/**
 * The six companies that own sites on this network.
 *
 * Listed so the sign-in screen can offer them by name; the accounts themselves
 * are resolved from the `company` table, not from this array.
 */
const SITE_HOSTS = [
  { username: "host1", company: "Cascade Retail Group" },
  { username: "host2", company: "Harborview Hotels" },
  { username: "host3", company: "Sunbelt Medical Centers" },
  { username: "host4", company: "Metro Transit Authority" },
  { username: "host5", company: "Lone Star Logistics Parks" },
  { username: "host6", company: "Greenway Office Campuses" },
];

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("ops");
  const [password, setPassword] = useState("chargeops-demo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/90 p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 ring-1 ring-emerald-400/30">
            <Zap className="h-6 w-6 text-emerald-700 dark:text-emerald-300" />
          </div>
          <div>
            <h1 className="font-display text-xl font-semibold">ChargeOps</h1>
            <p className="text-sm text-slate-400">Internal network operations</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm text-slate-700 dark:text-slate-300">
            Username
            <input className={cn(inputShell, "mt-1.5 w-full")} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label className="block text-sm text-slate-700 dark:text-slate-300">
            Password
            <input className={cn(inputShell, "mt-1.5 w-full")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error ? <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25">{error}</p> : null}
          <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50">
            <ShieldCheck className="h-4 w-4" />
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {/* Each account opens on a different screen, because each role has a
            different first question. Signing in as all five in turn is the
            quickest way to see that the permission model is real. */}
        <div className="mt-6 rounded-lg bg-white/5 p-3 text-xs leading-relaxed text-slate-400">
          <p className="mb-2 font-medium text-slate-300">Local demo accounts</p>
          <ul className="space-y-1">
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.username} className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setUsername(a.username)}
                  className="w-16 shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-left font-mono text-[11px] text-slate-200 hover:bg-white/20"
                >
                  {a.username}
                </button>
                <span>{a.description}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3">
            The password for all of them is <code>chargeops-demo</code>.
          </p>
          <p className="mt-2">
            {/* Both of these resolve against the business data rather than a
                list in the source, which is the point worth showing: a
                technician is a row in `technician`, a site host is a row in
                `company`. */}
            <strong className="text-slate-300">Any engineer</strong> can sign in as{" "}
            <code>tech&lt;id&gt;</code> — <code>tech19</code>, <code>tech101</code> — and{" "}
            <strong className="text-slate-300">any site host</strong> as{" "}
            <code>host&lt;id&gt;</code>:
          </p>
          <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
            {SITE_HOSTS.map((c) => (
              <li key={c.username}>
                <button
                  type="button"
                  onClick={() => setUsername(c.username)}
                  className="text-left font-mono text-[11px] text-slate-300 hover:text-emerald-400"
                >
                  {c.username}
                </button>{" "}
                <span className="text-[11px]">{c.company}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3">
            Signing in as two different hosts in a row is the quickest check that the tenancy
            boundary is real. Override every credential in <code>server/.env</code> before sharing a
            deployment.
          </p>
        </div>
      </div>
    </main>
  );
}

