import { useEffect, useRef, useState } from "react";

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs a load when the key or the signal changes and when reload is called. The signal is the count of a learning stream
 * event, so a window fetches after the server has said that something changed. The data of an earlier load stays on show
 * during a reload of the same key and is dropped when the key changes.
 */
export function useFetched<T>(load: () => Promise<T>, key: string, signal = 0): Fetched<T> {
  const [bump, setBump] = useState(0);
  const [res, setRes] = useState<{ key: string; stamp: string; data: T | null; error: string | null } | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const stamp = `${signal}:${bump}`;
  useEffect(() => {
    let live = true;
    loader
      .current()
      .then((data) => live && setRes({ key, stamp, data, error: null }))
      .catch((e: unknown) => live && setRes({ key, stamp, data: null, error: e instanceof Error && e.message ? e.message : "The server could not complete the request." }));
    return () => {
      live = false;
    };
  }, [key, stamp]);
  const mine = res && res.key === key ? res : null;
  return { data: mine?.data ?? null, error: mine?.error ?? null, loading: !(res && res.key === key && res.stamp === stamp), reload: () => setBump((b) => b + 1) };
}
