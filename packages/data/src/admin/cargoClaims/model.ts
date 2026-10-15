import { z } from 'zod';
import { accessOperationSchema, type AccessOperation } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

// Operational collections are Admin-only and intentionally absent from ALL_DOMAINS.
export const accessOperations = defineAdminCollection({
  path: 'accessOperations',
  schema: accessOperationSchema,
});
export const accessControl = defineAdminCollection({
  path: 'accessControl',
  schema: z.object({
    activeId: z.string().nullable(),
    lastId: z.string().nullable(),
  }),
});
export const VALIDATION_PAGE_SIZE = 100;
export const APPLICATION_PAGE_SIZE = 20;
export const WORKER_TIMEOUT_SECONDS = 120;
export const LEASE_MS = 240_000;
export const MAX_ATTEMPTS = 5;
export class AccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly operationId: string | null = null,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}
export function isCargo(op: Pick<AccessOperation, 'command'>) {
  return op.command.action.endsWith('Cargo');
}
export function busy(id: string): never {
  throw new AccessError(
    409,
    'ACCESS_BUSY',
    'Uma atualização de acesso está em andamento. Aguarde sua conclusão.',
    id,
  );
}
