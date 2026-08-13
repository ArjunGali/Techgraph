import { ValidationError } from '../services/errors.js';

// Controllers name the exact query parameter in the error message; deeper
// validation (label whitelists, requirement levels, entity existence) stays
// in the service layer.
export function requireQuery(req, key) {
  const value = req.query[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Query parameter "${key}" is required`);
  }
  return value.trim();
}
