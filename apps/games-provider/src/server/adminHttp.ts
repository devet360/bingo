import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';
import type { OperatorRecord, OperatorSecretRecord, OperatorStatus } from '../domain/types';
import {
  createOperator,
  deleteOperator,
  runProbe,
  setOperatorStatus,
  updateOperator,
} from './operatorAdmin';
import { OperatorError, type OperatorRegistry } from './operatorRegistry';
import type { Store } from './store';

const OPERATOR_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const satisfies readonly OperatorStatus[];

const LimitsSchema = z
  .object({
    minStake: z.coerce.bigint().min(1n),
    maxStake: z.coerce.bigint().min(1n),
    maxWin: z.coerce.bigint().min(1n),
    maxBetsPerRound: z.number().int().positive(),
  })
  .strict();

const BotConfigSchema = z
  .object({
    enabled: z.boolean(),
    count: z.number().int().min(0).max(100),
    stakeMin: z.coerce.bigint().min(1n),
    stakeMax: z.coerce.bigint().min(1n),
    roundPayoutCap: z.coerce.bigint().min(0n),
    dayPayoutCap: z.coerce.bigint().min(0n),
    disclose: z.literal(true),
  })
  .strict()
  .refine((value) => value.stakeMin <= value.stakeMax, {
    message: 'stakeMin must not exceed stakeMax',
  });
const RuntimeSettingsSchema = z
  .object({
    botConfig: BotConfigSchema,
    enabledGames: z.array(z.enum(['crash', 'coinflip'])).min(1),
  })
  .strict();

const CreateOperatorSchema = z
  .object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    callbackUrl: z.string().min(1),
    allowedOrigins: z.array(z.string().min(1)).max(32),
    currency: z.string().length(3).optional(),
    localeDefault: z.enum(['en', 'am']).optional(),
    limits: LimitsSchema.optional(),
    enabledGames: z.array(z.string().min(1)).min(1).optional(),
    theme: z.record(z.unknown()).nullable().optional(),
    botConfig: BotConfigSchema.optional(),
  })
  .strict();

const UpdateOperatorSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    callbackUrl: z.string().min(1).optional(),
    allowedOrigins: z.array(z.string().min(1)).max(32).optional(),
    localeDefault: z.enum(['en', 'am']).optional(),
    limits: LimitsSchema.optional(),
    enabledGames: z.array(z.string().min(1)).min(1).optional(),
    theme: z.record(z.unknown()).nullable().optional(),
    maintenance: z.boolean().optional(),
    botConfig: BotConfigSchema.optional(),
  })
  .strict();

const StatusSchema = z.object({ status: z.enum(OPERATOR_STATUSES) }).strict();

/** Never includes secret material: presence and version only. */
function serializeOperator(operator: OperatorRecord, secrets: OperatorSecretRecord[]) {
  const active = secrets.filter((row) => row.retiredAt === null);
  return {
    code: operator.code,
    name: operator.name,
    callbackUrl: operator.callbackUrl,
    currency: operator.currency,
    status: operator.status,
    allowedOrigins: operator.allowedOrigins,
    localeDefault: operator.localeDefault,
    limits: {
      minStake: operator.limits.minStake.toString(),
      maxStake: operator.limits.maxStake.toString(),
      maxWin: operator.limits.maxWin.toString(),
      maxBetsPerRound: operator.limits.maxBetsPerRound,
    },
    enabledGames: operator.enabledGames,
    theme: operator.theme,
    botConfig: operator.botConfig
      ? {
          ...operator.botConfig,
          stakeMin: operator.botConfig.stakeMin.toString(),
          stakeMax: operator.botConfig.stakeMax.toString(),
          roundPayoutCap: operator.botConfig.roundPayoutCap.toString(),
          dayPayoutCap: operator.botConfig.dayPayoutCap.toString(),
        }
      : null,
    maintenance: operator.maintenance,
    probeOkAt: operator.probeOkAt,
    createdAt: operator.createdAt,
    hasSecret: active.length > 0,
    secretVersion: active.length === 0 ? null : Math.max(...active.map((row) => row.version)),
  };
}

type Handler = (req: Request, res: Response) => Promise<void>;

interface ConsoleScope {
  role: 'provider_viewer' | 'operator_admin' | 'superadmin';
  actorId: string;
  operatorCode: string;
}

function verifyConsoleToken(secret: string | null | undefined, token: string): ConsoleScope | null {
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      type?: unknown;
      actorId?: unknown;
      role?: unknown;
      operatorCode?: unknown;
      exp?: unknown;
    };
    if (
      payload.type !== 'provider_console'
      || typeof payload.actorId !== 'string'
      || (payload.role !== 'provider_viewer'
        && payload.role !== 'operator_admin'
        && payload.role !== 'superadmin')
      || typeof payload.operatorCode !== 'string'
      || typeof payload.exp !== 'number'
      || payload.exp <= Math.floor(Date.now() / 1000)
    ) return null;
    return { role: payload.role, actorId: payload.actorId, operatorCode: payload.operatorCode };
  } catch {
    return null;
  }
}

/** Express 4 does not await handlers; funnel rejections into the router error handler. */
const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  handler(req, res).catch(next);
};

export function adminRouter(deps: {
  store: Store;
  registry: OperatorRegistry;
  adminToken: string | null;
  consoleTokenSecret?: string | null;
  defaultOperatorCode?: string;
}): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (deps.adminToken === null && !deps.consoleTokenSecret) {
      res.status(503).json({ error: { code: 'ADMIN_DISABLED' } });
      return;
    }
    const authorization = req.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      const scope = verifyConsoleToken(deps.consoleTokenSecret, authorization.slice(7));
      if (!scope) {
        res.status(401).json({ error: { code: 'ADMIN_UNAUTHORIZED' } });
        return;
      }
      res.locals.consoleScope = scope;
      if (scope.role === 'provider_viewer' && req.method !== 'GET') {
        res.status(403).json({ error: { code: 'CONSOLE_READ_ONLY' } });
        return;
      }
      next();
      return;
    }
    if (deps.adminToken === null) {
      res.status(401).json({ error: { code: 'ADMIN_UNAUTHORIZED' } });
      return;
    }
    const given = Buffer.from(req.header('x-provider-admin-token') ?? '', 'utf8');
    const expected = Buffer.from(deps.adminToken, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(401).json({ error: { code: 'ADMIN_UNAUTHORIZED' } });
      return;
    }
    next();
  });

  router.use('/operators/:code', (req, res, next) => {
    const scope = res.locals.consoleScope as ConsoleScope | undefined;
    if (scope && scope.role !== 'superadmin' && scope.operatorCode !== req.params.code) {
      res.status(403).json({ error: { code: 'OPERATOR_SCOPE_DENIED' } });
      return;
    }
    next();
  });

  router.get(
    '/operators',
    route(async (_req, res) => {
      const scope = res.locals.consoleScope as ConsoleScope | undefined;
      let operators = await deps.store.listOperators();
      if (scope && scope.role !== 'superadmin') {
        operators = operators.filter((operator) => operator.code === scope.operatorCode);
      }
      const data = await Promise.all(
        operators.map(async (operator) =>
          serializeOperator(operator, await deps.store.listOperatorSecrets(operator.code)),
        ),
      );
      res.json({ data });
    }),
  );

  router.get(
    '/dashboard',
    route(async (_req, res) => {
      const scope = res.locals.consoleScope as ConsoleScope | undefined;
      const scopedOperatorCode = scope && scope.role !== 'superadmin'
        ? scope.operatorCode
        : undefined;
      const operators = (await deps.store.listOperators())
        .filter((operator) => scopedOperatorCode === undefined || operator.code === scopedOperatorCode)
        .map((operator) => ({
          code: operator.code,
          name: operator.name,
          status: operator.status,
          currency: operator.currency,
          enabledGames: operator.enabledGames,
          maintenance: operator.maintenance,
          probeOkAt: operator.probeOkAt,
          createdAt: operator.createdAt,
        }));
      const metrics = await deps.store.getDashboardMetrics(scopedOperatorCode);
      res.json({
        data: {
          operators,
          metrics: {
            ...metrics,
            outbox: {
              ...metrics.outbox,
              recent: metrics.outbox.recent.map((entry) => ({
                ...entry,
                amount: entry.amount.toString(),
              })),
            },
          },
        },
      });
    }),
  );

  router.get(
    '/runtime-settings',
    route(async (_req, res) => {
      const scope = res.locals.consoleScope as ConsoleScope | undefined;
      const ownerCode = deps.defaultOperatorCode ?? '';
      if (
        scope
        && scope.role !== 'superadmin'
        && !(scope.role === 'operator_admin' && scope.operatorCode === ownerCode)
      ) {
        res.status(403).json({ error: { code: 'PROVIDER_OWNER_REQUIRED' } });
        return;
      }
      const operator = await deps.store.getOperator(ownerCode);
      if (operator === null) {
        throw new OperatorError(404, 'OPERATOR_NOT_FOUND', 'Provider owner operator is not configured');
      }
      res.json({
        data: {
          operatorCode: operator.code,
          botConfig: serializeOperator(operator, []).botConfig,
          enabledGames: operator.enabledGames,
        },
      });
    }),
  );

  router.put(
    '/runtime-settings',
    route(async (req, res) => {
      const scope = res.locals.consoleScope as ConsoleScope | undefined;
      const ownerCode = deps.defaultOperatorCode ?? '';
      if (
        scope
        && scope.role !== 'superadmin'
        && !(scope.role === 'operator_admin' && scope.operatorCode === ownerCode)
      ) {
        res.status(403).json({ error: { code: 'PROVIDER_OWNER_REQUIRED' } });
        return;
      }
      const settings = RuntimeSettingsSchema.parse(req.body);
      const operator = await deps.store.getOperator(ownerCode);
      if (operator === null) {
        throw new OperatorError(404, 'OPERATOR_NOT_FOUND', 'Provider owner operator is not configured');
      }
      const updated = await updateOperator(deps.store, ownerCode, settings);
      res.json({
        data: {
          operatorCode: updated.code,
          botConfig: serializeOperator(updated, []).botConfig,
          enabledGames: updated.enabledGames,
        },
      });
    }),
  );

  router.get(
    '/operators/:code',
    route(async (req, res) => {
      const code = req.params.code;
      const operator = await deps.store.getOperator(code);
      if (operator === null) throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
      res.json({ data: serializeOperator(operator, await deps.store.listOperatorSecrets(code)) });
    }),
  );

  router.post(
    '/operators',
    route(async (req, res) => {
      const scope = res.locals.consoleScope as ConsoleScope | undefined;
      if (scope && scope.role !== 'superadmin') {
        res.status(403).json({ error: { code: 'SUPERADMIN_REQUIRED' } });
        return;
      }
      const input = CreateOperatorSchema.parse(req.body);
      const created = await createOperator(deps.store, deps.registry, input);
      const secrets = await deps.store.listOperatorSecrets(created.operator.code);
      res.status(201).json({
        data: {
          operator: serializeOperator(created.operator, secrets),
          secret: created.secret,
          secretVersion: created.secretVersion,
        },
      });
    }),
  );

  router.patch(
    '/operators/:code',
    route(async (req, res) => {
      const patch = UpdateOperatorSchema.parse(req.body);
      const operator = await updateOperator(deps.store, req.params.code, patch);
      res.json({ data: serializeOperator(operator, await deps.store.listOperatorSecrets(operator.code)) });
    }),
  );

  router.delete(
    '/operators/:code',
    route(async (req, res) => {
      const scope = res.locals.consoleScope as ConsoleScope | undefined;
      if (scope && scope.role !== 'superadmin') {
        res.status(403).json({ error: { code: 'SUPERADMIN_REQUIRED' } });
        return;
      }
      await deleteOperator(deps.store, req.params.code);
      res.json({ data: { deleted: true } });
    }),
  );

  // Rotation returns the new secret exactly once, shaped like createOperator.
  router.post(
    '/operators/:code/secrets',
    route(async (req, res) => {
      const code = req.params.code;
      const rotated = await deps.registry.rotateSecret(code);
      const operator = await deps.registry.get(code);
      res.status(201).json({
        data: {
          operator: serializeOperator(operator, await deps.store.listOperatorSecrets(code)),
          secret: rotated.secret,
          secretVersion: rotated.version,
        },
      });
    }),
  );

  router.post(
    '/operators/:code/secrets/:version/retire',
    route(async (req, res) => {
      const version = Number(req.params.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new OperatorError(400, 'SECRET_VERSION_INVALID', 'Secret version must be a positive integer');
      }
      const active = (await deps.store.listOperatorSecrets(req.params.code))
        .filter((secret) => secret.retiredAt === null)
        .sort((left, right) => right.version - left.version);
      if (!active.some((secret) => secret.version === version)) {
        throw new OperatorError(404, 'SECRET_NOT_ACTIVE', `Active secret version ${version} was not found`);
      }
      if (active.length < 2 || active[0]!.version === version) {
        throw new OperatorError(409, 'SECRET_RETIRE_UNSAFE', 'Keep the newest active secret and at least one active version');
      }
      await deps.store.retireOperatorSecret(req.params.code, version);
      res.json({ data: { retired: true, version } });
    }),
  );

  router.post(
    '/operators/:code/probe',
    route(async (req, res) => {
      const result = await runProbe(deps.store, deps.registry, req.params.code);
      res.json({ data: { ok: result.ok, checkedAt: result.checkedAt } });
    }),
  );

  router.post(
    '/operators/:code/status',
    route(async (req, res) => {
      const { status } = StatusSchema.parse(req.body);
      const operator = await setOperatorStatus(deps.store, req.params.code, status);
      res.json({ data: serializeOperator(operator, await deps.store.listOperatorSecrets(operator.code)) });
    }),
  );

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof OperatorError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
      return;
    }
    next(error);
  });

  return router;
}
