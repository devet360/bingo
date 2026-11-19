import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';
import type { OperatorRecord, OperatorSecretRecord, OperatorStatus } from '../domain/types';
import {
  createOperator,
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
    maintenance: operator.maintenance,
    probeOkAt: operator.probeOkAt,
    createdAt: operator.createdAt,
    hasSecret: active.length > 0,
    secretVersion: active.length === 0 ? null : Math.max(...active.map((row) => row.version)),
  };
}

type Handler = (req: Request, res: Response) => Promise<void>;

/** Express 4 does not await handlers; funnel rejections into the router error handler. */
const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  handler(req, res).catch(next);
};

export function adminRouter(deps: { store: Store; registry: OperatorRegistry; adminToken: string | null }): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (deps.adminToken === null) {
      res.status(503).json({ error: { code: 'ADMIN_DISABLED' } });
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

  router.get(
    '/operators',
    route(async (_req, res) => {
      const operators = await deps.store.listOperators();
      const data = await Promise.all(
        operators.map(async (operator) =>
          serializeOperator(operator, await deps.store.listOperatorSecrets(operator.code)),
        ),
      );
      res.json({ data });
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
