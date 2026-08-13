// Central error handling. Typed service errors carry their own HTTP status
// and a user-safe message; anything else is unexpected, gets logged with its
// stack server-side, and leaves as a generic 500 — stack traces never reach
// the client.

export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Express 5 forwards rejected promises from async handlers here
// automatically — controllers need no try/catch.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const isTyped = Number.isInteger(err.status);
  if (!isTyped) console.error('Unhandled error:', err);
  res.status(isTyped ? err.status : 500).json({
    error: isTyped ? err.message : 'Something went wrong on our side. Please try again.',
  });
}
