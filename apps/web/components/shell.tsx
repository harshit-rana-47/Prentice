import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-[family-name:var(--font-serif)] text-4xl tracking-tight">Prentice</p>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Keep the speed of a coding agent. The repository stays local. Vendor inference is used only when that provider requires it.
        </p>
      </header>
      {children}
    </div>
  );
}
