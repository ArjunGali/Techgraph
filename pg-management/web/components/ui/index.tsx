'use client';

import { useEffect, type ReactNode } from 'react';
import { useElementWidth, useLayoutShape } from '@/lib/useMediaQuery';

/** Joins class names, dropping anything falsy. */
export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
export function Card({
  children, className, padded = true,
}: {
  children: ReactNode; className?: string; padded?: boolean;
}) {
  return (
    <div
      className={cx(
        'rounded-xl border border-border bg-surface-raised',
        // Compact on phones, roomier once there is width to spend.
        padded && 'p-4 sm:p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionHeading({
  title, subtitle, action,
}: {
  title: string; subtitle?: string; action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold sm:text-lg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-sm text-content-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A single figure.
 *
 * Two per row on the smallest phones so nothing is cramped, then progressively
 * more across as the screen widens — the grid is set by the parent.
 */
export function Stat({
  label, value, hint, tone = 'default',
}: {
  label: string; value: string; hint?: string;
  tone?: 'default' | 'positive' | 'caution' | 'critical';
}) {
  const toneClass = {
    default: 'text-content',
    positive: 'text-positive',
    caution: 'text-caution',
    critical: 'text-critical',
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-3 sm:p-4">
      <p className="truncate text-xs font-medium uppercase tracking-wide text-content-muted">
        {label}
      </p>
      <p className={cx('mt-1 text-xl font-semibold tabular-nums sm:text-2xl', toneClass)}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-content-muted">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  children, tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'positive' | 'caution' | 'critical' | 'brand';
}) {
  const tones = {
    neutral: 'bg-surface-sunken text-content-muted',
    positive: 'bg-positive/15 text-positive',
    caution: 'bg-caution/15 text-caution',
    critical: 'bg-critical/15 text-critical',
    brand: 'bg-brand/15 text-brand',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
/** Every interactive control is at least 48px tall, comfortably tappable. */
export function Button({
  children, onClick, type = 'button', variant = 'primary', size = 'md',
  disabled, fullWidth, className,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  fullWidth?: boolean;
  className?: string;
}) {
  const variants = {
    primary: 'bg-brand text-brand-contrast hover:opacity-90 active:opacity-80',
    secondary: 'border border-border bg-surface-raised text-content hover:bg-surface-sunken',
    ghost: 'text-content hover:bg-surface-sunken',
    danger: 'bg-critical text-white hover:opacity-90',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'min-h-tap px-3 text-sm' : 'min-h-tap px-4 text-sm sm:text-base',
        fullWidth && 'w-full',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label, children, hint, error,
}: {
  label: string; children: ReactNode; hint?: string; error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-content-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-critical">{error}</span> : null}
    </label>
  );
}

const controlClass =
  'w-full min-h-tap rounded-lg border border-border bg-surface-raised px-3 text-base ' +
  'text-content placeholder:text-content-muted focus:border-brand focus:outline-none';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  // 16px minimum stops Android zooming the viewport when a field is focused.
  return <input {...props} className={cx(controlClass, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(controlClass, 'appearance-none', props.className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(controlClass, 'min-h-24 py-2', props.className)} />;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------
/**
 * A modal that presents itself the way the platform expects for the screen it
 * is on: a bottom sheet that slides up under the thumb on a phone, a centred
 * dialog on a tablet. One component, one set of children.
 */
export function Sheet({
  open, onClose, title, children, footer,
}: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode;
}) {
  const { isPhone } = useLayoutShape();

  // The page behind must not scroll while the sheet is up.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cx(
        'fixed inset-0 z-50 flex bg-black/50',
        isPhone ? 'items-end' : 'items-center justify-center p-6',
      )}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={cx(
          'flex w-full flex-col bg-surface-raised',
          isPhone
            ? 'max-h-[92vh] rounded-t-2xl pb-safe-bottom'
            : 'max-h-[85vh] max-w-2xl rounded-2xl border border-border shadow-2xl',
        )}
      >
        {isPhone ? (
          <div className="flex justify-center pt-2" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-border" />
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h2 className="text-base font-semibold sm:text-lg">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-tap min-h-tap w-tap min-w-tap items-center justify-center rounded-lg text-content-muted hover:bg-surface-sunken"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>

        {footer ? (
          <div className="border-t border-border px-4 py-3 sm:px-5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-content-muted">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-brand"
        aria-hidden
      />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="text-center">
      <p className="text-sm text-critical">{message}</p>
      {onRetry ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function EmptyState({
  title, message, action,
}: {
  title: string; message?: string; action?: ReactNode;
}) {
  return (
    <Card className="text-center">
      <p className="font-medium">{title}</p>
      {message ? <p className="mt-1 text-sm text-content-muted">{message}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </Card>
  );
}

/**
 * Tabular data.
 *
 * On a phone each row becomes a stacked card — a wide table would force
 * horizontal scrolling, which the app never does. From small tablets upward
 * the same data renders as a real table, which is what the extra width is for.
 */
export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Shown in the phone card's header line rather than as a labelled field. */
  primary?: boolean;
  align?: 'left' | 'right';
  /** Hidden below large tablets, for detail that only fits on a big screen. */
  wideOnly?: boolean;
};

export function DataTable<T>({
  columns, rows, keyOf, onRowClick, empty,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
}) {
  // Measured against the container, not the window: the same table renders as
  // cards inside a narrow master pane on a tablet and as a full table when it
  // has the page to itself, without either arrangement being clipped.
  const [ref, width] = useElementWidth<HTMLElement>();

  // Until the first measurement lands, fall back to the viewport shape so the
  // first paint is not a flash of the wrong arrangement.
  const { isTablet, isWide } = useLayoutShape();
  const measured = width > 0;
  const asTable = measured ? width >= 560 : isTablet;
  const showWideColumns = measured ? width >= 860 : isWide;

  if (rows.length === 0) {
    return <div ref={ref}>{empty ?? <EmptyState title="Nothing to show" />}</div>;
  }

  if (!asTable) {
    const primary = columns.find((column) => column.primary) ?? columns[0]!;
    const rest = columns.filter((column) => column !== primary && !column.wideOnly);

    return (
      <ul ref={ref} className="space-y-2">
        {rows.map((row) => (
          <li key={keyOf(row)}>
            <button
              type="button"
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cx(
                'w-full rounded-xl border border-border bg-surface-raised p-3 text-left',
                onRowClick && 'active:bg-surface-sunken',
              )}
            >
              <div className="font-medium">{primary.render(row)}</div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 xs:grid-cols-3">
                {rest.map((column) => (
                  <div key={column.key} className="min-w-0">
                    <dt className="truncate text-xs text-content-muted">{column.header}</dt>
                    <dd className="truncate text-sm tabular-nums">{column.render(row)}</dd>
                  </div>
                ))}
              </dl>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  const visible = columns.filter((column) => showWideColumns || !column.wideOnly);

  return (
    <div ref={ref} className="scroll-x rounded-xl border border-border">
      <table className="w-full min-w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-sunken">
            {visible.map((column) => (
              <th
                key={column.key}
                className={cx(
                  'px-3 py-2 font-medium text-content-muted',
                  column.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={keyOf(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cx(
                'border-b border-border last:border-0',
                onRowClick && 'cursor-pointer hover:bg-surface-sunken',
              )}
            >
              {visible.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    'px-3 py-2.5',
                    column.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
