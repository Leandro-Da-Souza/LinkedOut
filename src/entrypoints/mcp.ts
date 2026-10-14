import { createApplication } from './app.js';
import { startMcp } from './mcp-server.js';
import { reportFailure } from './main.js';

try {
  startMcp(createApplication());
} catch (error) {
  reportFailure(error);
}
