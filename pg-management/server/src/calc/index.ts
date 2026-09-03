/**
 * The locked calculation engine.
 *
 * Everything under `src/calc` is pure: no database access, no clock, no
 * environment. Given the same stay history and the same administered rates it
 * always produces the same figures, which is what makes a historical bill
 * reproducible years later.
 *
 * Administered values — the EB rate, the common charge, rent prices — are
 * data, set by admins with effective dates and full history. The arithmetic
 * that consumes them lives here, is covered by the test suite, and is not
 * editable from the application by any role.
 */
export * from './dates.js';
export * from './money.js';
export * from './types.js';
export * from './occupancy.js';
export * from './eb.js';
export * from './rent.js';
export * from './bill.js';
export { ENGINE_VERSION } from './version.js';
