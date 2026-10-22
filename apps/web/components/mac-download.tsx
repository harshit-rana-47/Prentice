import Link from "next/link";

export function MacDownload({ available }: { available: boolean }) {
  return (
    <main id="prentice-main" className="min-h-dvh bg-background px-6 py-8 text-foreground sm:py-12">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">← Back to Prentice</Link>
        <header className="mt-10">
          <p className="font-mono text-xs tracking-widest text-muted-foreground">MACOS 13.5+ · APPLE SILICON & INTEL</p>
          <h1 className="mt-4 font-serif text-5xl sm:text-6xl">Prentice for Mac</h1>
          <p className="mt-5 text-lg text-muted-foreground">Connect your browser workspace to the projects and coding agents on your Mac.</p>
        </header>
        {available ? <>
          <section aria-labelledby="beta-title" className="mt-8 border-l-2 border-primary pl-5">
            <h2 id="beta-title" className="font-medium">Unsigned beta</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">This early version has not been signed with an Apple Developer ID or notarized by Apple. macOS will ask you to approve it before it can run. Install it only if you trust this source.</p>
          </section>
          <a href="/download/mac/file" className="mt-7 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Download Mac beta (.zip)</a>
          <section aria-labelledby="setup-title" className="mt-12 border-t border-border pt-8">
            <h2 id="setup-title" className="font-serif text-3xl">Get connected</h2>
            <ol className="mt-6 list-decimal space-y-6 pl-5 marker:text-primary">
              <li className="pl-2"><h3 className="font-medium">Unzip and open Prentice</h3><p className="mt-1 leading-relaxed text-muted-foreground">Open Prentice-Mac.zip, then open Prentice.app. It installs in your home Applications folder and starts when you sign in to your Mac.</p></li>
              <li className="pl-2"><h3 className="font-medium">Approve this beta in macOS</h3><p className="mt-1 leading-relaxed text-muted-foreground">If macOS blocks it because the developer cannot be verified, open System Settings → Privacy & Security after trying to launch it. Choose Open Anyway for Prentice, then confirm Open. If macOS reports malware or damage, stop and report the problem.</p><a href="https://support.apple.com/en-us/102445" target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4">Apple’s guide to opening downloaded apps ↗</a></li>
              <li className="pl-2"><h3 className="font-medium">Pair your Mac</h3><p className="mt-1 leading-relaxed text-muted-foreground">Sign in to the Prentice website, choose Connect another computer if needed, and enter its one-time code in the local connector page. Return to the website and select your Mac to open the workspace.</p><a href="http://127.0.0.1:4732/" target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4">Open the local connector page ↗</a></li>
            </ol>
          </section>
          <p className="mt-10 border-t border-border pt-6 text-sm leading-relaxed text-muted-foreground">Keep your Mac awake and Prentice running while you work. You’ll need Git and your own supported coding-agent installation and account. Node is included; no cloud API keys are needed on your Mac.</p>
        </> : <section className="mt-8 border-t border-border pt-8" role="status"><h2 className="font-serif text-3xl">The Mac beta is being prepared</h2><p className="mt-3 text-muted-foreground">Please check back shortly. If Prentice is already installed, open it on your Mac and return to your workspace.</p></section>}
      </div>
    </main>
  );
}
