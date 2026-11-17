import 'dotenv/config';
import { loadConfig } from './src/config';
import { createApp } from './src/server/http';

const config = loadConfig();
createApp({ config }).listen(config.port, () => {
  console.log(`games-provider listening on ${config.port}`);
});
