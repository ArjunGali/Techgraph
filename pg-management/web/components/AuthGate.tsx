'use client';

import { useState, type ReactNode } from 'react';
import { useAuth, autoLoginConfigured } from '@/lib/auth';
import { getBaseUrl, setBaseUrl } from '@/lib/api';
import { Button, Card, Field, TextInput, Loading, cx } from './ui';

/**
 * What the app shows before the dashboard.
 *
 * In single-user mode there is no sign-in step: the app authenticates itself on
 * launch and goes straight to the dashboard. A screen appears here only when
 * something actually needs the owner's attention —
 *
 *   - the server cannot be reached, so its address needs correcting; or
 *   - the built-in credentials were refused, so someone has to sign in.
 *
 * Authentication itself is untouched. The server still authenticates every
 * request and enforces permissions; the app just stops asking the owner to
 * prove who they are on their own phone.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, blocker, blockerMessage } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <Loading label="Opening PG Management" />
      </div>
    );
  }

  if (user) return <>{children}</>;

  // Reaching the server is the usual first-run problem, so that gets a screen
  // of its own rather than a password form the owner cannot act on.
  if (blocker === 'unreachable') {
    return <ServerSetup message={blockerMessage} />;
  }

  return <SignIn message={blockerMessage} />;
}

/**
 * Shown when the app could not reach the API. Asks for the one thing that can
 * fix it — the address — and nothing else.
 */
function ServerSetup({ message }: { message: string | null }) {
  const { retryAutoLogin } = useAuth();
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setBaseUrl(apiUrl);
    await retryAutoLogin();
    setPending(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-8 pt-safe-top">
      <div className="w-full max-w-sm sm:max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold">PG Management</h1>
          <p className="mt-1 text-sm text-content-muted">Connect to your server</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="rounded-lg bg-caution/10 px-3 py-2 text-sm text-caution">
              {message ?? 'The server could not be reached.'}
            </p>

            <Field
              label="Server address"
              hint="Where the PG Management API is running, for example https://api.yourpg.com"
            >
              <TextInput
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
                placeholder="https://api.yourpg.com"
              />
            </Field>

            <Button type="submit" fullWidth disabled={pending}>
              {pending ? 'Connecting…' : 'Connect'}
            </Button>

            <p className="text-xs text-content-muted">
              On an emulator, use <code>http://10.0.2.2:4000</code> — on a phone, the computer&apos;s
              address on your network. This is stored on the device, so it is only entered once.
            </p>
          </form>
        </Card>
      </div>
    </div>
  );
}

/**
 * The manual sign-in form. Only reached when automatic sign-in is switched off,
 * its credentials were refused, or the owner signed out deliberately.
 */
function SignIn({ message }: { message: string | null }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(
    // A rejected automatic sign-in is worth explaining, but not on a first run
    // where the feature is simply switched off.
    autoLoginConfigured ? message : null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      setBaseUrl(apiUrl);
      await signIn(email.trim(), password);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-8 pt-safe-top">
      <div className="w-full max-w-sm sm:max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold">PG Management</h1>
          <p className="mt-1 text-sm text-content-muted">Sign in to continue</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Email">
              <TextInput
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            <Field label="Password">
              <TextInput
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            {error ? (
              <p className="rounded-lg bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>
            ) : null}

            <Button type="submit" fullWidth disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>

            <div className="border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setShowServer((value) => !value)}
                className="text-xs text-content-muted underline"
              >
                {showServer ? 'Hide server settings' : 'Server settings'}
              </button>
              <div className={cx('mt-3', showServer ? 'block' : 'hidden')}>
                <Field label="API address" hint="For example https://api.yourpg.com">
                  <TextInput
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    value={apiUrl}
                    onChange={(event) => setApiUrl(event.target.value)}
                  />
                </Field>
              </div>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
