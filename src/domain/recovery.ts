import { z } from 'zod';

export const processOwnerSchema = z.strictObject({
  instanceId: z.uuid(),
  platform: z.string(),
  pid: z.number().int().positive(),
  identity: z
    .strictObject({
      start: z.string().regex(/^\d+$/),
      boot: z.string().uuid(),
      scope: z.string().min(1),
    })
    .nullable(),
});
export type ProcessOwner = z.infer<typeof processOwnerSchema>;
export type ProcessObservation = {
  state: 'active' | 'abandoned' | 'unknown';
  reason:
    | 'OWNER_ALIVE'
    | 'PROCESS_ABSENT'
    | 'PID_REUSED'
    | 'IDENTITY_UNAVAILABLE'
    | 'SCOPE_MISMATCH'
    | 'INSPECTION_UNAVAILABLE';
  observedAt: string;
};
export interface ProcessInspector {
  capture(): ProcessOwner;
  inspect(owner: ProcessOwner | null): ProcessObservation;
}
export const LOCAL_INTERRUPTION_NOTICE =
  'Interruption describes local execution state only. Remote requests may still complete; cancellation, completion and billing are unknown.';
