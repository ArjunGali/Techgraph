// The only place the frontend talks to the backend. Every function returns
// parsed JSON or throws an ApiError with a user-safe message and the HTTP
// status — components never touch fetch, URLs, or encoding directly.
// In dev the Vite proxy forwards /api to the Express server; in production
// VITE_API_URL points at the deployed backend.
const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = network failure (server unreachable)
  }
}

async function request(path) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`);
  } catch {
    throw new ApiError('Cannot reach the TechGraph server. Check your connection and try again.', 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (HTTP ${res.status})`, res.status);
  }
  return body;
}

const seg = encodeURIComponent; // path segments (handles names like "CI/CD")
const qs = (params) => new URLSearchParams(params).toString();

export const api = {
  stats: () => request('/stats'),
  search: (q) => request(`/search?${qs({ q })}`),
  entity: (label, name) => request(`/entities/${seg(label)}/${seg(name)}`),
  relationships: (label, name) => request(`/entities/${seg(label)}/${seg(name)}/relationships`),
  jobsRequiring: (skill) => request(`/jobs/requiring/${seg(skill)}`),
  relatedTechnologies: (name) => request(`/technologies/${seg(name)}/related`),
  careerPath: (skill) => request(`/career-path?${qs({ skill })}`),
  studyPath: (skill) => request(`/study-path?${qs({ skill })}`),
  employersForSkill: (skill, level) => request(`/employers-for-skill?${qs({ skill, level })}`),
  connectionPath: (from, to) =>
    request(`/connection-path?${qs({ fromLabel: from.label, fromName: from.name, toLabel: to.label, toName: to.name })}`),
  careerBuilder: (skills, job) => {
    const params = new URLSearchParams({ job });
    for (const skill of skills) params.append('skills', skill);
    return request(`/career-builder?${params}`);
  },
};

// The health endpoint intentionally answers 503 when the database is down,
// so it gets its own non-throwing helper for the status indicator.
export async function healthStatus() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    const body = await res.json().catch(() => null);
    return { online: res.ok, database: body?.database ?? 'unknown' };
  } catch {
    return { online: false, database: 'unreachable' };
  }
}
