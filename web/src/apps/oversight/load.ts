import { useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs a load when the key changes and when reload is called. The data of an earlier load stays on show during a reload of the
 * same key, and it is dropped when the key changes, so that one run is never shown under the name of another.
 */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [bump, setBump] = useState(0);
  const [res, setRes] = useState<{ key: string; bump: number; data: T | null; error: string | null } | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  useEffect(() => {
    let live = true;
    loader
      .current()
      .then((data) => live && setRes({ key, bump, data, error: null }))
      .catch((e: unknown) => live && setRes({ key, bump, data: null, error: e instanceof Error && e.message ? e.message : "The server could not complete the request." }));
    return () => {
      live = false;
    };
  }, [key, bump]);
  const mine = res && res.key === key ? res : null;
  return { data: mine?.data ?? null, error: mine?.error ?? null, loading: !(res && res.key === key && res.bump === bump), reload: () => setBump((b) => b + 1) };
}
