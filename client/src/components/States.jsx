// The three shared view states every data-driven section uses.

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const offline = error?.status === 503 || error?.status === 0;
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6" role="alert">
      <p className="font-medium text-rose-300">{offline ? 'Database unavailable' : 'Something went wrong'}</p>
      <p className="mt-1 text-sm text-slate-400">{error?.message ?? 'Unexpected error.'}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-rose-500/15 px-4 py-2 text-sm font-medium text-rose-200 hover:bg-rose-500/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-400"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center">
      <p className="font-medium text-slate-300">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
    </div>
  );
}
