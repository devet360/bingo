import express from 'express';
import type { AppConfig } from '../config';

export interface AppDeps {
  config: AppConfig;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', game: 'crash' } });
  });
  void deps;
  return app;
}
