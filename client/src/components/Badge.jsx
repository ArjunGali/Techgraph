import { LABEL_STYLES } from '../utils/labels.js';

// Small colored tag identifying a node label (Skill, Technology, …).
export default function Badge({ label }) {
  const style = LABEL_STYLES[label]?.badge ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}
