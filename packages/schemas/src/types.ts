import type { z } from 'zod';

/**
 * Metadata attached to every domain schema. The data layer and the rules
 * generator both read this to drive collection access and Firestore rules.
 */
export interface CollectionMetadata {
  /**
   * Firestore collection path. Use `{parentId}` placeholders for
   * subcollections (e.g. `'clientes/{clienteId}/enderecos'`). The runtime
   * resolves placeholders using the context passed to the data layer.
   *
   * Multi-tenancy in Delfrance is enforced via document fields
   * (`grupoEconomico`, `userCliente`, etc.) inside Firestore rules — not via
   * path prefixes — to keep parity with the Flutter app's existing data.
   */
  collectionPath: string;
  /**
   * Permission bits required to read/write/delete. BigInt literals so we can
   * express permission sets larger than 53 bits (Firestore claims store them
   * as strings).
   */
  permissions: {
    read: bigint;
    write: bigint;
    delete: bigint;
  };
  /**
   * Cascade declarations: subcollection paths that must be deleted with the
   * parent (`onDelete: 'cascade'`) or that must block parent deletion when
   * non-empty (`onDelete: 'restrict'`).
   */
  cascade?: ReadonlyArray<{
    path: string;
    onDelete: 'cascade' | 'restrict';
  }>;
}

export interface DomainSchema<T extends z.ZodTypeAny> {
  schema: T;
  meta: CollectionMetadata;
}
