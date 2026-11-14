import { createHmac } from 'node:crypto';
import { AppError } from '../lib/errors';
import { constantTimeEqualHex } from '../lib/crypto';

export interface TelegramInitUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface VerifiedTelegramInit {
  user: TelegramInitUser;
  authDate: Date;
  queryId?: string;
  startParam?: string;
  fields: Record<string, string>;
}

function dataCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
}

function computeHash(botToken: string, fields: Record<string, string>): string {
  // secret_key = HMAC_SHA256(key = "WebAppData", msg = bot_token)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString(fields)).digest('hex');
}

/**
 * Validates Telegram WebApp initData per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Accepts both the classic HMAC scheme and clients that also sign the newer
 * `signature` field, which some SDK versions exclude from the check string.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now: Date = new Date(),
): VerifiedTelegramInit {
  if (!initData || typeof initData !== 'string') {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_MISSING', 'Telegram initData is required');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData hash is missing or malformed');
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key !== 'hash') fields[key] = value;
  }

  const withSignature = computeHash(botToken, fields);
  const withoutSignature = fields.signature
    ? computeHash(botToken, Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'signature')))
    : withSignature;

  if (!constantTimeEqualHex(withSignature, hash) && !constantTimeEqualHex(withoutSignature, hash)) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData signature does not match');
  }

  const authDateRaw = fields.auth_date;
  if (!authDateRaw) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData auth_date is missing');
  }
  const authDateSeconds = Number(authDateRaw);
  if (!Number.isFinite(authDateSeconds)) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData auth_date is malformed');
  }

  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateSeconds;
  if (ageSeconds > maxAgeSeconds) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_EXPIRED', 'initData has expired, reopen the app');
  }
  if (ageSeconds < -60) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData auth_date is in the future');
  }

  let user: TelegramInitUser;
  try {
    user = JSON.parse(fields.user ?? '') as TelegramInitUser;
  } catch {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData user payload is malformed');
  }
  if (!user || typeof user.id !== 'number' || !user.first_name) {
    throw new AppError(401, 'TELEGRAM_INIT_DATA_INVALID', 'initData user payload is incomplete');
  }

  return {
    user,
    authDate: new Date(authDateSeconds * 1000),
    queryId: fields.query_id,
    startParam: fields.start_param,
    fields,
  };
}
