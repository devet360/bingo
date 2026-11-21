import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AppError, Errors } from '../lib/errors';

const CatalogueEntrySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(64),
  thumbnailPath: z.string().startsWith('/api/catalogue/games/'),
});

const CatalogueResponseSchema = z.object({
  data: z.object({
    availableGames: z.array(CatalogueEntrySchema),
  }),
});

export async function fetchProviderGameCatalogue(code: string) {
  const provider = await prisma.gameProvider.findUnique({
    where: { code },
    select: { code: true, apiBaseUrl: true },
  });
  if (!provider) throw Errors.notFound('Game provider');
  if (!provider.apiBaseUrl) {
    throw Errors.badRequest('Configure the provider API base URL first', 'PROVIDER_URL_REQUIRED');
  }
  const apiBaseUrl = provider.apiBaseUrl;

  const url = new URL('/api/catalogue', apiBaseUrl);
  url.searchParams.set('operator', provider.code);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  } catch {
    throw new AppError(502, 'PROVIDER_CATALOGUE_UNAVAILABLE', 'Could not reach the games provider catalogue');
  }
  if (!response.ok) {
    throw new AppError(502, 'PROVIDER_CATALOGUE_UNAVAILABLE', `Games provider returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'PROVIDER_CATALOGUE_INVALID', 'Games provider returned invalid catalogue JSON');
  }
  const parsed = CatalogueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(502, 'PROVIDER_CATALOGUE_INVALID', 'Games provider returned an unsupported catalogue shape');
  }

  return parsed.data.data.availableGames.map((game) => ({
    ...game,
    thumbnailUrl: new URL(game.thumbnailPath, apiBaseUrl).toString(),
  }));
}
