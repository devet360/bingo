import rateLimit from 'express-rate-limit';

const message = {
  error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down and try again shortly' },
};

export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});

export const otpLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});

/** Money endpoints are cheap per call but must not be scriptable at speed. */
export const moneyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});
