import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api.js';
import { ENTITY_LABELS } from '../utils/labels.js';
import Badge from './Badge.jsx';

// Form control for choosing one entity as a (label, name) pair — the
// unambiguous identifier every path endpoint requires. With `fixedLabel` the
// type dropdown is hidden; suggestions come from /api/search filtered to the
// active label. With `clearOnSelect` the input resets after every pick (used
// by the Path Builder multi-select). Keyboard: arrows move, Enter selects,
// Escape closes.
export default function EntityPicker({ id, title, fixedLabel, value, onChange, clearOnSelect = false }) {
  const [label, setLabel] = useState(fixedLabel ?? 'Skill');
  const [term, setTerm] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);
  const activeLabel = fixedLabel ?? label;

  useEffect(() => {
    const query = term.trim();
    if (query === '' || (value && query === value.name)) {
      setSuggestions(null);
      setError(null);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api.search(query)
        .then((body) => { setSuggestions(body.results.filter((r) => r.label === activeLabel)); setError(null); })
        .catch((err) => { setSuggestions(null); setError(err); })
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [term, activeLabel, value]);

  useEffect(() => setActive(-1), [suggestions]);
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
    setTerm(clearOnSelect ? '' : entity.name);
    setOpen(false);
    onChange(entity);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open || !suggestions?.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(suggestions[active >= 0 ? active : 0]);
    }
  };

  const showPanel = open && (searching || error || suggestions);

  return (
    <div ref={boxRef} className="relative">
      {title && <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-300">{title}</label>}
      <div className="flex gap-2">
        {!fixedLabel && (
          <select
            value={label}
            onChange={(event) => { setLabel(event.target.value); setTerm(''); onChange(null); }}
            aria-label={`${title ?? 'Entity'} type`}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2.5 text-sm text-slate-200 focus:border-indigo-400 focus:outline-none"
          >
            {ENTITY_LABELS.map((l) => <option key={l}>{l}</option>)}
          </select>
        )}
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={Boolean(showPanel)}
          aria-controls={`${id}-listbox`}
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          value={term}
          onChange={(event) => { setTerm(event.target.value); setOpen(true); if (value) onChange(null); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={`Type to find a ${activeLabel.toLowerCase()}…`}
          className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
        />
      </div>
      {showPanel && (
        <div
          id={`${id}-listbox`}
          role="listbox"
          aria-label={`${activeLabel} suggestions`}
          className="absolute z-20 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-xl shadow-black/40"
        >
          {searching && <p className="p-3 text-sm text-slate-400">Searching…</p>}
          {!searching && error && <p className="p-3 text-sm text-rose-300">{error.message}</p>}
          {!searching && !error && suggestions?.length === 0 && (
            <p className="p-3 text-sm text-slate-400">No {activeLabel.toLowerCase()} matches “{term.trim()}”.</p>
          )}
          {!searching && !error && suggestions?.map((entity, index) => (
            <button
              key={entity.name}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={index === active}
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => { event.preventDefault(); pick(entity); }}
              onMouseEnter={() => setActive(index)}
              className={`flex w-full items-center gap-2 px-3 py-2.5 text-left ${
                index === active ? 'bg-slate-800/70' : 'hover:bg-slate-800/60'
              }`}
            >
              <Badge label={entity.label} />
              <span className="text-sm text-slate-100">{entity.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
