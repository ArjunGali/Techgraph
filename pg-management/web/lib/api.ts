'use client';

/**
 * The API client.
 *
 * The packaged APK ships with a base URL and nothing else — no database
 * credentials ever reach the device. Every request carries the signed session
 * token; what the caller is allowed to see is decided by the server.
 */

const STORAGE_TOKEN_KEY = 'pg.auth.token';
const STORAGE_BASE_URL_KEY = 'pg.api.baseUrl';

/**
 * Resolution order: a URL the user configured on the sign-in screen, then the
 * value baked in at build time, then localhost for `npm run dev`.
 *
 * Letting the operator set it on-device means one APK can be pointed at a
 * staging or production API without a rebuild.
 */
export function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const configured = window.localStorage.getItem(STORAGE_BASE_URL_KEY);
    if (configured) return configured.replace(/\/$/, '');
  }
  const compiled = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (compiled) return compiled.replace(/\/$/, '');
  return 'http://localhost:4000';
}

export function setBaseUrl(url: string): void {
  window.localStorage.setItem(STORAGE_BASE_URL_KEY, url.replace(/\/$/, ''));
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) window.localStorage.setItem(STORAGE_TOKEN_KEY, token);
  else window.localStorage.removeItem(STORAGE_TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Fired when the server rejects the session, so the shell can sign out. */
export const SESSION_EXPIRED_EVENT = 'pg:session-expired';

type RequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Multipart upload; `body` is ignored when this is set. */
  formData?: FormData;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${getBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined && !options.formData) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? (options.body || options.formData ? 'POST' : 'GET'),
      headers,
      body: options.formData ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // On a phone this is usually no signal or a wrong API address, which is
    // worth saying plainly rather than showing "Failed to fetch".
    throw new ApiError(
      0,
      'network_error',
      `Cannot reach the server at ${getBaseUrl()}. Check the connection and the API address.`,
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const error = (payload.error ?? {}) as { code?: string; message?: string; details?: unknown };
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(
      response.status,
      error.code ?? 'error',
      error.message ?? `Request failed (${response.status})`,
      error.details,
    );
  }

  return payload as T;
}

/**
 * Fetches a protected file and returns an object URL for it.
 *
 * An <img src> cannot carry an Authorization header, and putting the token in
 * the query string would leak it into server logs and proxy history — which
 * matters most for exactly the files that need protecting, such as Aadhaar
 * scans. The file is fetched with the header and handed to the WebView as a
 * blob instead. Callers must revoke the URL when the view unmounts.
 */
export async function fetchFileObjectUrl(path: string): Promise<string> {
  const token = getToken();
  const response = await fetch(`${getBaseUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'file_error', 'Could not load that file.');
  }
  return URL.createObjectURL(await response.blob());
}
