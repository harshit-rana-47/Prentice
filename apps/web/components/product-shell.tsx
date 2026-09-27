"use client";

import { useEffect, useRef, useState } from "react";
import { Workspace } from "@/components/workspace";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudConfig, COMPUTER_DISCONNECTED, connectComputer, type ComputerLink } from "@/lib/relay-browser";
import { prenticeAuth } from "@/lib/supabase-browser";

interface ActiveDevice {
  id: string;
  name: string;
  revokedAt: string | null;
}

const devLocal = process.env.NEXT_PUBLIC_PRENTICE_DEV_LOCAL === "1";

export function ProductShell() {
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [device, setDevice] = useState<ActiveDevice | null>(null);
  const [link, setLink] = useState<ComputerLink | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [pairedBefore, setPairedBefore] = useState(false);
  const [desktop, setDesktop] = useState<"mac" | "windows" | "other" | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  useEffect(() => {
    const value = `${navigator.platform} ${navigator.userAgent}`;
    if (/Win/i.test(value)) setDesktop("windows");
    else if (/Mac/i.test(value)) setDesktop("mac");
    else setDesktop("other");
  }, []);

  useEffect(() => {
    const auth = prenticeAuth();
    void auth.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
      setBooting(false);
    });
    const subscription = auth.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token ?? null);
      setBooting(false);
    });
    return () => subscription.data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!accessToken || device || devLocal) return;
    let stop = false;
    const look = async () => {
      const found = await activeDevice(accessToken);
      if (!stop && found) {
        setPairedBefore(true);
        setDevice(found);
      }
    };
    void look().catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not reach Prentice."));
    const timer = setInterval(() => {
      void look().catch(() => undefined);
    }, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [accessToken, device]);

  useEffect(() => {
    if (!accessToken || device || code || devLocal) return;
    void issueCode(accessToken)
      .then(setCode)
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not create a pairing code."));
  }, [accessToken, device, code]);

  useEffect(() => {
    const token = accessTokenRef.current;
    if (!token || !device || devLocal) return;
    const computer = connectComputer({ cloudUrl: cloudConfig().url, deviceId: device.id, accessToken: token });
    setLink(computer);
    const unsubscribe = computer.onStatus((message) => {
      setOffline(message);
      if (message === null) setWorkspaceOpen(true);
      if (message === COMPUTER_DISCONNECTED) {
        setPairedBefore(true);
        setDevice(null);
        setCode(null);
        setWorkspaceOpen(false);
      }
    });
    return () => {
      unsubscribe();
      computer.close();
      setLink(null);
    };
  }, [device]);

  useEffect(() => {
    if (!link) return;
    if (!accessToken) {
      link.close();
      setLink(null);
      setDevice(null);
      setPairedBefore(false);
      setWorkspaceOpen(false);
      return;
    }
    link.updateAccessToken(accessToken);
  }, [accessToken, link]);

  if (accessToken && devLocal) return <Workspace connectionNotice={offline} />;
  if (workspaceOpen && link) return <Workspace connectionNotice={offline} />;

  return (
    <main id="prentice-main" className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-sidebar px-6">
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
        {!accessToken && !booting ? (
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
        {accessToken && !device && code ? (
          <section className="mt-6 flex flex-col gap-3">
            <h2 className="font-serif text-[1.75rem] tracking-[-0.03em] text-balance">
              {pairedBefore ? "Connect this computer again" : "Connect this computer"}
            </h2>
            {pairedBefore ? (
              <p className="text-sm leading-6 text-pretty text-muted-foreground">
                Open Prentice on this computer and enter this code in its window. Your projects stay on this computer.
              </p>
            ) : (
              <>
                <p className="text-sm leading-6 text-pretty text-muted-foreground">
                  Download Prentice, open it once, and enter this code in the window it shows. This computer may ask you to confirm the first open.
                </p>
                {desktop === "mac" ? (
                  <a className={buttonVariants({ variant: "default" })} href="/download/mac">
                    Download for Mac
                  </a>
                ) : null}
                {desktop === "windows" ? (
                  <a className={buttonVariants({ variant: "default" })} href="/download/windows">
                    Download for Windows
                  </a>
                ) : null}
                {desktop === "other" ? (
                  <p className="text-sm leading-6 text-pretty text-muted-foreground">
                    Prentice runs on macOS and Windows. Open this page on the computer where the project lives.
                  </p>
                ) : null}
              </>
            )}
            <p className="font-mono text-3xl tracking-[0.28em] text-primary tabular-nums" translate="no">
              {code}
            </p>
            <p className="text-sm text-muted-foreground">After this, this computer reconnects on its own.</p>
          </section>
        ) : null}
        {accessToken && device && offline ? (
          <p className="mt-6 text-sm text-pretty">This computer is offline. Your projects stay on it and will show up when it is available.</p>
        ) : null}
        {accessToken && device && !offline && !workspaceOpen ? <p className="mt-6 text-sm text-muted-foreground">Connecting to this computer…</p> : null}
      </div>
    </main>
  );
}

async function activeDevice(token: string): Promise<ActiveDevice | null> {
  const response = await fetch(`${cloudConfig().url}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const body = (await response.json()) as { devices: ActiveDevice[] };
  const active = body.devices.filter((item) => !item.revokedAt);
  return active[active.length - 1] ?? null;
}

async function issueCode(token: string): Promise<string> {
  const response = await fetch(`${cloudConfig().url}/v1/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { code?: string; error?: { message: string } };
  if (!response.ok || !body.code) throw new Error(body.error?.message ?? "Could not create a pairing code.");
  return body.code;
}
