import { clienteMeta, clienteSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `clientes` collection. Writes are validated
 * against `clienteSchema` before they hit Firestore; the path comes from the
 * schema's metadata so it stays a single source of truth. Used by
 * server-side sem-auth contact resolution (e.g. the WhatsApp
 * `discover_user` port, #527) that needs to find-or-create a client outside
 * a browser session.
 */
export const clienteCollection = defineAdminCollection({
  path: clienteMeta.collectionPath,
  schema: clienteSchema,
});
