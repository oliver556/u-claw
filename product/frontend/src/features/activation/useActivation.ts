import { useCallback, useEffect, useRef, useState } from "react";

export type ActivationState = "checking" | "input" | "submitting" | "server-bound" | "writing" | "verifying" | "committing" | "complete" | "recovery-required" | "error";
export interface ActivationStatus { state: ActivationState; code?: string }
export interface ActivationApi {
  preflight(): Promise<ActivationStatus>;
  submit(input: { username: string; activationCode: string }): Promise<ActivationStatus>;
  commit(): Promise<ActivationStatus>;
  cancel(): Promise<ActivationStatus>;
  close(): Promise<ActivationStatus>;
}

const POLLABLE_STATES = new Set<ActivationState>(["server-bound", "writing", "verifying", "committing"]);
const POLL_INTERVAL_MS = 250;

export function normalizeActivationCode(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/gu, "").slice(0, 26);
}

export function formatActivationCode(value: string): string {
  const normalized = normalizeActivationCode(value);
  return [normalized.slice(0, 5), normalized.slice(5, 10), normalized.slice(10, 15), normalized.slice(15, 20), normalized.slice(20, 26)].filter(Boolean).join("-");
}

export function useActivation(api: ActivationApi) {
  const [status, setStatus] = useState<ActivationStatus>({ state: "checking" });
  const mounted = useRef(true);
  const operationToken = useRef(0);
  const update = useCallback((next: ActivationStatus) => { if (mounted.current) setStatus(next); }, []);
  const preflight = useCallback(async () => {
    const token = ++operationToken.current;
    update({ state: "checking" });
    try {
      const next = await api.preflight();
      if (token === operationToken.current) update(next);
    } catch {
      if (token === operationToken.current) update({ state: "error", code: "PREFLIGHT_FAILED" });
    }
  }, [api, update]);

  useEffect(() => {
    mounted.current = true;
    void preflight();
    return () => { mounted.current = false; };
  }, [preflight]);

  const submit = useCallback(async (username: string, activationCode: string) => {
    const token = ++operationToken.current;
    update({ state: "submitting" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const poll = async (): Promise<void> => {
      if (finished || !mounted.current || token !== operationToken.current) return;
      try {
        const progress = await api.commit();
        if (finished || !mounted.current || token !== operationToken.current) return;
        if (POLLABLE_STATES.has(progress.state)) update(progress);
      } catch {
        // Progress polling is advisory; submit owns the terminal result.
      }
      if (!finished && mounted.current && token === operationToken.current) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    try {
      const next = await api.submit({ username: username.trim(), activationCode: normalizeActivationCode(activationCode) });
      if (token === operationToken.current) update(next);
    } catch {
      if (token === operationToken.current) update({ state: "error", code: "ACTIVATION_FAILED" });
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  }, [api, update]);

  return { status, preflight, submit, close: api.close };
}
