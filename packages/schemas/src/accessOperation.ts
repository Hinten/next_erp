import { z } from 'zod';
import { cargoSchema } from './cargo';
import { usuarioSchema } from './usuario';

export const ACCESS_ACTION = {
  createCargo: 'createCargo',
  updateCargo: 'updateCargo',
  deleteCargo: 'deleteCargo',
  createUser: 'createUser',
  updateUser: 'updateUser',
  refreshUser: 'refreshUser',
} as const;
export const accessActionSchema = z.enum(ACCESS_ACTION);
export const ACCESS_PHASE = {
  provisioning: 'provisioning',
  validating: 'validating',
  applying: 'applying',
  completed: 'completed',
  rejected: 'rejected',
  failed: 'failed',
} as const;
export const accessPhaseSchema = z.enum(ACCESS_PHASE);
export const accessIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const accessCommandSchema = z.object({
  action: accessActionSchema,
  targetId: accessIdSchema,
  expectedVersion: z.string().max(100).nullable(),
  cargo: cargoSchema.nullable().default(null),
  usuario: usuarioSchema.nullable().default(null),
});
export type AccessCommand = z.infer<typeof accessCommandSchema>;
export const accessOperationSchema = z.object({
  id: accessIdSchema,
  actorId: z.string(),
  ceiling: z.string(),
  command: accessCommandSchema,
  phase: accessPhaseSchema,
  committed: z.boolean(),
  cursor: z.string().nullable(),
  validated: z.number(),
  processed: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  missing: z.number(),
  external: z.number(),
  attempts: z.number(),
  startedAt: z.number(),
  progressAt: z.number(),
  finishedAt: z.number().nullable(),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.number(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  errorTarget: z.string().nullable(),
});
export type AccessOperation = z.infer<typeof accessOperationSchema>;
export const accessAcceptedSchema = z.object({
  operationId: accessIdSchema,
  targetId: accessIdSchema,
});
export type AccessAccepted = z.infer<typeof accessAcceptedSchema>;
