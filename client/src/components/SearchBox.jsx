import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api.js';
import Badge from './Badge.jsx';

// Debounced global search over /api/search. Fully keyboard-operable:
// ArrowUp/ArrowDown move the highlight, Enter selects, Escape closes. The
// input is a combobox wired to the results listbox via aria-activedescendant.
export default function SearchBox({
  id = 'global-search',
  placeholder = 'Search skills, technologies, jobs…',
  onSelect,
  autoFocus = false,
}) {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null); // null = nothing searched yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);

  useEffect(() => {
    const query = term.trim();
    if (query === '') {
      setResults(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      api.search(query)
        .then((body) => { setResults(body.results); setError(null); })
        .catch((err) => { setResults(null); setError(err); })
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => setActive(-1), [results]);
  useEffect(() => {
    if (active >= 0) {
      document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [active, id]);

  useEffect(() => {
    const close = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (entity) => {
    if (!entity) return;
    setOpen(false);
    setTerm('');
    if (onSelect) onSelect(entity);
    else navigate(`/explorer/${encodeURIComponent(entity.label)}/${encodeURIComponent(entity.name)}`);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open || !results?.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(results[active >= 0 ? active : 0]);
    }
  };

  const showPanel = open && term.trim() !== '';

  return (
    <div ref={boxRef} className="relative">
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-label="Search the graph"
        value={term}
        autoFocus={autoFocus}
        onChange={(event) => { setTerm(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
      />
      {showPanel && (
        <div
          id={`${id}-listbox`}
          role="listbox"
          aria-label="Search results"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-xl shadow-black/40"
        >
          {loading && <p className="p-4 text-sm text-slate-400">Searching…</p>}
          {!loading && error && <p className="p-4 text-sm text-rose-300">{error.message}</p>}
          {!loading && !error && results?.length === 0 && (
            <p className="p-4 text-sm text-slate-400">No matches for “{term.trim()}”.</p>
          )}
          {!loading && !error && results?.map((entity, index) => (
            <button
              key={`${entity.label}:${entity.name}`}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={index === active}
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => { event.preventDefault(); pick(entity); }}
              onMouseEnter={() => setActive(index)}
              className={`flex w-full items-start gap-3 border-b border-slate-800 px-4 py-3 text-left last:border-b-0 ${
                index === active ? 'bg-slate-800/70' : 'hover:bg-slate-800/60'
              }`}
            >
              <Badge label={entity.label} />
              <span className="min-w-0">
                <span className="block font-medium text-slate-100">{entity.name}</span>
                <span className="block truncate text-sm text-slate-400">{entity.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
