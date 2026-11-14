export const dynamic = 'force-dynamic';

/**
 * Runtime configuration for Dokku: build once, set API_URL/SOCKET_URL later.
 * Served as a classic script so it runs before React hydrates.
 */
export function GET() {
  const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '';
  const socketUrl = process.env.SOCKET_URL ?? apiUrl;
  const botUsername = (process.env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');
  const body = `window.__BINGO_CONFIG__=${JSON.stringify({ apiUrl, socketUrl, botUsername })};`;
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
    },
  });
}
