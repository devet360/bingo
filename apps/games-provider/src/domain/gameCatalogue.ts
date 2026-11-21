export interface ProviderGameDefinition {
  id: string;
  name: string;
  category: string;
  thumbnailPath: string;
}

export const PROVIDER_GAMES: readonly ProviderGameDefinition[] = [
  {
    id: 'crash',
    name: 'Crash',
    category: 'Crash',
    thumbnailPath: '/api/catalogue/games/crash/thumbnail.svg',
  },
  {
    id: 'coinflip',
    name: 'Coin Flip',
    category: 'Table',
    thumbnailPath: '/api/catalogue/games/coinflip/thumbnail.svg',
  },
];

const THUMBNAILS: Record<string, string> = {
  crash: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#142d39"/><stop offset="1" stop-color="#10121b"/></linearGradient><linearGradient id="g"><stop stop-color="#4be0ad"/><stop offset="1" stop-color="#ffd36f"/></linearGradient></defs><rect width="640" height="360" rx="32" fill="url(#b)"/><path d="M56 286 184 238l98 20 112-116 76 25 116-111" fill="none" stroke="url(#g)" stroke-linecap="round" stroke-linejoin="round" stroke-width="14"/><circle cx="470" cy="167" r="13" fill="#ffd36f"/><text x="54" y="94" fill="#fff" font-family="Arial,sans-serif" font-size="54" font-weight="700">CRASH</text></svg>`,
  coinflip: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#312446"/><stop offset="1" stop-color="#10121b"/></linearGradient><linearGradient id="c"><stop stop-color="#ffe28a"/><stop offset="1" stop-color="#dfa944"/></linearGradient></defs><rect width="640" height="360" rx="32" fill="url(#b)"/><circle cx="320" cy="190" r="106" fill="url(#c)" stroke="#fff1bc" stroke-width="8"/><circle cx="320" cy="190" r="83" fill="none" stroke="#9c6722" stroke-width="4"/><text x="320" y="210" fill="#39240b" font-family="Arial,sans-serif" font-size="70" font-weight="700" text-anchor="middle">50/50</text><text x="54" y="80" fill="#fff" font-family="Arial,sans-serif" font-size="42" font-weight="700">COIN FLIP</text></svg>`,
};

export function getProviderGameThumbnail(id: string): string | null {
  return THUMBNAILS[id] ?? null;
}
