/* global process, Response, setTimeout, clearTimeout */
import OpenAI from 'openai';
import { OpenAIProvider } from '../../dist/infrastructure/openai-provider.js';

export function fixtureProvider(options = {}) {
  let requests = 0;
  if (options.reportExit !== false) {
    process.once('exit', () => {
      process.stderr.write(
        `${JSON.stringify({ fixtureRequests: requests })}\n`,
      );
    });
  }
  const fetch = async (_url, init) => {
    requests += 1;
    options.onRequest?.();
    const mode = options.responseMode ?? process.env.LINKEDOUT_TEST_RESPONSE;
    if (mode === 'wait') {
      if (options.reportExit !== false)
        process.stderr.write('{"fixtureRequestStarted":true}\n');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('Fixture request cancelled.'));
          },
          { once: true },
        );
      });
    }
    const request = JSON.parse(init.body);
    const data = JSON.parse(
      request.input.find((item) => item.role === 'user').content,
    );
    let output;
    if (mode === 'refusal') {
      output = [
        {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'refusal', refusal: 'Private fixture refusal context.' },
          ],
        },
      ];
    } else if (request.tools) {
      output = [
        {
          type: 'function_call',
          id: 'fc_fixture',
          call_id: 'call_fixture',
          name: request.tools[0].name,
          status: 'completed',
          arguments: JSON.stringify({
            brief: data.brief,
            audience: null,
            tone: null,
            language: null,
          }),
        },
      ];
    } else {
      const tone = data.input.tone ?? data.profile.tone;
      const language = data.input.language ?? data.profile.language;
      output = [
        {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              annotations: [],
              text: JSON.stringify({
                body: `Draft for ${data.profile.name ?? 'local user'}: ${data.input.brief} (${tone}; ${language})`,
                warnings: [],
                claims: [],
              }),
            },
          ],
        },
      ];
    }
    return Response.json({
      id: 'resp_fixture',
      object: 'response',
      created_at: 1,
      model: 'fixture-model-snapshot',
      status: 'completed',
      error: null,
      incomplete_details: null,
      output,
      usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
    });
  };
  return new OpenAIProvider({
    apiKey: 'fixture-key-secret',
    model: 'fixture-model',
    client: new OpenAI({
      apiKey: 'fixture-key-secret',
      fetch,
      logLevel: 'off',
    }),
  });
}
