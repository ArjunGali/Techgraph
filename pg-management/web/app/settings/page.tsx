'use client';

import { AppShell } from '@/components/AppShell';
import { Button, Card, Field, SectionHeading, Select, cx } from '@/components/ui';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { useAuth, autoLoginConfigured } from '@/lib/auth';
import { getBaseUrl } from '@/lib/api';
import { useApiQuery } from '@/lib/useApi';

/** Account, appearance and connection settings. */
export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const health = useApiQuery<{ status: string; database: string; time: string }>('/api/health');

  return (
    <AppShell title="Settings">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section>
          <SectionHeading title="Account" />
          <Card>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-content-muted">Name</dt>
                <dd className="font-medium">{user?.fullName}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Email</dt>
                <dd>{user?.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Role</dt>
                <dd className="capitalize">{user?.role}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Branch access</dt>
                <dd>
                  {user?.branchIds === null
                    ? 'All branches'
                    : `${user?.branchIds.length} assigned branch(es)`}
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <Button variant="secondary" fullWidth onClick={signOut}>
                Sign out
              </Button>
              {autoLoginConfigured ? (
                <p className="mt-2 text-xs text-content-muted">
                  This app signs itself in automatically. Signing out returns you to the sign-in
                  screen for now; the next time you open the app it will sign in again on its own.
                </p>
              ) : null}
            </div>
          </Card>
        </section>

        <section>
          <SectionHeading title="Appearance" subtitle="Applies across every screen" />
          <Card>
            <Field label="Theme">
              <div className="grid grid-cols-3 gap-2">
                {(['light', 'dark', 'system'] as ThemePreference[]).map((option) => (
                  <button
                    key={option}
                    onClick={() => setPreference(option)}
                    className={cx(
                      'min-h-tap rounded-lg border text-sm capitalize',
                      preference === option
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-border text-content',
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </Field>
            <p className="mt-3 text-xs text-content-muted">
              &quot;System&quot; follows the device setting and changes with it.
            </p>
          </Card>
        </section>

        <section>
          <SectionHeading title="Connection" />
          <Card>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-content-muted">API address</dt>
                <dd className="break-all font-mono text-xs">{getBaseUrl()}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Status</dt>
                <dd>
                  {health.loading
                    ? 'Checking…'
                    : health.error
                      ? 'Unreachable'
                      : `${health.data?.status} · database ${health.data?.database}`}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-content-muted">
              The app holds no database credentials. It reaches PostgreSQL only through this API,
              which decides what your role may see.
            </p>
          </Card>
        </section>
      </div>
    </AppShell>
  );
}
