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
    title: 'Bingo 251 API',
    version: '1.0.0',
    description:
      'REST + Socket.io API for the Bingo 251 Telegram Mini App, agent network and staff dashboards. ' +
      'Money is always an integer number of minor units rendered as a decimal string. ' +
      'Player signup happens only through the Telegram bot (`/start` → share contact). ' +
      'Staff (agent, support, super admin) sign in with email/phone + password, or open their dashboard in the ' +
      'Telegram Mini App once a super admin links their Telegram id.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'Auth' },
    { name: 'Player wallet' },
    { name: 'Public agents' },
    { name: 'Agent portal' },
    { name: 'Bingo' },
    { name: 'Marketing' },
    { name: 'Bonuses' },
    { name: 'Referrals' },
    { name: 'Games' },
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
          autoDepositEnabled: {
            type: 'boolean',
            description: 'Auto-credit verified receipts up to the agent threshold.',
          },
          autoDepositThreshold: { ...money, nullable: true },
          paymentAccounts: {
            type: 'array',
            items: { $ref: '#/components/schemas/PaymentAccount' },
          },
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
          providerCode: { type: 'string', nullable: true },
          receiptReference: { type: 'string', nullable: true },
          receiptAccount: { type: 'string', nullable: true },
          verificationStatus: {
            type: 'string',
            enum: ['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'FAILED', 'MANUAL'],
          },
          verificationMessage: { type: 'string', nullable: true },
          verificationSource: { type: 'string', enum: ['SERVER', 'CLIENT', 'RELAY'], nullable: true },
          autoVerified: { type: 'boolean' },
          verifiedAt: { type: 'string', format: 'date-time', nullable: true },
          externalRef: { type: 'string', nullable: true },
          clientReceiptUrl: {
            type: 'string',
            nullable: true,
            description: 'Bank page the payer app fetches for client-side rails (Telebirr, M-Pesa).',
          },
          agent: {
            type: 'object',
            nullable: true,
            description: 'Agent the server assigned to receive this payment.',
            properties: {
              id: { type: 'string', format: 'uuid' },
              agentCode: { type: 'string' },
              displayName: { type: 'string', nullable: true },
              isOnline: { type: 'boolean' },
              autoDepositEnabled: { type: 'boolean' },
              autoDepositThreshold: { ...money, nullable: true },
            },
          },
          paymentAccount: {
            allOf: [{ $ref: '#/components/schemas/PaymentAccount' }],
            nullable: true,
            description: 'Account the player pays into.',
          },
          expiresAt: { type: 'string', format: 'date-time' },
          settledAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      DepositProvider: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'telebirr' },
          name: { type: 'string' },
          method: { type: 'string' },
          requiresPhone: { type: 'boolean' },
          accountDigits: { type: 'integer', nullable: true },
          opaqueReference: { type: 'boolean' },
          clientSide: { type: 'boolean' },
          supported: { type: 'boolean' },
          enabled: { type: 'boolean' },
          sortOrder: { type: 'integer' },
          instructions: { type: 'string', nullable: true },
          refHint: { type: 'string', nullable: true },
          refPattern: { type: 'string', nullable: true },
          minAmount: { ...money, nullable: true },
          maxAmount: { ...money, nullable: true },
          parser: { type: 'string', nullable: true },
          endpoint: { type: 'string', nullable: true },
        },
      },
      PaymentAccount: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          method: { type: 'string' },
          provider: { type: 'string', nullable: true },
          accountName: { type: 'string' },
          accountNumber: { type: 'string' },
          instructions: { type: 'string', nullable: true },
          minAmount: { ...money, nullable: true },
          maxAmount: { ...money, nullable: true },
          isActive: { type: 'boolean' },
        },
      },
      ReceiptVerification: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          providerCode: { type: 'string' },
          providerName: { type: 'string' },
          reference: { type: 'string' },
          status: { type: 'string', enum: ['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'FAILED', 'MANUAL'] },
          source: { type: 'string', enum: ['SERVER', 'CLIENT', 'RELAY'], nullable: true },
          amount: { ...money, nullable: true },
          currency: { type: 'string', nullable: true },
          senderName: { type: 'string', nullable: true },
          senderAccount: { type: 'string', nullable: true },
          receiverName: { type: 'string', nullable: true },
          receiverAccount: { type: 'string', nullable: true },
          transactionDate: { type: 'string', nullable: true },
          transactionStatus: { type: 'string', nullable: true },
          message: { type: 'string', nullable: true },
          attempts: { type: 'integer' },
          verifiedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          deposit: {
            type: 'object',
            nullable: true,
            properties: {
              code: { type: 'string' },
              amount: money,
              status: { type: 'string' },
              autoVerified: { type: 'boolean' },
              player: {
                type: 'object',
                nullable: true,
                properties: {
                  displayName: { type: 'string', nullable: true },
                  phone: { type: 'string', nullable: true },
                },
              },
            },
          },
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
          agentProfileId: {
            type: 'string',
            format: 'uuid',
            description: 'Legacy override. Omit: the server assigns an active agent automatically.',
          },
          agentCode: { type: 'string', description: 'Legacy override, alternative to agentProfileId' },
          paymentAccountId: { type: 'string', format: 'uuid', description: 'Legacy override; chosen by the server otherwise' },
          providerCode: {
            type: 'string',
            description: 'Deposit rail from GET /wallet/deposit-providers. Locks `method` to the rail.',
          },
          receiptReference: {
            type: 'string',
            maxLength: 512,
            description: 'Optional at creation; normally submitted with POST /wallet/deposits/{code}/verify-receipt ("I have paid").',
          },
          receiptAccount: { type: 'string', maxLength: 64, description: 'Last N digits of the payer account, when the rail needs them' },
          receiptPhone: { type: 'string', maxLength: 32, description: 'Payer phone, when the rail needs it' },
          receiptUrl: { type: 'string', format: 'uri', maxLength: 2048, description: 'Optional payer-supplied receipt link' },
          playerNote: { type: 'string' },
          externalRef: { type: 'string' },
        },
      },
      WithdrawalCreate: {
        type: 'object',
        required: ['amount', 'method'],
        properties: {
          amount: { type: 'integer', minimum: 1, description: 'Minor units' },
          method: { type: 'string' },
          agentProfileId: {
            type: 'string',
            format: 'uuid',
            description: 'Legacy override. Unassigned payouts can be settled by any active agent.',
          },
          paymentAccountId: { type: 'string', format: 'uuid' },
          playerNote: { type: 'string' },
        },
      },
      Presence: {
        type: 'object',
        required: ['isOnline'],
        properties: { isOnline: { type: 'boolean' } },
      },
      AutoDepositPatch: {
        type: 'object',
        description: 'Agent-controlled automation. Both fields are optional; at least one is required.',
        properties: {
          autoDepositEnabled: { type: 'boolean' },
          autoDepositThreshold: {
            type: 'integer',
            minimum: 1,
            nullable: true,
            description: 'Minor units. Verified receipts at or below this amount auto-credit; null disables the cap.',
          },
        },
      },
      PaymentAccountCreate: {
        type: 'object',
        required: ['method', 'accountName', 'accountNumber'],
        properties: {
          method: { type: 'string', enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH', 'CARD', 'CRYPTO'] },
          provider: { type: 'string', nullable: true, description: 'Deposit provider code, e.g. telebirr' },
          accountName: { type: 'string', maxLength: 128 },
          accountNumber: { type: 'string', maxLength: 64 },
          instructions: { type: 'string', maxLength: 500, nullable: true },
          minAmount: { type: 'integer', minimum: 0, nullable: true, description: 'Minor units' },
          maxAmount: { type: 'integer', minimum: 1, nullable: true, description: 'Minor units' },
        },
      },
      PaymentAccountPatch: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH', 'CARD', 'CRYPTO'] },
          provider: { type: 'string', nullable: true },
          accountName: { type: 'string', maxLength: 128 },
          accountNumber: { type: 'string', maxLength: 64 },
          instructions: { type: 'string', maxLength: 500, nullable: true },
          minAmount: { type: 'integer', minimum: 0, nullable: true },
          maxAmount: { type: 'integer', minimum: 1, nullable: true },
          isActive: { type: 'boolean' },
        },
      },
      DepositProviderPatch: {
        type: 'object',
        description:
          'Presentation and policy only. The parser and endpoint host allowlist are code-owned and cannot be changed here.',
        properties: {
          name: { type: 'string', maxLength: 96 },
          enabled: { type: 'boolean' },
          supported: { type: 'boolean', description: 'Implementation exists; unsupported rails fail closed' },
          requiresPhone: { type: 'boolean' },
          accountDigits: { type: 'integer', minimum: 1, maximum: 12, nullable: true },
          opaqueReference: { type: 'boolean' },
          clientSide: { type: 'boolean', description: 'Bank blocks foreign IPs; payer device fetches the receipt' },
          sortOrder: { type: 'integer', minimum: 0, maximum: 10000 },
          instructions: { type: 'string', maxLength: 1000, nullable: true },
          refPattern: { type: 'string', maxLength: 300, nullable: true },
          refHint: { type: 'string', maxLength: 200, nullable: true },
          minAmount: { type: 'integer', minimum: 1, nullable: true, description: 'Minor units' },
          maxAmount: { type: 'integer', minimum: 1, nullable: true, description: 'Minor units' },
        },
      },
      StaffTelegramPatch: {
        type: 'object',
        required: ['telegramId'],
        properties: {
          telegramId: {
            type: 'string',
            pattern: '^\\d{1,20}$',
            nullable: true,
            description: 'Numeric Telegram user id; null unlinks the account',
          },
        },
      },
      ReceiptVerifyPayload: {
        type: 'object',
        description:
          '"I have paid": the receipt reference, an optional proof screenshot, and the bank response captured by the ' +
          'payer device for client-side rails. All evidence is untrusted: the server re-parses it, dedupes the ' +
          'reference and compares the amount.',
        properties: {
          receiptReference: { type: 'string', maxLength: 512 },
          receiptAccount: { type: 'string', maxLength: 64 },
          receiptPhone: { type: 'string', maxLength: 32 },
          contentType: { type: 'string', maxLength: 128 },
          bodyBase64: { type: 'string', maxLength: 7200000 },
          proofBase64: { type: 'string', maxLength: 6000000, description: 'Screenshot/photo of the receipt' },
          proofContentType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
        },
      },
      Campaign: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['BANNER', 'POPUP'] },
          audience: { type: 'string', enum: ['ALL', 'PLAYERS', 'AGENTS'] },
          locale: { type: 'string', enum: ['en', 'am'] },
          title: { type: 'string' },
          body: { type: 'string' },
          imageUrl: { type: 'string', nullable: true },
          linkUrl: { type: 'string', nullable: true },
          linkLabel: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          dismissHours: { type: 'integer', description: 'Hidden on the player device for this many hours; 0 shows every launch' },
          startsAt: { type: 'string', format: 'date-time', nullable: true },
          endsAt: { type: 'string', format: 'date-time', nullable: true },
          createdById: { type: 'string', format: 'uuid', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      CampaignBody: {
        type: 'object',
        required: ['kind', 'title', 'body'],
        properties: {
          kind: { type: 'string', enum: ['BANNER', 'POPUP'] },
          audience: { type: 'string', enum: ['ALL', 'PLAYERS', 'AGENTS'], default: 'ALL' },
          locale: { type: 'string', enum: ['en', 'am'], default: 'en' },
          title: { type: 'string', maxLength: 120 },
          body: { type: 'string', maxLength: 2000 },
          imageUrl: { type: 'string', format: 'uri', nullable: true },
          linkUrl: { type: 'string', format: 'uri', nullable: true },
          linkLabel: { type: 'string', maxLength: 40, nullable: true },
          enabled: { type: 'boolean', default: true },
          priority: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
          dismissHours: { type: 'integer', minimum: 0, maximum: 720, default: 24 },
          startsAt: { type: 'string', format: 'date-time', nullable: true },
          endsAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Bonus: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['PROMO', 'GRANT', 'DEPOSIT'] },
          amount: money,
          wagered: money,
          target: money,
          multiplier: { type: 'integer' },
          status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'] },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          promotionId: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      BonusWithPlayer: {
        allOf: [
          { $ref: '#/components/schemas/Bonus' },
          {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  displayName: { type: 'string' },
                  phone: { type: 'string', nullable: true },
                },
              },
            },
          },
        ],
      },
      BonusPromotion: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          code: { type: 'string' },
          name: { type: 'string' },
          percentBps: { type: 'integer', nullable: true },
          fixedAmount: { type: 'string', nullable: true, description: 'Minor units' },
          maxBonus: { type: 'string', nullable: true },
          minDeposit: { type: 'string', nullable: true },
          wageringMultiplier: { type: 'integer' },
          expiresInDays: { type: 'integer' },
          enabled: { type: 'boolean' },
          startsAt: { type: 'string', format: 'date-time', nullable: true },
          endsAt: { type: 'string', format: 'date-time', nullable: true },
          maxRedemptions: { type: 'integer', nullable: true },
          redemptionCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      BonusPromotionBody: {
        type: 'object',
        description: 'Set exactly one of percentBps or fixedAmount.',
        required: ['code', 'name', 'wageringMultiplier', 'expiresInDays'],
        properties: {
          code: { type: 'string', minLength: 3, maxLength: 32 },
          name: { type: 'string', maxLength: 120 },
          percentBps: { type: 'integer', minimum: 1, maximum: 10000, nullable: true },
          fixedAmount: { type: 'integer', minimum: 1, nullable: true, description: 'Minor units' },
          maxBonus: { type: 'integer', minimum: 1, nullable: true },
          minDeposit: { type: 'integer', minimum: 1, nullable: true },
          wageringMultiplier: { type: 'integer', minimum: 1, maximum: 100 },
          expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
          enabled: { type: 'boolean', default: true },
          startsAt: { type: 'string', format: 'date-time', nullable: true },
          endsAt: { type: 'string', format: 'date-time', nullable: true },
          maxRedemptions: { type: 'integer', minimum: 1, nullable: true },
        },
      },
      BonusGrant: {
        type: 'object',
        required: ['userId', 'amount'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          amount: { type: 'integer', minimum: 1, description: 'Minor units' },
          multiplier: { type: 'integer', minimum: 1, maximum: 100, description: 'Defaults to the platform setting' },
          expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
          note: { type: 'string', maxLength: 200 },
        },
      },
      ReferralCommission: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          playerId: { type: 'string', format: 'uuid' },
          playerName: { type: 'string' },
          roundId: { type: 'string', format: 'uuid' },
          rakeBase: money,
          bps: { type: 'integer' },
          amount: money,
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ReferralOverview: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Empty when the account has no referral code yet' },
          inviteLink: { type: 'string', nullable: true },
          commissionBps: { type: 'integer' },
          referredCount: { type: 'integer' },
          activeReferrals: { type: 'integer' },
          totalEarned: money,
          recent: { type: 'array', items: { $ref: '#/components/schemas/ReferralCommission' } },
        },
      },
      ReferralSettings: {
        type: 'object',
        required: ['commissionBps'],
        properties: {
          commissionBps: { type: 'integer', minimum: 0, maximum: 5000, description: 'Share of round rake paid to the referrer' },
          minRakeToPay: { type: 'integer', minimum: 0, description: 'Skip rounds whose rake is below this (minor units)' },
        },
      },
      BonusSettings: {
        type: 'object',
        required: ['defaultWageringMultiplier', 'defaultExpiryDays'],
        properties: {
          defaultWageringMultiplier: { type: 'integer', minimum: 1, maximum: 100 },
          defaultExpiryDays: { type: 'integer', minimum: 1, maximum: 365 },
        },
      },
      GameProvider: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          code: { type: 'string', example: 'pragmatic' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['NATIVE', 'AGGREGATOR'] },
          apiBaseUrl: { type: 'string', nullable: true },
          hasSecret: { type: 'boolean', description: 'The webhook secret is write-only' },
          enabled: { type: 'boolean' },
          sortOrder: { type: 'integer' },
          config: { nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      GameProviderBody: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 96 },
          kind: { type: 'string', enum: ['NATIVE', 'AGGREGATOR'], default: 'AGGREGATOR' },
          apiBaseUrl: { type: 'string', format: 'uri', nullable: true },
          webhookSecret: { type: 'string', minLength: 16, maxLength: 128, nullable: true, description: 'Write-only; omit to keep the current secret' },
          enabled: { type: 'boolean', default: false },
          sortOrder: { type: 'integer', minimum: 0, maximum: 10000 },
          config: { nullable: true },
        },
      },
      ProviderGame: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          providerId: { type: 'string', format: 'uuid' },
          providerCode: { type: 'string' },
          providerName: { type: 'string' },
          externalId: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string', nullable: true },
          thumbnailUrl: { type: 'string', nullable: true },
          launchUrlTemplate: { type: 'string', nullable: true, description: 'Supports {token}, {sessionId}, {lang} and {currency}' },
          minStake: { type: 'string', nullable: true },
          maxStake: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          sortOrder: { type: 'integer' },
        },
      },
      ProviderGameBody: {
        type: 'object',
        required: ['externalId', 'name'],
        properties: {
          externalId: { type: 'string', maxLength: 64 },
          name: { type: 'string', maxLength: 96 },
          category: { type: 'string', maxLength: 48, nullable: true },
          thumbnailUrl: { type: 'string', format: 'uri', nullable: true },
          launchUrlTemplate: { type: 'string', maxLength: 2048, nullable: true },
          minStake: { type: 'integer', minimum: 1, nullable: true },
          maxStake: { type: 'integer', minimum: 1, nullable: true },
          enabled: { type: 'boolean', default: true },
          sortOrder: { type: 'integer', minimum: 0, maximum: 10000 },
        },
      },
      ProviderSession: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          providerId: { type: 'string', format: 'uuid' },
          gameId: { type: 'string', format: 'uuid' },
          externalSessionId: { type: 'string' },
          status: { type: 'string' },
          launchUrl: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ProviderCallback: {
        type: 'object',
        required: ['sessionId', 'type', 'txnId', 'amount'],
        description:
          'Signed with HMAC-SHA256 over the raw request body in the `x-provider-signature` header. ' +
          '`txnId` is idempotent per provider; rollbacks reference the original bet txnId.',
        properties: {
          sessionId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['bet', 'win', 'rollback'] },
          txnId: { type: 'string', maxLength: 128 },
          amount: { type: 'string', pattern: '^\\d+$', description: 'Minor units' },
          currency: { type: 'string' },
          roundId: { type: 'string' },
        },
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
        summary: 'Sign in through the Telegram Mini App (players and staff)',
        description:
          'Creates the player on first launch. Playing and withdrawals additionally require a phone number shared with the bot. ' +
          'A staff account whose Telegram id is linked is returned with its role so the Mini App can open the agent, support ' +
          'or admin dashboard.',
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
    '/wallet/deposit-providers': {
      get: {
        tags: ['Player wallet'],
        summary: 'Enabled deposit rails and their receipt requirements',
        description:
          'Client-side rails (`clientSide: true`, e.g. Telebirr, M-Pesa) return a `clientReceiptUrl` on the deposit ' +
          'that the player app must fetch from an Ethiopian IP and POST back to `/wallet/deposits/{code}/verify-receipt`.',
        parameters: [{ name: 'method', in: 'query', schema: { type: 'string' } }],
        responses: { '200': ok(dataArrayRef('DepositProvider')) },
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
        summary: 'Open a deposit request; the server assigns the receiving agent',
        description:
          'The player sends only the method/rail and amount. The response carries the assigned agent and the exact ' +
          'payment account to pay, so the UI can show "pay X to account Y".',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DepositCreate' } } } },
        responses: {
          '201': ok(dataRef('Deposit')),
          '409': errorResponse('Duplicate request / AGENT_UNAVAILABLE'),
        },
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
    '/wallet/deposits/{code}/verify-receipt': {
      post: {
        tags: ['Player wallet'],
        summary: '"I have paid": submit the receipt reference, proof, or the bank response',
        description:
          'Called after the player pays. For client-side rails the reply sets `needsClientFetch`; the app then fetches ' +
          '`clientReceiptUrl` on the player phone and posts `bodyBase64` back. A screenshot without a fetchable receipt ' +
          'parks the deposit in MANUAL for the agent. A verified receipt only credits automatically when the assigned ' +
          'agent has auto-deposit on, the rail is enabled, the amount matches exactly and the agent threshold covers it.',
        security: [{ bearerAuth: [] }],
        parameters: [idParam('code')],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ReceiptVerifyPayload' } } },
        },
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: { $ref: '#/components/schemas/Deposit' },
              verification: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['VERIFIED', 'FAILED', 'PENDING', 'MANUAL'] },
                  message: { type: 'string' },
                },
              },
              autoCredited: { type: 'boolean' },
              needsClientFetch: {
                type: 'boolean',
                description: 'True when the app should fetch clientReceiptUrl and post the bank bytes back.',
              },
            },
          }),
          '404': errorResponse('Deposit not found'),
          '409': errorResponse('DEPOSIT_NOT_OPEN / RECEIPT_ALREADY_USED / RECEIPT_REFERENCE_REQUIRED'),
        },
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
        summary: 'Escrow credits and issue a payout code (phone verification required; any agent may settle)',
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
      patch: {
        tags: ['Agent portal'],
        summary: 'Set auto-deposit mode and threshold',
        description:
          'Only the assigned agent decides automation. Verified receipts at or below the threshold credit without manual ' +
          'confirmation; larger ones stay in the queue.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AutoDepositPatch' } } } },
        responses: { '200': ok(dataRef('Agent')), '400': errorResponse('Nothing to update') },
      },
    },
    '/agent/payment-accounts': {
      get: {
        tags: ['Agent portal'],
        summary: 'My receiving accounts',
        responses: { '200': ok(dataArrayRef('PaymentAccount')) },
      },
      post: {
        tags: ['Agent portal'],
        summary: 'Add a receiving account',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentAccountCreate' } } } },
        responses: { '201': ok(dataRef('PaymentAccount')) },
      },
    },
    '/agent/payment-accounts/{id}': {
      patch: {
        tags: ['Agent portal'],
        summary: 'Edit a receiving account',
        parameters: [idParam('id')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentAccountPatch' } } } },
        responses: { '200': ok(dataRef('PaymentAccount')), '404': errorResponse('Not found') },
      },
      delete: {
        tags: ['Agent portal'],
        summary: 'Deactivate a receiving account (soft delete)',
        parameters: [idParam('id')],
        responses: { '200': ok(dataRef('PaymentAccount')) },
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
    '/support/receipts': {
      get: {
        tags: ['Support'],
        summary: 'Receipt verification audit trail',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'VERIFIED', 'FAILED', 'MANUAL', 'NOT_REQUIRED'] } },
          { name: 'providerCode', in: 'query', schema: { type: 'string' } },
          pageParam,
        ],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/ReceiptVerification' } },
              page: { $ref: '#/components/schemas/Page' },
            },
          }),
        },
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
    '/admin/staff/{userId}/telegram': {
      patch: {
        tags: ['Admin'],
        summary: 'Attach or clear a staff Telegram id',
        description: 'The id lets the staff member open their dashboard inside the Telegram Mini App.',
        parameters: [idParam('userId')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffTelegramPatch' } } } },
        responses: {
          '200': ok({ type: 'object', properties: { data: { type: 'object' } } }),
          '409': errorResponse('TELEGRAM_ALREADY_LINKED'),
        },
      },
    },
    '/admin/staff/{userId}/telegram-link': {
      post: {
        tags: ['Admin'],
        summary: 'Mint a one-time bot deep link so staff can link their own Telegram id',
        parameters: [idParam('userId')],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  expiresAt: { type: 'string', format: 'date-time' },
                  url: { type: 'string', nullable: true, example: 'https://t.me/bingohall_bot?start=staff_abc123' },
                },
              },
            },
          }),
        },
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
        summary: 'Update agent status, tier, auto-deposit mode or threshold',
        parameters: [idParam('agentId')],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] },
                  tier: { type: 'string', enum: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] },
                  autoDepositEnabled: { type: 'boolean' },
                  autoDepositThreshold: { type: 'integer', minimum: 1, nullable: true, description: 'Minor units' },
                },
              },
            },
          },
        },
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
    '/admin/deposit-providers': {
      get: {
        tags: ['Admin'],
        summary: 'Every deposit rail, including disabled ones',
        responses: { '200': ok(dataArrayRef('DepositProvider')) },
      },
    },
    '/admin/deposit-providers/{code}': {
      patch: {
        tags: ['Admin'],
        summary: 'Configure a deposit rail',
        description:
          'Parser, endpoint host allowlist and verification code stay in the codebase; this endpoint only edits ' +
          'availability, limits, payer prompts and sort order.',
        parameters: [idParam('code')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DepositProviderPatch' } } } },
        responses: { '200': ok(dataRef('DepositProvider')), '404': errorResponse('Provider not found') },
      },
    },
    '/admin/reconciliation': {
      get: {
        tags: ['Admin'],
        summary: 'Ledger drift check (v_account_drift)',
        responses: { '200': ok({ type: 'object' }) },
      },
    },

    // ─────────────────────────────── marketing ───────────────────────────────
    '/marketing/campaigns': {
      get: {
        tags: ['Marketing'],
        summary: 'Active banners and popups for the signed-in role and language',
        parameters: [{ name: 'locale', in: 'query', schema: { type: 'string', enum: ['en', 'am'], default: 'en' } }],
        responses: { '200': ok(dataArrayRef('Campaign')) },
      },
    },
    '/admin/campaigns': {
      get: {
        tags: ['Admin'],
        summary: 'Every campaign, including paused ones',
        responses: { '200': ok(dataArrayRef('Campaign')) },
      },
      post: {
        tags: ['Admin'],
        summary: 'Create a banner or popup',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignBody' } } } },
        responses: { '201': ok(dataRef('Campaign')) },
      },
    },
    '/admin/campaigns/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Edit a campaign',
        parameters: [idParam('id')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignBody' } } } },
        responses: { '200': ok(dataRef('Campaign')), '404': errorResponse('Campaign not found') },
      },
      delete: {
        tags: ['Admin'],
        summary: 'Delete a campaign',
        parameters: [idParam('id')],
        responses: { '200': ok({ type: 'object' }), '404': errorResponse('Campaign not found') },
      },
    },

    // ──────────────────────────────── bonuses ────────────────────────────────
    '/bonuses': {
      get: {
        tags: ['Bonuses'],
        summary: 'Active bonus, grant history and the wallet balance including bonus credits',
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  active: { allOf: [{ $ref: '#/components/schemas/Bonus' }], nullable: true },
                  history: { type: 'array', items: { $ref: '#/components/schemas/Bonus' } },
                  wallet: { $ref: '#/components/schemas/Wallet' },
                },
              },
            },
          }),
        },
      },
    },
    '/bonuses/redeem': {
      post: {
        tags: ['Bonuses'],
        summary: 'Redeem a promo code',
        description:
          'Requires a Telegram-verified phone. A bonus is not stakeable: it converts to available credits only ' +
          'after real-money card stakes reach `amount × multiplier`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code'],
                properties: { code: { type: 'string', minLength: 3, maxLength: 32 } },
              },
            },
          },
        },
        responses: {
          '201': ok({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  bonus: { $ref: '#/components/schemas/Bonus' },
                  wallet: { $ref: '#/components/schemas/Wallet' },
                },
              },
            },
          }),
          '404': errorResponse('PROMO_NOT_FOUND'),
          '409': errorResponse('BONUS_ALREADY_ACTIVE / PROMO_EXHAUSTED'),
        },
      },
    },
    '/admin/bonus-promotions': {
      get: {
        tags: ['Admin'],
        summary: 'List promo codes',
        responses: { '200': ok(dataArrayRef('BonusPromotion')) },
      },
      post: {
        tags: ['Admin'],
        summary: 'Create a promo code',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BonusPromotionBody' } } } },
        responses: { '201': ok(dataRef('BonusPromotion')), '400': errorResponse('PROMOTION_TERMS_INVALID') },
      },
    },
    '/admin/bonus-promotions/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Edit a promo code',
        parameters: [idParam('id')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BonusPromotionBody' } } } },
        responses: { '200': ok(dataRef('BonusPromotion')), '404': errorResponse('Promotion not found') },
      },
      delete: {
        tags: ['Admin'],
        summary: 'Delete a promo code',
        parameters: [idParam('id')],
        responses: { '200': ok({ type: 'object' }), '404': errorResponse('Promotion not found') },
      },
    },
    '/admin/bonuses': {
      get: {
        tags: ['Admin'],
        summary: 'Granted bonuses with the player they belong to',
        parameters: [
          { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          pageParam,
        ],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/BonusWithPlayer' } },
              page: { $ref: '#/components/schemas/Page' },
            },
          }),
        },
      },
    },
    '/admin/bonuses/grant': {
      post: {
        tags: ['Admin'],
        summary: 'Grant a manual bonus to a player',
        security: [{ bearerAuth: [] }, { idempotency: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BonusGrant' } } } },
        responses: { '201': ok(dataRef('Bonus')), '409': errorResponse('BONUS_ALREADY_ACTIVE') },
      },
    },

    // ─────────────────────────────── referrals ───────────────────────────────
    '/referrals': {
      get: {
        tags: ['Referrals'],
        summary: 'Referral code, invite link, counts and commission history',
        responses: { '200': ok(dataRef('ReferralOverview')) },
      },
    },
    '/admin/referrals': {
      get: {
        tags: ['Admin'],
        summary: 'Referral leaderboard (top 50 by commission paid)',
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    referrerId: { type: 'string', format: 'uuid' },
                    referrerName: { type: 'string', nullable: true },
                    referrerPhone: { type: 'string', nullable: true },
                    payments: { type: 'integer' },
                    rakeBase: money,
                    amount: money,
                  },
                },
              },
            },
          }),
        },
      },
    },
    '/admin/settings': {
      get: {
        tags: ['Admin'],
        summary: 'Platform referral and bonus defaults',
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  referral: {
                    type: 'object',
                    properties: {
                      commissionBps: { type: 'integer' },
                      minRakeToPay: money,
                    },
                  },
                  bonus: { $ref: '#/components/schemas/BonusSettings' },
                },
              },
            },
          }),
        },
      },
    },
    '/admin/settings/referrals': {
      put: {
        tags: ['Admin'],
        summary: 'Set the affiliate commission share of round rake',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReferralSettings' } } } },
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/admin/settings/bonuses': {
      put: {
        tags: ['Admin'],
        summary: 'Set the default wagering multiplier and expiry',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BonusSettings' } } } },
        responses: { '200': ok({ type: 'object' }) },
      },
    },

    // ──────────────────────────── external game providers ────────────────────────────
    '/games': {
      get: {
        tags: ['Games'],
        summary: 'Enabled providers with their playable games',
        responses: { '200': ok(dataArrayRef('GameProvider')) },
      },
    },
    '/games/{gameId}/launch': {
      post: {
        tags: ['Games'],
        summary: 'Create a provider session and return the launch URL',
        parameters: [idParam('gameId')],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { lang: { type: 'string', enum: ['en', 'am'], default: 'en' } },
              },
            },
          },
        },
        responses: { '201': ok(dataRef('ProviderSession')), '409': errorResponse('GAME_NOT_AVAILABLE') },
      },
    },
    '/games/sessions/{sessionId}/close': {
      post: {
        tags: ['Games'],
        summary: 'Close a provider session',
        parameters: [idParam('sessionId')],
        responses: { '200': ok({ type: 'object' }), '404': errorResponse('Session not found') },
      },
    },
    '/games/callback/{providerCode}': {
      post: {
        tags: ['Games'],
        summary: 'Provider wallet callback (bet · win · rollback)',
        description:
          'Signed with HMAC-SHA256 over the raw body in `x-provider-signature`. Every txnId is applied at most ' +
          'once; replays return `{ replayed: true }`. Callbacks are not session-authenticated.',
        security: [],
        parameters: [idParam('providerCode')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProviderCallback' } } } },
        responses: {
          '201': ok({ type: 'object' }),
          '200': ok({ type: 'object' }),
          '403': errorResponse('SIGNATURE_INVALID'),
        },
      },
    },
    '/admin/game-providers': {
      get: {
        tags: ['Admin'],
        summary: 'Provider catalog with games',
        responses: { '200': ok(dataArrayRef('GameProvider')) },
      },
    },
    '/admin/game-providers/{code}': {
      put: {
        tags: ['Admin'],
        summary: 'Create or update a provider (secret is write-only)',
        parameters: [idParam('code')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GameProviderBody' } } } },
        responses: { '200': ok(dataRef('GameProvider')) },
      },
      delete: {
        tags: ['Admin'],
        summary: 'Delete a provider and its games',
        parameters: [idParam('code')],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/admin/game-providers/{code}/games': {
      post: {
        tags: ['Admin'],
        summary: 'Add or update a game in a provider catalog',
        parameters: [idParam('code')],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProviderGameBody' } } } },
        responses: { '201': ok({ type: 'object' }) },
      },
    },
    '/admin/game-providers/{code}/games/{externalId}': {
      delete: {
        tags: ['Admin'],
        summary: 'Remove a game from a provider catalog',
        parameters: [idParam('code'), idParam('externalId')],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
  },
};
