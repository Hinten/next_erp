import { CERTIFICADO_SECRETO_PATH, certificadoSecretoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the per-filial A1 certificate secret doc
 * (`filiais/{filialId}/certificadoSecreto/default`). Holds the
 * AES-256-GCM-encrypted private key plus the public cert PEM. **Admin-only**
 * — the Admin SDK bypasses Firestore rules; the generated client ruleset
 * denies access to this path so the encrypted key never reaches a browser.
 */
export const certificadoSecretoCollection = defineAdminCollection({
  path: CERTIFICADO_SECRETO_PATH,
  schema: certificadoSecretoSchema,
});
