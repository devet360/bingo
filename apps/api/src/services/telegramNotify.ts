import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * Fire-and-forget Bot API call. The token lives in the URL, so errors are
 * reduced to a status code before logging.
 */
export async function sendTelegramMessage(telegramId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, telegramId }, 'telegram push rejected');
      return false;
    }
    return true;
  } catch (error) {
    logger.warn({ err: error, telegramId }, 'telegram push failed');
    return false;
  }
}
