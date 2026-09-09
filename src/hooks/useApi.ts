// src/hooks/useApi.ts — generic data-fetching hook
import { useState, useEffect, useCallback, useRef } from "react";

export interface ApiState<T> {
  data:    T | null;
  loading: boolean;
  error:   string | null;
  refetch: () => void;
}

/**
 * Usage:
 *   const { data, loading, error } = useApi(() => fetchStations({ state: "TX" }), [state]);
 *
 * The second argument is a dependency array — refetches whenever values change.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = []
): ApiState<T> {
  const [data,    setData]    = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Keep latest fetcher without re-creating the effect
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [...deps, run]);

  return { data, loading, error, refetch: run };
}
