/* global process */
import { createApplication } from '../../dist/entrypoints/app.js';
import { runCli } from '../../dist/entrypoints/cli.js';
import { reportFailure } from '../../dist/entrypoints/main.js';
import { fixtureProvider } from './provider.mjs';

const app = createApplication(undefined, { provider: fixtureProvider() });
try {
  process.stdout.write(
    `${JSON.stringify(await runCli(process.argv.slice(2), app))}\n`,
  );
} catch (error) {
  reportFailure(error);
} finally {
  app.close();
}
