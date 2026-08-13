// Typed service errors. Each carries the HTTP status the API layer should map
// it to, so controllers never need to inspect error messages.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export class DatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseError';
    this.status = 500;
  }
}

export class DatabaseUnavailableError extends DatabaseError {
  constructor(message) {
    super(message);
    this.name = 'DatabaseUnavailableError';
    this.status = 503;
  }
}
