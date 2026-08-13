// Single import surface for the query layer, plus shared schema constants.
export * from './explore.queries.js';
export * from './career.queries.js';
export * from './paths.queries.js';
export * from './builder.queries.js';

// The only labels that exist in the graph. The service layer validates every
// caller-supplied label against this list before it reaches a query.
export const ENTITY_LABELS = ['Skill', 'Technology', 'Concept', 'Job', 'Company', 'Course'];

// The only values REQUIRES.level can hold (see docs/DATA_MODEL.md).
export const REQUIREMENT_LEVELS = ['core', 'nice-to-have'];
