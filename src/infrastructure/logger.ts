import type { ErrorCode } from '../domain/errors.js';

export interface LogEvent {
  event:
    | 'run_started'
    | 'run_succeeded'
    | 'run_failed'
    | 'server_started'
    | 'server_stopped';
  runId?: string;
  actor?: string;
  tool?: string;
  code?: ErrorCode;
}
export interface Logger {
  log(event: LogEvent): void;
}

// Accept only explicit safe fields; callers cannot pass prompts or raw errors.
export function createLogger(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): Logger {
  return {
    log(event) {
      const { event: name, runId, actor, tool, code } = event;
      write(
        `${JSON.stringify({ time: new Date().toISOString(), event: name, runId, actor, tool, code })}\n`,
      );
    },
  };
}
