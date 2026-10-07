import { z } from 'zod';
import { mlSizeChartSchema, millisSinceEpoch } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

// Operational, Admin-only subcollections: no metadata or client rules. Keeping
// receipts outside tabMedi prevents a parent form save from erasing recovery.
export const mlChartSyncCollection = defineAdminCollection({
  path: 'tabMedi/{tabMediId}/mlChartSync',
  schema: z.object({ activeId: z.string().nullable(), lastId: z.string() }),
});

export const mlChartOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(['sync', 'delete', 'verify']),
  chartIndex: z.number().int().nonnegative(),
  desired: mlSizeChartSchema,
  projected: mlSizeChartSchema,
  baseline: z.record(z.string(), z.unknown()).nullable(),
  pending: z
    .object({
      kind: z.enum(['create', 'rename', 'row', 'delete', 'verify']),
      rowIndex: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  status: z.enum(['pending', 'completed', 'validation', 'conflict', 'unconfirmed']),
  validationErrors: z.array(
    z.object({
      chartIndex: z.number(),
      code: z.string().nullable(),
      message: z.string().nullable(),
      rowIndex: z.number().nullable(),
      attributeIds: z.array(z.string()),
      rowMainValue: z.string().nullable(),
    }),
  ),
  updated: z.boolean(),
  owner: z.string().nullable(),
  leaseUntilMs: millisSinceEpoch(),
});
export type MlChartOperation = z.infer<typeof mlChartOperationSchema>;

export const mlChartOperationCollection = defineAdminCollection({
  path: 'tabMedi/{tabMediId}/mlChartSync/{integracaoId}/mlChartSyncOperations',
  schema: mlChartOperationSchema,
});
