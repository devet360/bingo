export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message: string, code = 'BAD_REQUEST', details?: unknown) =>
    new AppError(400, code, message, details),
  unauthorized: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'You are not allowed to perform this action', code = 'FORBIDDEN') =>
    new AppError(403, code, message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (message: string, code = 'CONFLICT') => new AppError(409, code, message),
  gone: (message: string, code = 'GONE') => new AppError(410, code, message),
  insufficientFunds: (account: string, available: bigint, required: bigint) =>
    new AppError(
      409,
      'INSUFFICIENT_FUNDS',
      `Insufficient ${account.toLowerCase()} balance`,
      { available: available.toString(), required: required.toString() },
    ),
  tooManyRequests: (message = 'Too many requests') =>
    new AppError(429, 'RATE_LIMITED', message),
  internal: (message = 'Internal server error') =>
    new AppError(500, 'INTERNAL_ERROR', message),
};
