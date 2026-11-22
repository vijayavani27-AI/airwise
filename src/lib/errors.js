/** Typed errors so the HTTP layer can map failures to safe, consistent responses. */

export class AppError extends Error {
  /**
   * @param {string} message - safe, user-facing message
   * @param {number} status - HTTP status code
   */
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.expose = true;
  }
}

export class ValidationError extends AppError {
  /** @param {string[]} details */
  constructor(details) {
    super('Invalid request', 400);
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404);
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'An upstream data service is unavailable. Please try again shortly.') {
    super(message, 502);
  }
}
