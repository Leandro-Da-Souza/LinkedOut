import { createApplication } from '../../dist/entrypoints/app.js';
import { startMcp } from '../../dist/entrypoints/mcp-server.js';
import { fixtureProvider } from './provider.mjs';

// Dependency injection exists exclusively in this test entry point.
startMcp(createApplication(undefined, { provider: fixtureProvider() }));
