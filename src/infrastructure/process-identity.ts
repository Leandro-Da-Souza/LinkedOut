import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import type {
  ProcessInspector,
  ProcessOwner,
  ProcessObservation,
} from '../domain/recovery.js';

// Injectable OS reads permit deterministic permission, namespace and PID-reuse tests.
export interface ProcessReads {
  platform: string;
  pid: number;
  read(path: string): string;
  link(path: string): string;
}
const system: ProcessReads = {
  platform: process.platform,
  pid: process.pid,
  read: (path) => readFileSync(path, 'utf8'),
  link: (path) => readlinkSync(path),
};
function stat(value: string, pid: number): string {
  // comm may contain spaces and parentheses. Fields after its final ')' start at 3.
  const end = value.lastIndexOf(')');
  if (!value.startsWith(`${pid} (`) || end < 0) throw new Error();
  const fields = value
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const start = fields[19];
  if (!start || !/^\d+$/.test(start)) throw new Error();
  return start;
}
export class LinuxProcessInspector implements ProcessInspector {
  constructor(private readonly os: ProcessReads = system) {}

  private scope() {
    if (this.os.platform !== 'linux') throw new Error();
    const boot = this.os.read('/proc/sys/kernel/random/boot_id').trim();
    if (!/^[a-f0-9-]{36}$/.test(boot)) throw new Error();
    // Require an ordinary, unrestricted proc mount. Overmounts, hidepid and
    // unusual layouts fail closed, even when a process happens to be visible.
    const mounts = this.os.read('/proc/self/mountinfo').trim().split('\n');
    const proc = mounts.filter((line) => line.split(' ')[4] === '/proc');
    if (proc.length !== 1 || !proc[0]!.includes(' - proc ')) throw new Error();
    if (/hidepid=(?!0(?:,|\s|$))/.test(proc[0]!) || /subset=/.test(proc[0]!))
      throw new Error();
    if (
      mounts.some((line) =>
        /^\/proc\/\d+(?:\/|$)/.test(line.split(' ')[4] ?? ''),
      )
    )
      throw new Error();
    const namespaces = ['pid', 'mnt', 'user', 'time'].map((name) => {
      const value = this.os.link(`/proc/self/ns/${name}`);
      if (!new RegExp(`^${name}:\\[\\d+\\]$`).test(value)) throw new Error();
      return value;
    });
    // Verify proc's PID numbering corresponds to this process's PID namespace.
    const self = this.os.read('/proc/self/stat');
    const start = stat(self, this.os.pid);
    if (stat(this.os.read(`/proc/${this.os.pid}/stat`), this.os.pid) !== start)
      throw new Error();
    const uid = this.os
      .read('/proc/self/status')
      .match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m)?.[0];
    if (!uid) throw new Error();
    return {
      boot,
      scope: JSON.stringify([namespaces, proc[0], uid.trim()]),
      start,
    };
  }
  capture(): ProcessOwner {
    let identity: ProcessOwner['identity'] = null;
    try {
      identity = this.scope();
    } catch {
      /* Unsupported inspection never blocks normal work. */
    }
    return {
      instanceId: randomUUID(),
      platform: this.os.platform,
      pid: this.os.pid,
      identity,
    };
  }
  inspect(owner: ProcessOwner | null): ProcessObservation {
    const result = (
      state: ProcessObservation['state'],
      reason: ProcessObservation['reason'],
    ): ProcessObservation => ({
      state,
      reason,
      observedAt: new Date().toISOString(),
    });
    if (!owner?.identity || owner.platform !== 'linux')
      return result('unknown', 'IDENTITY_UNAVAILABLE');
    try {
      const before = this.scope();
      if (
        owner.identity.boot !== before.boot ||
        owner.identity.scope !== before.scope
      )
        return result('unknown', 'SCOPE_MISMATCH');
      let start: string | null;
      try {
        start = stat(this.os.read(`/proc/${owner.pid}/stat`), owner.pid);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
        start = null;
      }
      const after = this.scope();
      if (before.boot !== after.boot || before.scope !== after.scope)
        return result('unknown', 'SCOPE_MISMATCH');
      if (start === null) return result('abandoned', 'PROCESS_ABSENT');
      return start === owner.identity.start
        ? result('active', 'OWNER_ALIVE')
        : result('abandoned', 'PID_REUSED');
    } catch {
      return result('unknown', 'INSPECTION_UNAVAILABLE');
    }
  }
}
