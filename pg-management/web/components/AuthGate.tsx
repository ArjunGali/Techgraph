'use client';

import { useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { getBaseUrl, setBaseUrl } from '@/lib/api';
import { Button, Card, Field, TextInput, Loading, cx } from './ui';

/**
 * Decides between the sign-in screen and the app.
 *
 * The whole client is behind authentication: there is no unauthenticated view
 * of any tenant, bill or payment, and the server would refuse those requests
 * regardless of what the client rendered.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <Loading label="Starting PG Management" />
      </div>
    );
  }

  if (!user) return <SignIn />;
  return <>{children}</>;
}

function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // Saved before signing in, so a corrected address is used by the very
      // request that tests it.
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
      {/* One column on a phone, a comfortable centred card on a tablet. */}
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

            {/* The packaged APK carries no credentials — only this address —
                so one build can be pointed at any deployment. */}
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
