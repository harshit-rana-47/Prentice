"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Landing } from "@/components/landing";
import dynamic from "next/dynamic";
const Workspace = dynamic(() => import("@/components/workspace").then(module => module.Workspace), { loading: () => <main id="prentice-main" className="grid min-h-dvh place-items-center"><p role="status" className="font-serif text-2xl">Opening your workspace…</p></main> });
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudConfig, COMPUTER_DISCONNECTED, connectComputer, SIGNED_OUT, type ComputerLink } from "@/lib/relay-browser";
import { prenticeAuth } from "@/lib/supabase-browser";
import type { SyncPayload } from "@prentice/protocol";

interface ActiveDevice {
  id: string;
  name: string;
  revokedAt: string | null;
}

const devLocal = process.env.NEXT_PUBLIC_PRENTICE_DEV_LOCAL === "1";

function subscribeNavigation(changed: () => void) {
  window.addEventListener("popstate", changed);
  return () => window.removeEventListener("popstate", changed);
}
const noBrowserSubscription = () => () => {};
function desktopSnapshot(): "mac" | "windows" | "other" {
  const value = `${navigator.platform} ${navigator.userAgent}`;
  return /Win/i.test(value) ? "windows" : /Mac/i.test(value) ? "mac" : "other";
}

export function ProductShell() {
  const signInRequested = useSyncExternalStore(subscribeNavigation, () => new URLSearchParams(window.location.search).has("signin"), () => false);
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [booting, setBooting] = useState(true);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [code, setCode] = useState<string | null>(null);
  const [device, setDevice] = useState<ActiveDevice | null>(null);
  const [availableDevices, setAvailableDevices] = useState<ActiveDevice[]>([]);
  const [link, setLink] = useState<ComputerLink | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const desktop = useSyncExternalStore(noBrowserSubscription, desktopSnapshot, () => null);
  const [overview, setOverview] = useState<SyncPayload | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [addComputer, setAddComputer] = useState(false);
  const [enterWorkspace, setEnterWorkspace] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let authEventSeen = false;
    let unsubscribe: (() => void) | undefined;
    // Treat client creation and session loading as one asynchronous resource, including setup errors.
    // A component that unmounts before setup completes must not subscribe or apply a late session.
    void Promise.resolve().then(() => {
      if (stopped) return;
      let auth: ReturnType<typeof prenticeAuth>;
      try { auth = prenticeAuth(); } catch {
        setBooting(false); setAuthConfigured(false);
        setNotice("Prentice sign-in is not configured on this website yet.");
        return;
      }
      const applySession = (session: { access_token: string; user: { id: string; email?: string } } | null) => {
        if (stopped) return;
        const nextId = session?.user.id ?? null;
        if (userIdRef.current !== nextId) {
          setDevice(null); setAvailableDevices([]); setLink(null); setWorkspaceOpen(false); setEnterWorkspace(false);
          setCode(null); setCodeExpiresAt(null); setOverview(null); setAddComputer(false);
          setOffline(null); setNotice(null);
        }
        userIdRef.current = nextId;
        accessTokenRef.current = session?.access_token ?? null;
        setUserId(nextId);
        setAccessToken(session?.access_token ?? null);
        setUserEmail(session?.user.email ?? null);
        setBooting(false);
      };
      const subscription = auth.auth.onAuthStateChange((_event, session) => {
        authEventSeen = true;
        applySession(session);
      });
      unsubscribe = () => subscription.data.subscription.unsubscribe();
      return auth.auth.getSession().then(({ data }) => {
        if (!authEventSeen) applySession(data.session);
      });
    }).catch(() => {
      if (stopped || authEventSeen) return;
      setBooting(false);
      setNotice("Prentice could not check your sign-in. Try again.");
    });
    return () => { stopped = true; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!accessToken || device || devLocal) return;
    let stop = false;
    const look = async () => {
      const found = await activeDevice(accessToken);
      if (!stop && found) {
        setDevice(found);
      }
    };
    const failed = (error: unknown) => {
      if (error instanceof Error && error.message === SIGNED_OUT) void prenticeAuth().auth.signOut({ scope: "local" });
      else setNotice(error instanceof Error ? error.message : "Could not reach Prentice.");
    };
    void look().catch(failed);
    const timer = setInterval(() => {
      void look().catch(failed);
    }, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [accessToken, device]);

  useEffect(() => {
    if (!accessToken || devLocal) return;
    let stopped = false;
    const load = () => { void fetch(`${cloudConfig().url}/v1/session`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" })
      .then(async response => response.ok ? await response.json() as { devices: ActiveDevice[] } : null)
      .then(body => { if (!stopped && body) setAvailableDevices(body.devices.filter(item => !item.revokedAt)); })
      .catch(() => undefined); };
    load();
    const timer = setInterval(load, 10_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let stopped = false;
    const load = () => { void fetch(`${cloudConfig().url}/v1/overview`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("overview unavailable"); return await response.json() as SyncPayload; })
      .then(data => { if (!stopped) { setOverview(data); setOverviewError(false); } })
      .catch(() => { if (!stopped) setOverviewError(true); }); };
    load();
    const timer = setInterval(load, 30_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || (device && !addComputer) || code || devLocal) return;
    void issueCode(accessToken)
      .then((issued) => {
        setCode(issued.code);
        setCodeExpiresAt(Date.parse(issued.expiresAt) || null);
      })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not create a pairing code."));
  }, [accessToken, device, code, addComputer]);

  useEffect(() => {
    if (!accessToken || !addComputer) return;
    const timer = setInterval(() => {
      void activeDevice(accessToken).then(found => {
        if (found && found.id !== device?.id) { setDevice(found); setAddComputer(false); setCode(null); setEnterWorkspace(false); }
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [accessToken, addComputer, device?.id]);

  useEffect(() => {
    if (!code || !codeExpiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code, codeExpiresAt]);

  useEffect(() => {
    const token = accessTokenRef.current;
    if (!token || !device || devLocal) return;
    const computer = connectComputer({
      cloudUrl: cloudConfig().url,
      deviceId: device.id,
      accessToken: token,
      refreshAccessToken: async () => {
        const { data } = await prenticeAuth().auth.refreshSession();
        return data.session?.access_token ?? null;
      },
    });
    setLink(computer);
    const unsubscribe = computer.onStatus((message) => {
      setOffline(message);
      if (message === null) setWorkspaceOpen(true);
      if (message === COMPUTER_DISCONNECTED) {
        setDevice(null);
        setCode(null);
        setWorkspaceOpen(false);
      }
      if (message === SIGNED_OUT) void prenticeAuth().auth.signOut({ scope: "local" });
    });
    return () => {
      unsubscribe();
      computer.close();
      setLink(null);
    };
  }, [device]);

  useEffect(() => {
    if (!link) return;
    // Identity changes clear the link and device in applySession; the connection effect closes it.
    if (!accessToken) return;
    link.updateAccessToken(accessToken);
  }, [accessToken, link]);

  const signOut = async () => {
    if (!accessToken) return;
    try {
      const response = await fetch(`${cloudConfig().url}/v1/sign-out`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok && response.status !== 401) throw new Error("Prentice could not end your sessions. Try again.");
      await prenticeAuth().auth.signOut({ scope: "local" });
    } catch {
      setNotice("Prentice could not end your sessions. Try again.");
    }
  };
  const removeComputer = async () => {
    if (!accessToken || !device) return;
    try {
      const response = await fetch(`${cloudConfig().url}/v1/devices/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok && response.status !== 404) throw new Error("Prentice could not remove this computer. Try again.");
      link?.close();
      setLink(null);
      setDevice(null);
      setCode(null);
      setWorkspaceOpen(false);
      setOffline(null);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Prentice could not remove this computer.");
    }
  };
  const account = {
    email: userEmail,
    computerName: device?.name ?? null,
    onSignOut: signOut,
    onRemoveComputer: device ? () => void removeComputer() : undefined,
  };
  const codeExpired = Boolean(code && codeExpiresAt && now >= codeExpiresAt);

  if (accessToken && devLocal) return <Workspace key={userId ?? accessToken} authToken={accessToken} connectionNotice={offline} account={account} />;
  if (enterWorkspace && workspaceOpen && link) return <Workspace key={userId ?? accessToken} connectionNotice={offline} account={account} cloudOverview={overview} />;

  if (accessToken) return (
    <main className="min-h-dvh bg-sidebar px-6 py-10 text-foreground">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="font-serif text-5xl">Prentice</h1><p className="mt-2 text-muted-foreground">Your account across computers</p></div><button type="button" className="underline" onClick={signOut}>Sign Out</button></header>
        <p className="text-sm text-muted-foreground">Account summaries may lag behind local work until its connector synchronizes.{overviewError ? " The cloud overview is unavailable right now." : ""}</p>
        <section className="rounded-2xl border border-border bg-background p-6"><h2 className="font-serif text-2xl">Projects</h2>
          {overview?.projects.length ? <div className="mt-4 grid gap-3 sm:grid-cols-2">{overview.projects.map(project => <article key={project.id} className="rounded-xl border border-border p-4"><h3 className="font-medium">{project.displayName}</h3><p className="mt-1 text-xs text-muted-foreground">Last activity {new Date(project.lastActiveAt).toLocaleDateString()}</p><p className="mt-2 text-sm text-muted-foreground">Connect this computer and link a local checkout to code here.</p></article>)}</div> : <p className="mt-3 text-sm text-muted-foreground">No synchronized projects yet. Your local work stays on its computer.</p>}
        </section>
        <div className="grid gap-6 md:grid-cols-2"><section className="rounded-2xl border border-border bg-background p-6"><h2 className="font-serif text-2xl">Recent activity</h2>{overview?.activity.length ? <ul className="mt-3 space-y-3">{overview.activity.slice(0, 10).map(item => <li key={item.id} className="text-sm"><span className="font-medium">{item.status}</span> · {item.filesAdded + item.filesModified + item.filesDeleted} confirmed files · {new Date(item.createdAt).toLocaleDateString()}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">No synchronized activity yet.</p>}</section>
          <section className="rounded-2xl border border-border bg-background p-6"><h2 className="font-serif text-2xl">Learning</h2>{overview?.concepts.length ? <ul className="mt-3 space-y-2">{overview.concepts.slice(0, 10).map(item => <li key={`${item.projectId}:${item.concept}`} className="text-sm">{item.concept} · {item.state}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">No synchronized concepts yet.</p>}</section></div>
        <section className="rounded-2xl border border-border bg-background p-6"><h2 className="font-serif text-2xl">Connect a computer</h2>
          {availableDevices.length > 1 ? <div className="mt-3 flex flex-wrap gap-2" aria-label="Choose a paired computer">{availableDevices.map(item => <button key={item.id} type="button" className={`rounded-lg border px-3 py-1 text-sm ${device?.id === item.id ? "border-primary" : "border-border"}`} onClick={() => { setDevice(item); setEnterWorkspace(false); setWorkspaceOpen(false); }}>{item.name}</button>)}</div> : null}
          {device ? <><p className="mt-3 text-sm">{device.name} {offline ? "is offline. Open Prentice on this computer and choose this account from its local page." : "is connected."} <a className="underline" href="http://127.0.0.1:4732/" target="_blank" rel="noopener noreferrer">Open the local connector page</a>.</p>{workspaceOpen && link ? <button type="button" className="mt-3 rounded-lg bg-primary px-4 py-2 text-primary-foreground" onClick={() => setEnterWorkspace(true)}>Open workspace</button> : null}<button type="button" className="ml-3 mt-3 underline" onClick={() => { setAddComputer(true); setCode(null); }}>Connect another computer</button></> : <p className="mt-3 text-sm">Open Prentice on this computer, then enter this one-time code in its local page.</p>}
          {code ? <p className="mt-3 font-mono text-2xl tracking-widest text-primary">{codeExpired ? "Code expired" : code}</p> : null}
          {codeExpired ? <button type="button" className="mt-2 underline" onClick={() => setCode(null)}>Get a new code</button> : null}
          {(!device || addComputer || Boolean(offline)) && desktop === "mac" ? <a className="mt-3 block underline" href="/download/mac">Download Prentice for Mac (unsigned beta)</a> : null}
          {(!device || addComputer) && desktop === "windows" ? <a className="mt-3 block underline" href="/download/windows">Download Prentice for Windows</a> : null}
          {!device ? <a className="mt-3 inline-block underline" href="http://127.0.0.1:4732/" target="_blank" rel="noopener noreferrer">Open the local connector page</a> : null}
          {notice ? <p role="status" className="mt-3 text-sm text-destructive">{notice}</p> : null}
        </section>
      </div>
    </main>
  );

  if (!accessToken && !signInRequested) return <Landing onStart={() => {
    window.history.pushState(null, "", "?signin=1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo(0, 0);
  }} />;

  return (
    <main id="prentice-main" className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-sidebar px-6">
      {/* Leaving sign-in deliberately resets the auth surface, preserving the existing full navigation. */}
      <Link href="/" prefetch={false} onNavigate={event => { event.preventDefault(); window.location.assign("/"); }} className="absolute top-6 left-6 text-sm text-muted-foreground hover:text-foreground">← Back to Prentice</Link>
      <div className="prentice-rise relative w-full max-w-sm rounded-2xl border border-border bg-background px-8 py-9 shadow-[0_1px_0_rgb(36_24_15/0.04),0_24px_48px_-28px_rgb(36_24_15/0.45)]">
        <h1 className="font-serif text-5xl tracking-[-0.03em] text-balance" translate="no">
          Prentice
        </h1>
        <div className="prentice-rule mt-3 h-px w-16 origin-left bg-primary" />
        <p className="mt-3 text-sm leading-6 text-pretty text-muted-foreground">Sign in to work with the repository on this computer.</p>
        {booting || sentTo || offline || notice ? (
          <p className="mt-4 text-sm text-pretty" role="status" aria-live="polite">
            {booting ? "Opening…" : sentTo ? `Check ${sentTo} for the sign-in link.` : (offline ?? notice)}
          </p>
        ) : null}
        {!accessToken && !booting && authConfigured ? (
          <form
            className="mt-6 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const next = email.trim();
              setFieldError(null);
              setSending(true);
              void prenticeAuth()
                .auth.signInWithOtp({ email: next, options: { emailRedirectTo: window.location.origin } })
                .then(({ error }) => {
                  if (error) {
                    setFieldError(error.message);
                    emailRef.current?.focus();
                    return;
                  }
                  setSentTo(next);
                })
                .catch(() => {
                  setFieldError("Could not send the sign-in link. Check your connection and try again.");
                  emailRef.current?.focus();
                })
                .finally(() => setSending(false));
            }}
          >
            <label className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase" htmlFor="email">
              Email
            </label>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              value={email}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? "email-error" : undefined}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            {fieldError ? (
              <p id="email-error" className="text-xs text-destructive">
                {fieldError}
              </p>
            ) : null}
            <Button type="submit" disabled={sending}>
              {sending ? "Sending…" : sentTo ? "Resend Link" : "Send Sign-In Link"}
            </Button>
          </form>
        ) : null}
      </div>
    </main>
  );
}

async function activeDevice(token: string): Promise<ActiveDevice | null> {
  const response = await fetch(`${cloudConfig().url}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Error(SIGNED_OUT);
  if (!response.ok) return null;
  const body = (await response.json()) as { devices: ActiveDevice[] };
  const active = body.devices.filter((item) => !item.revokedAt);
  return active[active.length - 1] ?? null;
}

async function issueCode(token: string): Promise<{ code: string; expiresAt: string }> {
  const response = await fetch(`${cloudConfig().url}/v1/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { code?: string; expiresAt?: string; error?: { message: string } };
  if (!response.ok || !body.code) throw new Error(body.error?.message ?? "Could not create a pairing code.");
  return { code: body.code, expiresAt: body.expiresAt ?? "" };
}
