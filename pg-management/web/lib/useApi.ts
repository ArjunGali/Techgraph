'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError } from './api';

type QueryState<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
};

/**
 * Loads data from the API, cancelling in flight when the inputs change or the
 * screen is left — so rotating a tablet mid-load cannot land stale data on the
 * new layout.
 */
export function useApiQuery<T>(
  path: string | null,
  query?: Record<string, string | number | boolean | null | undefined>,
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  const queryKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiRequest<T>(path, { query: JSON.parse(queryKey), signal: controller.signal })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if ((caught as Error).name === 'AbortError') return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'error', String(caught)));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [path, queryKey, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, reload };
}

/** A mutation with its own pending and error state, for buttons and forms. */
export function useApiMutation<TResult, TInput = unknown>(
  build: (input: TInput) => { path: string; method?: string; body?: unknown; formData?: FormData },
): {
  run: (input: TInput) => Promise<TResult>;
  pending: boolean;
  error: ApiError | null;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(
    async (input: TInput) => {
      setPending(true);
      setError(null);
      try {
        const request = build(input);
        return await apiRequest<TResult>(request.path, {
          method: request.method,
          body: request.body,
          formData: request.formData,
        });
      } catch (caught) {
        const apiError =
          caught instanceof ApiError ? caught : new ApiError(0, 'error', String(caught));
        setError(apiError);
        throw apiError;
      } finally {
        setPending(false);
      }
    },
    [build],
  );

  return { run, pending, error, reset: () => setError(null) };
}
