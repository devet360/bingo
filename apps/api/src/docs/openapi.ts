const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
  },
});

const ok = (schema: Record<string, unknown>, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

const dataRef = (name: string) => ({
  type: 'object',
  properties: { data: { $ref: `#/components/schemas/${name}` } },
});

const dataArrayRef = (name: string) => ({
  type: 'object',
  properties: { data: { type: 'array', items: { $ref: `#/components/schemas/${name}` } } },
});

const idParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
});

const pageParam = {
  name: 'page',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 0, default: 0 },
};

const money = { type: 'string', pattern: '^-?\\d+$', description: 'Minor units (1 credit = 100)' };

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Bingo Hall API',
    version: '1.0.0',
    description:
      'REST + Socket.io API for the Bingo Hall Telegram Mini App, agent network and staff dashboards. ' +
      'Money is always an integer number of minor units rendered as a decimal string. ' +
      'Player signup happens only through the Telegram bot (`/start` → share contact). ' +
      'Staff (agent, support, super admin) sign in here with email/phone + password.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'Auth' },
    { name: 'Player wallet' },
    { name: 'Public agents' },
    { name: 'Agent portal' },
    { name: 'Bingo' },
    { name: 'Support' },
    { name: 'Admin' },
    { name: 'Ops' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      idempotency: {
        type: 'apiKey',
        in: 'header',
        name: 'Idempotency-Key',
        description: 'Scoped per caller; replays return the original result with `replayed: true`.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'INSUFFICIENT_FUNDS' },
              message: { type: 'string' },
              details: { nullable: true },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          telegramId: { type: 'string', nullable: true },
          telegramUsername: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true, example: '+251912345678' },
          phoneVerified: { type: 'boolean' },
          phoneVerifiedAt: { type: 'string', format: 'date-time', nullable: true },
          email: { type: 'string', nullable: true },
          displayName: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          locale: { type: 'string', enum: ['en', 'am'] },
          role: { type: 'string', enum: ['PLAYER', 'AGENT', 'SUPPORT', 'SUPER_ADMIN'] },
          status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED'] },
          kycStatus: { type: 'string' },
          referralCode: { type: 'string' },
          hasPassword: { type: 'boolean' },
          mustChangePassword: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Wallet: {
        type: 'object',
        properties: {
          available: money,
          escrow: money,
          locked: money,
          lifetimeDeposited: money,
          lifetimeWithdrawn: money,
          lifetimeWagered: money,
          lifetimeWon: money,
        },
      },
      Agent: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          agentCode: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] },
          tier: { type: 'string', enum: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] },
          region: { type: 'string' },
          city: { type: 'string', nullable: true },
          district: { type: 'string', nullable: true },
          isOnline: { type: 'boolean' },
          ratingAvg: { type: 'string' },
          ratingCount: { type: 'integer' },
          completedDeposits: { type: 'integer' },
          completedWithdrawals: { type: 'integer' },
          floatAvailable: { ...money, nullable: true },
          floatEscrow: { ...money, nullable: true },
          commissionEarned: { ...money, nullable: true },
        },
      },
      Deposit: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          code: { type: 'string', example: '640911' },
          status: {
            type: 'string',
            enum: ['PENDING', 'PROCESSING', 'CREDITED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'DISPUTED'],
          },
          method: { type: 'string' },
          amount: money,
          creditedAmount: { ...money, nullable: true },
          agentProfileId: { type: 'string', nullable: true },
          externalRef: { type: 'string', nullable: true },
          expiresAt: { type: 'string', format: 'date-time' },
          settledAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Withdrawal: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          payoutCode: { type: 'string', example: '089664' },
          status: { type: 'string', enum: ['ESCROWED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'DISPUTED'] },
          method: { type: 'string' },
          amount: money,
          fee: money,
          netAmount: money,
          agentProfileId: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
          settledAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Room: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          code: { type: 'string', example: 'us75-10' },
          name: { type: 'string' },
          variant: { type: 'string', enum: ['US75', 'UK90'] },
          stakePerCard: money,
          maxCardsPerPlayer: { type: 'integer' },
          minPlayersToStart: { type: 'integer' },
          rakeBps: { type: 'integer' },
          allowedPatterns: { type: 'array', items: { type: 'string' } },
          status: { type: 'string' },
          timings: { type: 'object' },
        },
      },
      Round: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roomId: { type: 'string', format: 'uuid' },
          roundNumber: { type: 'integer' },
          status: {
            type: 'string',
            enum: ['WAITING', 'LOCKED', 'PLAYING', 'CLAIM_VERIFICATION', 'COMPLETED', 'CANCELLED'],
          },
          variant: { type: 'string' },
          stakePerCard: money,
          serverSeedHash: { type: 'string' },
          serverSeed: { type: 'string', nullable: true, description: 'Revealed after settlement' },
          clientSeed: { type: 'string', nullable: true },
          ballOrder: { type: 'array', items: { type: 'integer' }, nullable: true },
          drawnBalls: { type: 'array', items: { type: 'integer' } },
          currentBall: { type: 'integer', nullable: true },
          prizePool: money,
          winningPattern: { type: 'string', nullable: true },
          purchaseClosesAt: { type: 'string', format: 'date-time', nullable: true },
          claimsCloseAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Card: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roundId: { type: 'string', format: 'uuid' },
          cardIndex: { type: 'integer' },
          stake: money,
          variant: { type: 'string' },
          cells: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
          markedNumbers: { type: 'array', items: { type: 'integer' } },
          status: { type: 'string' },
          wonPattern: { type: 'string', nullable: true },
        },
      },
      Claim: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roundId: { type: 'string' },
          cardId: { type: 'string' },
          pattern: { type: 'string' },
          status: { type: 'string' },
          rejectionReason: { type: 'string', nullable: true },
        },
      },
      Ledger: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string' },
          refType: { type: 'string', nullable: true },
          refId: { type: 'string', nullable: true },
          memo: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                accountCode: { type: 'string' },
                ownerKind: { type: 'string' },
                ownerId: { type: 'string' },
                amount: money,
                balanceAfter: money,
              },
            },
          },
        },
      },
      Page: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          size: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      TelegramAuth: {
        type: 'object',
        required: ['initData'],
        properties: {
          initData: { type: 'string', description: 'Raw Telegram WebApp initData' },
          startParam: { type: 'string', description: 'Referral code from the deep link' },
        },
      },
      Login: {
        type: 'object',
        required: ['identifier', 'password'],
        properties: {
          identifier: { type: 'string', example: 'support@example.com' },
          password: { type: 'string', format: 'password' },
        },
      },
      PasswordChange: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', format: 'password' },
          newPassword: { type: 'string', format: 'password', minLength: 8 },
        },
      },
      Locale: {
        type: 'object',
        required: ['locale'],
        properties: { locale: { type: 'string', enum: ['en', 'am'] } },
      },
      StaffCreate: {
        type: 'object',
        required: ['role', 'displayName'],
        properties: {
          role: { type: 'string', enum: ['SUPPORT', 'AGENT', 'SUPER_ADMIN'] },
          displayName: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string', example: '+251912345678' },
          password: { type: 'string', minLength: 8, description: 'Temporary password; generated when omitted' },
          agent: {
            type: 'object',
            description: 'Required when role = AGENT',
            properties: {
              region: { type: 'string' },
              city: { type: 'string' },
              district: { type: 'string' },
            },
          },
        },
      },
      StatusPatch: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] } },
      },
      BuyCards: {
        type: 'object',
        required: ['quantity'],
        properties: {
          quantity: { type: 'integer', minimum: 1, maximum: 4 },
          clientSeed: { type: 'string', maxLength: 64 },
        },
      },
      ClaimSubmit: {
        type: 'object',
        required: ['cardId', 'pattern'],
        properties: {
          cardId: { type: 'string', format: 'uuid' },
          pattern: {
            type: 'string',
            enum: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
          },
        },
      },
      DepositCreate: {
        type: 'object',
        required: ['amount', 'method'],
        properties: {
          amount: { type: 'integer', minimum: 1, description: 'Minor units' },
          method: { type: 'string', enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH', 'CARD', 'CRYPTO'] },
          agentProfileId: { type: 'string', format: 'uuid' },
          paymentAccountId: { type: 'string', format: 'uuid' },
          playerNote: { type: 'string' },
          externalRef: { type: 'string' },
        },
      },
      WithdrawalCreate: {
        type: 'object',
        required: ['amount', 'method', 'agentProfileId'],
        properties: {
          amount: { type: 'integer', minimum: 1, description: 'Minor units' },
          method: { type: 'string' },
          agentProfileId: { type: 'string', format: 'uuid' },
          paymentAccountId: { type: 'string', format: 'uuid' },
          playerNote: { type: 'string' },
        },
      },
      Presence: {
        type: 'object',
        required: ['isOnline'],
        properties: { isOnline: { type: 'boolean' } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Ops'],
        summary: 'Liveness probe',
        security: [],
        responses: { '200': ok({ type: 'object', properties: { status: { type: 'string' } } }) },
      },
    },
    '/ready': {
      get: {
        tags: ['Ops'],
        summary: 'Readiness probe (Postgres reachable)',
        security: [],
        responses: {
          '200': ok({ type: 'object', properties: { status: { type: 'string' } } }),
          '503': errorResponse('Postgres unavailable'),
        },
      },
    },
    '/auth/telegram': {
      post: {
        tags: ['Auth'],
        summary: 'Player sign-in through the Telegram Mini App',
        description:
          'Creates the player on first launch. Playing and withdrawals additionally require a phone number shared with the bot.',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TelegramAuth' } } } },
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string' },
                  refreshToken: { type: 'string' },
                  accessTokenExpiresIn: { type: 'string' },
                  refreshExpiresAt: { type: 'string', format: 'date-time' },
                  user: { $ref: '#/components/schemas/User' },
                },
              },
            },
          }),
          '401': errorResponse('Invalid or expired initData'),
          '403': errorResponse('Staff accounts cannot use the Mini App (STAFF_WEB_ONLY)'),
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Disabled: players sign up in the Telegram bot',
        security: [],
        responses: { '403': errorResponse('REGISTRATION_DISABLED') },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Staff password login (agent, support, super admin)',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Login' } } } },
        responses: {
          '200': ok({ type: 'object', properties: { data: { type: 'object' } } }),
          '401': errorResponse('Invalid credentials'),
          '403': errorResponse('Player accounts cannot use web login (PLAYER_WEB_LOGIN_DISABLED)'),
        },
      },
    },
    '/auth/otp/request': {
      post: {
        tags: ['Auth'],
        summary: 'Request a staff OTP (existing accounts only)',
        security: [],
        responses: { '200': ok({ type: 'object', properties: { data: { type: 'object' } } }) },
      },
    },
    '/auth/otp/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify a staff OTP and issue a session',
        security: [],
        responses: {
          '200': ok({ type: 'object', properties: { data: { type: 'object' } } }),
          '401': errorResponse('Unknown account or bad code'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token',
        security: [],
        responses: { '200': ok({ type: 'object', properties: { data: { type: 'object' } } }) },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke the current session',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user, wallet and agent profile',
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  user: { $ref: '#/components/schemas/User' },
                  wallet: { $ref: '#/components/schemas/Wallet' },
                  agent: { allOf: [{ $ref: '#/components/schemas/Agent' }], nullable: true },
                },
              },
            },
          }),
          '401': errorResponse('Authentication required'),
        },
      },
    },
    '/auth/password': {
      post: {
        tags: ['Auth'],
        summary: 'Change the signed-in staff password',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PasswordChange' } } } },
        responses: { '200': ok({ type: 'object' }), '401': errorResponse('Wrong current password') },
      },
    },
    '/auth/locale': {
      patch: {
        tags: ['Auth'],
        summary: 'Persist the UI language',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Locale' } } } },
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/auth/link/telegram': {
      post: {
        tags: ['Auth'],
        summary: 'Attach a Telegram identity to the signed-in account',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TelegramAuth' } } } },
        responses: { '200': ok({ type: 'object' }), '409': errorResponse('Telegram already linked') },
      },
    },
    '/auth/link/phone': {
      post: {
        tags: ['Auth'],
        summary: 'Attach a phone number after OTP verification',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/wallet': {
      get: {
        tags: ['Player wallet'],
        summary: 'Player wallet balances',
        responses: { '200': ok(dataRef('Wallet')) },
      },
    },
    '/wallet/transactions': {
      get: {
        tags: ['Player wallet'],
        summary: 'Player ledger history',
        parameters: [pageParam],
        responses: { '200': ok(dataArrayRef('Ledger')) },
      },
    },
    '/wallet/deposits': {
      get: {
        tags: ['Player wallet'],
        summary: 'List my deposits',
        responses: { '200': ok(dataArrayRef('Deposit')) },
      },
      post: {
        tags: ['Player wallet'],
        summary: 'Open a deposit request and get a code for an agent',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DepositCreate' } } } },
        responses: { '201': ok(dataRef('Deposit')), '409': errorResponse('Duplicate request') },
      },
    },
    '/wallet/deposits/{id}': {
      get: {
        tags: ['Player wallet'],
        summary: 'Deposit status',
        parameters: [idParam('id')],
        responses: { '200': ok(dataRef('Deposit')), '404': errorResponse('Not found') },
      },
    },
    '/wallet/withdrawals': {
      get: {
        tags: ['Player wallet'],
        summary: 'List my withdrawals',
        responses: { '200': ok(dataArrayRef('Withdrawal')) },
      },
      post: {
        tags: ['Player wallet'],
        summary: 'Escrow credits and issue a payout code (phone verification required)',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WithdrawalCreate' } } } },
        responses: {
          '201': ok(dataRef('Withdrawal')),
          '403': errorResponse('PHONE_VERIFICATION_REQUIRED'),
          '409': errorResponse('WITHDRAWAL_OPEN / INSUFFICIENT_FUNDS'),
        },
      },
    },
    '/wallet/withdrawals/{id}/cancel': {
      post: {
        tags: ['Player wallet'],
        summary: 'Cancel a pending withdrawal and refund escrow',
        parameters: [idParam('id')],
        responses: { '200': ok(dataRef('Withdrawal')) },
      },
    },
    '/agents': {
      get: {
        tags: ['Public agents'],
        summary: 'Online/active agents for the player app',
        security: [],
        responses: { '200': ok(dataArrayRef('Agent')) },
      },
    },
    '/agents/{agentCode}': {
      get: {
        tags: ['Public agents'],
        summary: 'Agent profile with payment rails',
        security: [],
        parameters: [idParam('agentCode')],
        responses: { '200': ok(dataRef('Agent')), '404': errorResponse('Not found') },
      },
    },
    '/agent/me': {
      get: {
        tags: ['Agent portal'],
        summary: 'Agent profile, balances and queues summary',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/agent/presence': {
      post: {
        tags: ['Agent portal'],
        summary: 'Go online/offline',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Presence' } } } },
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/agent/deposits': {
      get: {
        tags: ['Agent portal'],
        summary: 'Deposit queue',
        responses: { '200': ok(dataArrayRef('Deposit')) },
      },
    },
    '/agent/deposits/{code}/claim': {
      post: {
        tags: ['Agent portal'],
        summary: 'Claim a deposit request by its 6-digit code',
        parameters: [idParam('code')],
        responses: { '200': ok(dataRef('Deposit')) },
      },
    },
    '/agent/deposits/{code}/credit': {
      post: {
        tags: ['Agent portal'],
        summary: 'Confirm cash received and credit the player (ledger DEPOSIT_CREDIT)',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        parameters: [idParam('code')],
        responses: { '200': ok(dataRef('Deposit')) },
      },
    },
    '/agent/deposits/{code}/reject': {
      post: {
        tags: ['Agent portal'],
        summary: 'Reject a claimed deposit',
        parameters: [idParam('code')],
        responses: { '200': ok(dataRef('Deposit')) },
      },
    },
    '/agent/withdrawals': {
      get: {
        tags: ['Agent portal'],
        summary: 'Payout queue',
        responses: { '200': ok(dataArrayRef('Withdrawal')) },
      },
    },
    '/agent/withdrawals/redeem': {
      post: {
        tags: ['Agent portal'],
        summary: 'Redeem a payout code after paying cash',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['payoutCode'],
                properties: { payoutCode: { type: 'string' }, note: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': ok(dataRef('Withdrawal')) },
      },
    },
    '/agent/commissions': {
      get: {
        tags: ['Agent portal'],
        summary: 'Commission history',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/agent/float-requests': {
      get: {
        tags: ['Agent portal'],
        summary: 'Float top-up requests',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/bingo/rooms': {
      get: {
        tags: ['Bingo'],
        summary: 'Lobby: rooms with the current round summary',
        security: [],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/bingo/rooms/{code}': {
      get: {
        tags: ['Bingo'],
        summary: 'Room detail and current round',
        security: [],
        parameters: [idParam('code')],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/bingo/rooms/{code}/history': {
      get: {
        tags: ['Bingo'],
        summary: 'Recent completed rounds',
        security: [],
        parameters: [idParam('code')],
        responses: { '200': ok(dataArrayRef('Round')) },
      },
    },
    '/bingo/rounds/{id}': {
      get: {
        tags: ['Bingo'],
        summary: 'Round state',
        security: [],
        parameters: [idParam('id')],
        responses: { '200': ok(dataRef('Round')) },
      },
    },
    '/bingo/rounds/{id}/verify': {
      get: {
        tags: ['Bingo'],
        summary: 'Provably fair proof (seeds revealed after settlement)',
        security: [],
        parameters: [idParam('id')],
        responses: {
          '200': ok({ type: 'object' }),
          '409': errorResponse('Round not finished'),
        },
      },
    },
    '/bingo/rounds/{id}/my-cards': {
      get: {
        tags: ['Bingo'],
        summary: 'My cards in a round',
        parameters: [idParam('id')],
        responses: { '200': ok(dataArrayRef('Card')) },
      },
    },
    '/bingo/rooms/{code}/cards': {
      post: {
        tags: ['Bingo'],
        summary: 'Buy cards for the current round (phone verification required)',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        parameters: [idParam('code')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BuyCards' } } } },
        responses: {
          '201': ok({ type: 'object', properties: { data: { type: 'object' }, replayed: { type: 'boolean' } } }),
          '403': errorResponse('PHONE_VERIFICATION_REQUIRED'),
          '409': errorResponse('SALES_CLOSED / INSUFFICIENT_FUNDS / CARD_LIMIT'),
        },
      },
    },
    '/bingo/rounds/{id}/claims': {
      post: {
        tags: ['Bingo'],
        summary: 'Submit a bingo claim',
        parameters: [idParam('id')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimSubmit' } } } },
        responses: { '201': ok(dataRef('Claim')), '409': errorResponse('Claim window closed') },
      },
    },
    '/support/users': {
      get: {
        tags: ['Support'],
        summary: 'Search players',
        description: 'SUPPORT and SUPER_ADMIN. Query by name, phone, email, Telegram username or referral code.',
        parameters: [
          { name: 'query', in: 'query', schema: { type: 'string' } },
          { name: 'role', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          pageParam,
        ],
        responses: {
          '200': ok({ type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/User' } }, page: { $ref: '#/components/schemas/Page' } } }),
          '403': errorResponse('ROLE_FORBIDDEN'),
        },
      },
    },
    '/support/users/{userId}': {
      get: {
        tags: ['Support'],
        summary: 'Player 360: wallet, transactions, deposits, withdrawals, counts',
        parameters: [idParam('userId')],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/support/users/{userId}/status': {
      post: {
        tags: ['Support'],
        summary: 'Freeze/unfreeze an account (sessions revoked on suspend)',
        parameters: [idParam('userId')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusPatch' } } } },
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/support/transactions': {
      get: {
        tags: ['Support'],
        summary: 'Ledger browser',
        parameters: [
          { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'kind', in: 'query', schema: { type: 'string' } },
          pageParam,
        ],
        responses: { '200': ok(dataArrayRef('Ledger')) },
      },
    },
    '/support/deposits': {
      get: {
        tags: ['Support'],
        summary: 'Deposit browser',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          pageParam,
        ],
        responses: { '200': ok(dataArrayRef('Deposit')) },
      },
    },
    '/support/deposits/{depositId}/cancel': {
      post: {
        tags: ['Support'],
        summary: 'Cancel an open deposit',
        parameters: [idParam('depositId')],
        responses: { '200': ok(dataRef('Deposit')) },
      },
    },
    '/support/withdrawals': {
      get: {
        tags: ['Support'],
        summary: 'Withdrawal browser',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          pageParam,
        ],
        responses: { '200': ok(dataArrayRef('Withdrawal')) },
      },
    },
    '/support/withdrawals/{withdrawalId}/cancel': {
      post: {
        tags: ['Support'],
        summary: 'Release a stuck escrow and refund the player',
        parameters: [idParam('withdrawalId')],
        responses: { '200': ok(dataRef('Withdrawal')) },
      },
    },
    '/support/agents': {
      get: {
        tags: ['Support'],
        summary: 'Agent directory with float and status',
        responses: { '200': ok(dataArrayRef('Agent')) },
      },
    },
    '/admin/overview': {
      get: {
        tags: ['Admin'],
        summary: 'Platform counters and wallet liabilities',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/admin/staff': {
      get: {
        tags: ['Admin'],
        summary: 'List staff accounts',
        parameters: [pageParam],
        responses: { '200': ok({ type: 'object' }) },
      },
      post: {
        tags: ['Admin'],
        summary: 'Create a staff account (temporary password returned once)',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffCreate' } } } },
        responses: { '201': ok({ type: 'object' }), '409': errorResponse('PHONE_TAKEN / EMAIL_TAKEN') },
      },
    },
    '/admin/staff/{userId}/status': {
      patch: {
        tags: ['Admin'],
        summary: 'Suspend or reactivate a staff member',
        parameters: [idParam('userId')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusPatch' } } } },
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/admin/staff/{userId}/reset-password': {
      post: {
        tags: ['Admin'],
        summary: 'Issue a new temporary password',
        parameters: [idParam('userId')],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/admin/audit': {
      get: {
        tags: ['Admin'],
        summary: 'Staff audit trail',
        parameters: [
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'actorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'entityType', in: 'query', schema: { type: 'string' } },
          pageParam,
        ],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/admin/agents': {
      get: {
        tags: ['Admin'],
        summary: 'All agents',
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }],
        responses: { '200': ok(dataArrayRef('Agent')) },
      },
      post: {
        tags: ['Admin'],
        summary: 'Attach an agent profile to a user',
        responses: { '201': ok(dataRef('Agent')) },
      },
    },
    '/admin/agents/{agentId}': {
      patch: {
        tags: ['Admin'],
        summary: 'Update agent status or tier',
        parameters: [idParam('agentId')],
        responses: { '200': ok(dataRef('Agent')) },
      },
    },
    '/admin/agents/{agentId}/float': {
      post: {
        tags: ['Admin'],
        summary: 'Pre-fund agent float from platform suspense',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        parameters: [idParam('agentId')],
        responses: { '201': ok({ type: 'object' }) },
      },
    },
    '/admin/reconciliation': {
      get: {
        tags: ['Admin'],
        summary: 'Ledger drift check (v_account_drift)',
        responses: { '200': ok({ type: 'object' }) },
      },
    },
  },
};
