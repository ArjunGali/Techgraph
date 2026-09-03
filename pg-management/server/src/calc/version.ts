/**
 * Version of the calculation engine.
 *
 * Stamped onto every bill and EB calculation that is stored. If the formula
 * ever has to change, the version is bumped and old bills keep the version
 * they were computed with, so a historical figure can always be traced back to
 * the exact logic that produced it.
 */
export const ENGINE_VERSION = 'calc-1.0.0';
