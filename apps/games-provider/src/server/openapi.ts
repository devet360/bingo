const data = (schema: Record<string, unknown>) => ({
  type: 'object',
  properties: { data: schema },
});

const errorResponse = {
  description: 'Request failed',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
  },
};

const adminSecurity = [
  { providerAdminToken: [] },
  { providerConsoleToken: [] },
];

const operatorCode = {
  name: 'code',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 64 },
};

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const operatorPatch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    callbackUrl: { type: 'string', format: 'uri' },
    allowedOrigins: { type: 'array', maxItems: 32, items: { type: 'string', format: 'uri' } },
    localeDefault: { type: 'string', enum: ['en', 'am'] },
    limits: { $ref: '#/components/schemas/Limits' },
    enabledGames: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    theme: { type: 'object', nullable: true, additionalProperties: true },
    maintenance: { type: 'boolean' },
    botConfig: { $ref: '#/components/schemas/BotConfig' },
  },
};

const operatorInput = {
  ...operatorPatch,
  required: ['code', 'name', 'callbackUrl', 'allowedOrigins'],
  properties: {
    ...operatorPatch.properties,
    code: { type: 'string', minLength: 1, maxLength: 64 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
  },
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Games Provider API',
    version: '2.0.0',
    description:
      'Crash and Coin Flip games provider API. Amounts are integer minor units, ' +
      'serialized as decimal strings. Player sessions use a seamless-wallet callback ' +
      'to the operator; administrative endpoints require the bootstrap token or a ' +
      'short-lived signed provider-console token.',
  },
  servers: [{ url: '/', description: 'Current deployment' }],
  tags: [
    { name: 'Public', description: 'Health, catalogue, sessions, proofs and chat.' },
    { name: 'Provider administration', description: 'Protected operator and provider-owner operations.' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['Public'],
        summary: 'Check provider liveness',
        responses: {
          '200': {
            description: 'Provider is responding',
            content: { 'application/json': { schema: data({ type: 'object', properties: { status: { type: 'string', example: 'ok' }, game: { type: 'string', example: 'crash' } } }) } },
          },
        },
      },
    },
    '/api/catalogue': {
      get: {
        tags: ['Public'],
        summary: 'Read an operator game catalogue',
        parameters: [{ name: 'operator', in: 'query', schema: { type: 'string' }, description: 'Defaults to DEFAULT_OPERATOR_CODE.' }],
        responses: { '200': { description: 'Catalogue', content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Catalogue' } } } } } }, '404': errorResponse },
      },
    },
    '/api/catalogue/games/{gameId}/thumbnail.svg': {
      get: {
        tags: ['Public'],
        summary: 'Get the provider-owned game thumbnail',
        parameters: [{ name: 'gameId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'SVG image', content: { 'image/svg+xml': { schema: { type: 'string' } } } }, '404': errorResponse },
      },
    },
    '/api/sessions/handshake': {
      post: {
        tags: ['Public'],
        summary: 'Exchange a launch token for a provider game session',
        requestBody: jsonBody({
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string', format: 'uuid' },
            operator: { type: 'string', description: 'Defaults to DEFAULT_OPERATOR_CODE.' },
            game: { type: 'string', description: 'Provider game ID.' },
          },
        }),
        responses: { '200': { description: 'Session and signed wallet balance', content: { 'application/json': { schema: { $ref: '#/components/schemas/Handshake' } } } }, '400': errorResponse, '404': errorResponse, '410': errorResponse, '502': errorResponse },
      },
    },
    '/api/sessions/close': {
      post: {
        tags: ['Public'],
        summary: 'Close a provider session',
        requestBody: jsonBody({ type: 'object', required: ['token'], properties: { token: { type: 'string', format: 'uuid' } } }),
        responses: { '200': { description: 'Session closed', content: { 'application/json': { schema: data({ type: 'object', properties: { closed: { type: 'boolean', enum: [true] } } }) } } }, '400': errorResponse },
      },
    },
    '/api/rounds/{id}/proof': {
      get: {
        tags: ['Public'],
        summary: 'Read a finished round proof',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
        responses: { '200': { description: 'Provably-fair proof', content: { 'application/json': { schema: { $ref: '#/components/schemas/RoundProof' } } } }, '404': errorResponse, '409': errorResponse },
      },
    },
    '/api/chat/{roomId}': {
      get: {
        tags: ['Public'],
        summary: 'Read recent chat messages',
        parameters: [
          { name: 'roomId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'operator', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Recent chat messages' } },
      },
    },
    '/api/chat/messages': {
      post: {
        tags: ['Public'],
        summary: 'Post a message for an open game session',
        requestBody: jsonBody({ type: 'object', required: ['token', 'roomId', 'message'], properties: { token: { type: 'string', format: 'uuid' }, roomId: { type: 'string', maxLength: 64 }, message: { type: 'string', minLength: 1, maxLength: 2000 } } }),
        responses: { '201': { description: 'Message accepted' }, '400': errorResponse, '410': errorResponse },
      },
    },
    '/api/rain': {
      post: {
        tags: ['Public'],
        summary: 'Distribute a rain credit to active operator sessions',
        requestBody: jsonBody({ type: 'object', required: ['operator', 'amount', 'expiresAt'], properties: { operator: { type: 'string' }, amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Minor units.' }, expiresAt: { type: 'string', format: 'date-time' } } }),
        responses: { '201': { description: 'Rain event created' }, '400': errorResponse },
      },
    },
    '/api/admin/dashboard': {
      get: {
        tags: ['Provider administration'],
        summary: 'Read provider metrics and operator summaries',
        security: adminSecurity,
        responses: { '200': { description: 'Provider metrics' }, '401': errorResponse, '503': errorResponse },
      },
    },
    '/api/admin/operators': {
      get: {
        tags: ['Provider administration'],
        summary: 'List operators',
        security: adminSecurity,
        responses: { '200': { description: 'Operator records; secret values are never returned' }, '401': errorResponse },
      },
      post: {
        tags: ['Provider administration'],
        summary: 'Create a pending operator',
        description: 'The generated HMAC secret is returned once. Store it securely.',
        security: adminSecurity,
        requestBody: jsonBody(operatorInput),
        responses: { '201': { description: 'Operator and one-time secret created' }, '400': errorResponse, '401': errorResponse, '403': errorResponse, '409': errorResponse },
      },
    },
    '/api/admin/operators/{code}': {
      parameters: [operatorCode],
      get: {
        tags: ['Provider administration'],
        summary: 'Read operator configuration and secret metadata',
        security: adminSecurity,
        responses: { '200': { description: 'Operator details without secret material' }, '401': errorResponse, '404': errorResponse },
      },
      patch: {
        tags: ['Provider administration'],
        summary: 'Update operator configuration',
        security: adminSecurity,
        requestBody: jsonBody(operatorPatch),
        responses: { '200': { description: 'Updated operator' }, '400': errorResponse, '401': errorResponse, '404': errorResponse },
      },
      delete: {
        tags: ['Provider administration'],
        summary: 'Delete an operator only if suspended and without history',
        security: adminSecurity,
        responses: { '200': { description: 'Operator removed' }, '401': errorResponse, '403': errorResponse, '404': errorResponse, '409': errorResponse },
      },
    },
    '/api/admin/operators/{code}/status': {
      post: {
        tags: ['Provider administration'],
        summary: 'Change operator status',
        security: adminSecurity,
        parameters: [operatorCode],
        requestBody: jsonBody({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] } } }),
        responses: { '200': { description: 'Updated operator' }, '400': errorResponse, '409': errorResponse },
      },
    },
    '/api/admin/operators/{code}/probe': {
      post: {
        tags: ['Provider administration'],
        summary: 'Probe the operator wallet callback',
        security: adminSecurity,
        parameters: [operatorCode],
        responses: { '200': { description: 'Probe result' }, '400': errorResponse, '404': errorResponse },
      },
    },
    '/api/admin/operators/{code}/secrets': {
      post: {
        tags: ['Provider administration'],
        summary: 'Rotate the operator HMAC secret',
        description: 'Returns the new secret once and retains older active secrets until explicitly retired.',
        security: adminSecurity,
        parameters: [operatorCode],
        responses: { '201': { description: 'New secret and version' }, '401': errorResponse, '404': errorResponse },
      },
    },
    '/api/admin/operators/{code}/secrets/{version}/retire': {
      post: {
        tags: ['Provider administration'],
        summary: 'Retire a previous secret version',
        description: 'The newest secret cannot be retired; at least one active version must remain.',
        security: adminSecurity,
        parameters: [
          operatorCode,
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { '200': { description: 'Secret version retired' }, '400': errorResponse, '404': errorResponse, '409': errorResponse },
      },
    },
    '/api/admin/runtime-settings': {
      get: {
        tags: ['Provider administration'],
        summary: 'Read owner runtime settings',
        security: adminSecurity,
        responses: { '200': { description: 'Enabled games and simulation-bot configuration' }, '403': errorResponse, '404': errorResponse },
      },
      put: {
        tags: ['Provider administration'],
        summary: 'Update owner runtime settings',
        security: adminSecurity,
        requestBody: jsonBody({ type: 'object', required: ['botConfig', 'enabledGames'], properties: { botConfig: { $ref: '#/components/schemas/BotConfig' }, enabledGames: { type: 'array', minItems: 1, items: { type: 'string', enum: ['crash', 'coinflip'] } } } }),
        responses: { '200': { description: 'Settings saved' }, '400': errorResponse, '403': errorResponse, '404': errorResponse },
      },
    },
  },
  components: {
    securitySchemes: {
      providerAdminToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Provider-Admin-Token',
        description: 'Bootstrap/CLI token. Keep it server-side; never expose it in browser code.',
      },
      providerConsoleToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'HMAC-signed provider_console token',
        description: 'Short-lived scoped token issued by Bingo. Viewer is read-only; operator_admin is operator-scoped; superadmin can manage all operators.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
      },
      Limits: {
        type: 'object',
        required: ['minStake', 'maxStake', 'maxWin', 'maxBetsPerRound'],
        properties: {
          minStake: { type: 'string', pattern: '^[0-9]+$', description: 'Minor units.' },
          maxStake: { type: 'string', pattern: '^[0-9]+$', description: 'Minor units.' },
          maxWin: { type: 'string', pattern: '^[0-9]+$', description: 'Minor units.' },
          maxBetsPerRound: { type: 'integer', minimum: 1 },
        },
      },
      BotConfig: {
        type: 'object',
        required: ['enabled', 'count', 'stakeMin', 'stakeMax', 'roundPayoutCap', 'dayPayoutCap', 'disclose'],
        properties: {
          enabled: { type: 'boolean' },
          count: { type: 'integer', minimum: 0, maximum: 100 },
          stakeMin: { type: 'string', pattern: '^[0-9]+$' },
          stakeMax: { type: 'string', pattern: '^[0-9]+$' },
          roundPayoutCap: { type: 'string', pattern: '^[0-9]+$' },
          dayPayoutCap: { type: 'string', pattern: '^[0-9]+$' },
          disclose: { type: 'boolean', enum: [true] },
        },
      },
      Catalogue: {
        type: 'object',
        properties: {
          operator: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
          currency: { type: 'string' },
          localeDefault: { type: 'string', enum: ['en', 'am'] },
          games: { type: 'array', items: { type: 'string' } },
          availableGames: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, thumbnailPath: { type: 'string' } } } },
          limits: { $ref: '#/components/schemas/Limits' },
          theme: { type: 'object', nullable: true },
        },
      },
      Handshake: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', format: 'uuid' },
              operator: { type: 'string' },
              gameId: { type: 'string' },
              currency: { type: 'string' },
              balance: { type: 'string', description: 'Minor units.' },
              limits: { $ref: '#/components/schemas/Limits' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      RoundProof: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              roundId: { type: 'integer' },
              gameId: { type: 'string', enum: ['crash', 'coinflip'] },
              serverSeed: { type: 'string' },
              serverSeedHash: { type: 'string' },
              clientSeedComposite: { type: 'string' },
              crashPoint: { type: 'number', nullable: true },
              outcome: { type: 'string', enum: ['HEADS', 'TAILS'] },
              startedAt: { type: 'string', format: 'date-time' },
              crashedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
      },
    },
  },
  'x-websocket': {
    url: '/ws',
    description: 'Game socket for auth, bet:place, bet:cancel, and bet:cashout events. Authenticate with the launch token; see the integration guide.',
  },
} as const;
