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
    throw new AppError(
      502,
      'PROVIDER_CATALOGUE_UNAVAILABLE',
      'Could not reach the configured Games Provider API URL.',
    );
  }
  if (!response.ok) {
    let remoteCode: string | undefined;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const remoteError = body.error;
        if (typeof remoteError === 'object' && remoteError !== null
          && 'code' in remoteError && typeof remoteError.code === 'string') {
          remoteCode = remoteError.code;
        }
      }
    } catch {
      remoteCode = undefined;
    }
    if (response.status === 404 && remoteCode === 'OPERATOR_NOT_FOUND') {
      throw new AppError(
        409,
        'PROVIDER_OPERATOR_NOT_CONFIGURED',
        `Games Provider has no operator named "${provider.code}". Create that operator and enable its games; the Bingo provider code must match the Games Provider operator code.`,
      );
    }
    if (response.status === 404) {
      throw new AppError(
        502,
        'PROVIDER_CATALOGUE_ENDPOINT_MISSING',
        'Games Provider catalogue endpoint was not found. Deploy the current Games Provider version and verify its public API base URL.',
      );
    }
    throw new AppError(
      502,
      'PROVIDER_CATALOGUE_UNAVAILABLE',
      `Games Provider returned HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'PROVIDER_CATALOGUE_INVALID', 'Games provider returned invalid catalogue JSON');
  }
  const parsed = CatalogueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      502,
      'PROVIDER_CATALOGUE_VERSION_UNSUPPORTED',
      'Games Provider does not expose game metadata yet. Deploy the current Games Provider version.',
    );
  }

  return parsed.data.data.availableGames.map((game) => ({
    ...game,
    thumbnailUrl: new URL(game.thumbnailPath, apiBaseUrl).toString(),
  }));
}
