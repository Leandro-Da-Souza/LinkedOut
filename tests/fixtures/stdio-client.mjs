/* global process, Buffer, setImmediate */
import assert from 'node:assert/strict';
import { readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  Client,
  parseJSONRPCMessage,
  serializeMessage,
} from '@modelcontextprotocol/client';

// Test-only synchronous stdio transport avoids sandbox restrictions on Node
// child socketpairs and libuv polling inherited non-standard descriptors.
// Bash connects client stdin/stdout to an independently launched real server.
class ShellStdioTransport {
  pending = '';
  decoder = new StringDecoder('utf8');
  async start() {}
  async close() {
    this.onclose?.();
  }
  async send(message) {
    writeSync(1, serializeMessage(message));
    if (!('id' in message)) return;
    setImmediate(() => {
      try {
        const buffer = Buffer.alloc(4096);
        while (!this.pending.includes('\n')) {
          const count = readSync(0, buffer, 0, buffer.length, null);
          if (count === 0) {
            this.onclose?.();
            return;
          }
          this.pending += this.decoder.write(buffer.subarray(0, count));
        }
        const boundary = this.pending.indexOf('\n');
        const line = this.pending.slice(0, boundary);
        this.pending = this.pending.slice(boundary + 1);
        this.onmessage?.(parseJSONRPCMessage(JSON.parse(line)));
      } catch (error) {
        this.onerror?.(error);
        this.onclose?.();
      }
    });
  }
}
const client = new Client(
  { name: 'linkedout-shell-smoke', version: '1.0.0' },
  process.env.LINKEDOUT_TEST_MODERN === '1'
    ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    : {},
);
function body(result) {
  assert.notEqual(result.isError, true);
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}
try {
  await client.connect(new ShellStdioTransport(), {
    timeout: 5000,
  });
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    [
      'delete_review_artifact',
      'draft_post',
      'get_draft',
      'get_review_artifact',
      'list_drafts',
      'list_review_artifacts',
    ],
  );
  let draft;
  if (process.env.LINKEDOUT_TEST_DRAFT_ID) {
    draft = body(
      await client.callTool({
        name: 'get_draft',
        arguments: { id: process.env.LINKEDOUT_TEST_DRAFT_ID },
      }),
    ).draft;
  } else {
    const args = {
      brief: 'Shell smoke drafting with user preferences',
      idempotencyKey: 'shell-smoke',
    };
    const result = body(
      await client.callTool({ name: 'draft_post', arguments: args }),
    );
    draft = result.draft;
    const replay = body(
      await client.callTool({ name: 'draft_post', arguments: args }),
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.draft.id, draft.id);
    assert.equal(
      body(
        await client.callTool({
          name: 'get_draft',
          arguments: { id: draft.id },
        }),
      ).draft.id,
      draft.id,
    );
  }
  if (!process.env.LINKEDOUT_TEST_DRAFT_ID) {
    const failed = await client.callTool({
      name: 'draft_post',
      arguments: {
        brief: 'I built PRIVATE_BLOCKED_SHELL_PROJECT.',
        idempotencyKey: 'shell-blocked',
      },
    });
    assert.equal(failed.isError, true);
    const failure = JSON.parse(
      failed.content.find((item) => item.type === 'text').text,
    ).error;
    assert.equal(failure.code, 'UNGROUNDED_OUTPUT');
    const id = failure.reviewArtifactId;
    assert.ok(id);
    const summaries = body(
      await client.callTool({ name: 'list_review_artifacts', arguments: {} }),
    );
    assert.equal(summaries.total, 1);
    assert.ok(
      !JSON.stringify(summaries).includes('PRIVATE_BLOCKED_SHELL_PROJECT'),
    );
    const artifact = body(
      await client.callTool({ name: 'get_review_artifact', arguments: { id } }),
    ).artifact;
    assert.equal(artifact.publishable, false);
    assert.equal(artifact.status, 'blocked');
    assert.ok(artifact.body.includes('PRIVATE_BLOCKED_SHELL_PROJECT'));
    assert.equal(
      body(
        await client.callTool({
          name: 'delete_review_artifact',
          arguments: { id },
        }),
      ).deleted,
      true,
    );
  }
  assert.equal(draft.status, 'draft');
  assert.ok(draft.body.length > 0);
  assert.ok(
    body(await client.callTool({ name: 'list_drafts', arguments: {} })).total >=
      1,
  );
  process.stderr.write(
    `${JSON.stringify({ verified: true, draftId: draft.id, protocol: client.getNegotiatedProtocolVersion(), era: client.getProtocolEra() })}\n`,
  );
} finally {
  await client.close();
}
