import { clienteIdentidadeSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/** Admin-only, lazily populated strong-identity index for cliente resolution. */
export const clienteIdentidadeCollection = defineAdminCollection({
  path: 'clienteIdentidades',
  schema: clienteIdentidadeSchema,
});
