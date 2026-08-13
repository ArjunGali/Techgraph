// One color identity per node label, used consistently by badges and both
// SVG visualizations. Hex values are needed because SVG fills can't use
// Tailwind utility classes.
export const ENTITY_LABELS = ['Skill', 'Technology', 'Concept', 'Job', 'Company', 'Course'];

export const LABEL_STYLES = {
  Skill: { badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', dot: '#34d399' },
  Technology: { badge: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30', dot: '#818cf8' },
  Concept: { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: '#fbbf24' },
  Job: { badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30', dot: '#fb7185' },
  Company: { badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30', dot: '#38bdf8' },
  Course: { badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30', dot: '#a78bfa' },
};

export const truncate = (text, max = 18) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
