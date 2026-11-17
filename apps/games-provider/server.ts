import 'dotenv/config';
import { createDb } from './src/db/index';
import { createPostgresStore } from './src/db/storePostgres';
import { loadConfig } from './src/config';
import { createApp } from './src/server/http';
import { HttpWalletClient } from './src/server/wallet';

const config = loadConfig();
const { db } = createDb(config.databaseUrl);
const store = createPostgresStore(db);
const wallet = new HttpWalletClient({
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
});

createApp({ config, store, wallet }).listen(config.port, () => {
  console.log(`games-provider listening on ${config.port}`);
});
