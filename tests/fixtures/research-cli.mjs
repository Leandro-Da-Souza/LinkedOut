import process from 'node:process';
import { URL } from 'node:url';
import { createApplication } from '../../dist/entrypoints/app.js';
import { runCli } from '../../dist/entrypoints/cli.js';
import { GithubResearchFeed } from '../../dist/infrastructure/github-research.js';

// Entirely local fixtures: no public or paid provider network requests.
const app = createApplication(undefined, {
  researchFeed: new GithubResearchFeed(async (url) => {
    const repository = new URL(String(url)).pathname
      .split('/')
      .slice(2, 4)
      .join('/');
    return globalThis.Response.json([
      {
        id: 10,
        html_url: `https://github.com/${repository}/releases/tag/v1`,
        name: 'Synthetic release',
        tag_name: 'v1',
        body: 'Synthetic TypeScript support and migration guidance for frontend teams.',
        published_at: new Date(Date.now() - 86_400_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
        draft: false,
        prerelease: false,
      },
    ]);
  }),
  researchPlanner: {
    provider: 'fixture',
    model: 'fixture',
    async planResearch(request) {
      return {
        output: {
          ideas: request.candidates.map(() => ({
            angle: 'experiment',
            personalEvidenceIndex: null,
          })),
        },
        metadata: { provider: 'fixture', model: 'fixture' },
      };
    },
  },
});
try {
  process.stdout.write(
    JSON.stringify(await runCli(process.argv.slice(2), app)) + '\n',
  );
} finally {
  app.close();
}
