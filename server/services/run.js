// Shared query execution for all services: runs a read query, maps records
// to plain objects, and translates driver failures into typed service
// errors. The original error is logged server-side and never leaks.
import { readQuery, isConfigured } from '../config/db.js';
import { DatabaseError, DatabaseUnavailableError } from './errors.js';

export async function run(cypher, params) {
  if (!isConfigured()) {
    throw new DatabaseUnavailableError('The database is not configured.');
  }
  try {
    const records = await readQuery(cypher, params);
    return records.map((record) => record.toObject());
  } catch (err) {
    console.error('Query failed:', err.code || err.name, '-', err.message);
    if (err.code === 'ServiceUnavailable' || err.code === 'SessionExpired') {
      throw new DatabaseUnavailableError('The database is unreachable.');
    }
    throw new DatabaseError('The query could not be completed.');
  }
}
