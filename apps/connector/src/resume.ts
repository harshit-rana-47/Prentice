/** Retry a saved connection after network failure without delaying the local page. */
export function resumeSavedConnection<T>(options: {
  load(): Promise<T | null>;
  activate(value: T): Promise<void>;
  isCurrent(): boolean;
  unavailable(error: unknown): void;
  retryMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const current = () => !stopped && options.isCurrent();
  const resume = async () => {
    if (!current()) return;
    try {
      const value = await options.load();
      if (value && current()) await options.activate(value);
    } catch (error) {
      if (!current()) return;
      options.unavailable(error);
      timer = setTimeout(() => { void resume(); }, Math.min(30_000, (options.retryMs ?? 5_000) * 2 ** attempt++));
      timer.unref?.();
    }
  };
  void resume();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
