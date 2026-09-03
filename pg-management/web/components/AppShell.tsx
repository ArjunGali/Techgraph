'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useAuth, P } from '@/lib/auth';
import { useLayoutShape } from '@/lib/useMediaQuery';
import { useTheme } from '@/lib/theme';
import { cx } from './ui';

/**
 * The application shell.
 *
 * One component decides the whole navigation model from available width:
 *
 *   Phones  — a bottom tab bar within thumb reach, holding the five
 *             destinations used most, with everything else behind "More".
 *   Tablets — a persistent sidebar showing every destination at once, so the
 *             extra width buys the user context rather than empty margins.
 *
 * There is no phone build and no tablet build, and no manual switch: rotating
 * a device or resizing a split-screen window moves the app between the two
 * arrangements live.
 */

type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Permissions required to see it; the server enforces them regardless. */
  permissions?: string[];
  /** Shown in the phone tab bar rather than only under "More". */
  primary?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: '◈', primary: true },
  { href: '/property', label: 'Property', icon: '▤', permissions: [P.BRANCH_READ], primary: true },
  { href: '/tenants', label: 'Tenants', icon: '☗', permissions: [P.TENANT_READ], primary: true },
  { href: '/billing', label: 'Billing', icon: '₹', permissions: [P.BILLING_READ], primary: true },
  { href: '/vacancies', label: 'Vacancies', icon: '◇', permissions: [P.BRANCH_READ] },
  { href: '/payments', label: 'Payments', icon: '✓', permissions: [P.PAYMENT_READ] },
  { href: '/meters', label: 'Electricity', icon: '⚡', permissions: [P.METER_READ] },
  { href: '/reports', label: 'Reports', icon: '▦', permissions: [P.REPORT_READ] },
  { href: '/maintenance', label: 'Maintenance', icon: '⚒', permissions: [P.MAINTENANCE_READ] },
  { href: '/expenses', label: 'Expenses', icon: '▼', permissions: [P.EXPENSE_READ] },
  { href: '/pricing', label: 'Pricing', icon: '◐', permissions: [P.PRICING_READ] },
  { href: '/automation', label: 'Automation', icon: '⟳', permissions: [P.AUTOMATION_READ] },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

function useVisibleNav(): NavItem[] {
  const { can } = useAuth();
  return NAV_ITEMS.filter((item) => !item.permissions || can(...item.permissions));
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ---------------------------------------------------------------------------
// Tablet: persistent sidebar
// ---------------------------------------------------------------------------
function Sidebar() {
  const pathname = usePathname();
  const items = useVisibleNav();
  const { user, signOut } = useAuth();
  const { isWide } = useLayoutShape();

  return (
    <nav
      aria-label="Main"
      className={cx(
        'flex shrink-0 flex-col border-r border-border bg-surface-raised pt-safe-top',
        // Icons-plus-label on small tablets; a wider rail once there is room.
        isWide ? 'w-64' : 'w-56',
      )}
    >
      <div className="px-4 py-4">
        <p className="text-sm font-semibold">PG Management</p>
        <p className="mt-0.5 truncate text-xs text-content-muted">{user?.fullName}</p>
      </div>

      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={cx(
                'flex min-h-tap items-center gap-3 rounded-lg px-3 text-sm transition',
                isActive(pathname, item.href)
                  ? 'bg-brand text-brand-contrast font-medium'
                  : 'text-content hover:bg-surface-sunken',
              )}
            >
              <span aria-hidden className="w-5 text-center text-base">
                {item.icon}
              </span>
              <span className="truncate">{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="border-t border-border p-2">
        <button
          onClick={signOut}
          className="flex min-h-tap w-full items-center gap-3 rounded-lg px-3 text-sm text-content-muted hover:bg-surface-sunken"
        >
          <span aria-hidden className="w-5 text-center">
            ⏻
          </span>
          Sign out
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Phone: bottom tab bar plus a "More" sheet
// ---------------------------------------------------------------------------
function BottomNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const items = useVisibleNav();
  const primary = items.filter((item) => item.primary).slice(0, 4);
  const hasMore = items.length > primary.length;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-raised pb-safe-bottom"
    >
      <ul className="flex">
        {primary.map((item) => (
          <li key={item.href} className="flex-1">
            <Link
              href={item.href}
              className={cx(
                'flex min-h-tap flex-col items-center justify-center gap-0.5 py-1.5',
                isActive(pathname, item.href) ? 'text-brand' : 'text-content-muted',
              )}
            >
              <span aria-hidden className="text-lg leading-none">
                {item.icon}
              </span>
              <span className="text-[11px] font-medium">{item.label}</span>
            </Link>
          </li>
        ))}
        {hasMore ? (
          <li className="flex-1">
            <button
              onClick={onMore}
              className="flex min-h-tap w-full flex-col items-center justify-center gap-0.5 py-1.5 text-content-muted"
            >
              <span aria-hidden className="text-lg leading-none">
                ⋯
              </span>
              <span className="text-[11px] font-medium">More</span>
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const items = useVisibleNav().filter((item) => !item.primary);
  const { preference, setPreference } = useTheme();
  const { signOut, user } = useAuth();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={onClose} role="presentation">
      <div
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-surface-raised pb-safe-bottom"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex justify-center pt-2" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-border" />
        </div>

        <div className="px-4 py-3">
          <p className="font-semibold">{user?.fullName}</p>
          <p className="text-xs capitalize text-content-muted">{user?.role}</p>
        </div>

        <ul className="grid grid-cols-3 gap-2 px-4 xs:grid-cols-4">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onClose}
                className={cx(
                  'flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl border border-border p-2 text-center',
                  isActive(pathname, item.href) ? 'border-brand text-brand' : 'text-content',
                )}
              >
                <span aria-hidden className="text-xl leading-none">
                  {item.icon}
                </span>
                <span className="text-[11px] font-medium leading-tight">{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-4 border-t border-border px-4 py-3">
          <p className="mb-2 text-sm font-medium">Appearance</p>
          <div className="grid grid-cols-3 gap-2">
            {(['light', 'dark', 'system'] as const).map((option) => (
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
        </div>

        <div className="border-t border-border p-4">
          <button
            onClick={() => {
              onClose();
              signOut();
            }}
            className="min-h-tap w-full rounded-lg border border-border text-sm text-critical"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
export function AppShell({
  title, subtitle, actions, children,
}: {
  title: string;
  subtitle?: string;
  /** Page-level actions; on a phone these sit under the title, not beside it. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { isPhone } = useLayoutShape();
  const [moreOpen, setMoreOpen] = useState(false);
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex min-h-screen bg-surface">
      {!isPhone ? <Sidebar /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            'sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur',
            isPhone ? 'pt-safe-top' : '',
          )}
        >
          <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold sm:text-xl">{title}</h1>
              {subtitle ? (
                <p className="mt-0.5 truncate text-sm text-content-muted">{subtitle}</p>
              ) : null}
            </div>

            {/* On a tablet the actions and the theme toggle sit in the header;
                on a phone the header stays clean and they move into the page. */}
            {!isPhone ? (
              <div className="flex shrink-0 items-center gap-2">
                {actions}
                <button
                  onClick={() =>
                    setPreference(preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark')
                  }
                  aria-label={`Theme: ${preference}`}
                  title={`Theme: ${preference}`}
                  className="flex h-tap min-h-tap w-tap min-w-tap items-center justify-center rounded-lg border border-border text-content-muted hover:bg-surface-sunken"
                >
                  {preference === 'dark' ? '☾' : preference === 'light' ? '☀' : '◐'}
                </button>
              </div>
            ) : null}
          </div>

          {isPhone && actions ? (
            <div className="flex flex-wrap gap-2 px-4 pb-3">{actions}</div>
          ) : null}
        </header>

        <main
          className={cx(
            'flex-1 px-4 py-4 sm:px-6 sm:py-6',
            // Room for the tab bar so the last row is never hidden behind it.
            isPhone && 'pb-24',
          )}
        >
          {/* Content is capped on very wide screens so lines stay readable,
              while grids inside still use the full width. */}
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>

      {isPhone ? (
        <>
          <BottomNav onMore={() => setMoreOpen(true)} />
          <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
        </>
      ) : null}
    </div>
  );
}
