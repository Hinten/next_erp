import { z } from 'zod';

/**
 * Database mapping — kept opaque on this side. The Flutter app uses this
 * to fan out queries across regional Firestore databases; the Next.js app
 * reads it but does not act on it (single-database mode for now).
 */
export const databaseMapSchema = z
  .object({
    database: z.string(),
    region: z.string().optional(),
  })
  .passthrough();

/**
 * GrupoEconomico — top-level tenant entity. Mirrors the Flutter package
 * `packages/grupo_economico/lib/src/models.dart` shape so both apps coexist
 * against the same Firestore documents during the migration.
 *
 * The Flutter base class injects `docId`, `createTime`, `updateTime`,
 * `readTime`. Those are managed by the data layer (Firestore metadata),
 * not stored on the document, so they are absent here.
 */
export const grupoEconomicoSchema = z.object({
  nome: z.string().min(1).max(255),
  databases: z.array(z.string()).default([]),
  databaseMap: z.array(databaseMapSchema).default([]),
  users: z.array(z.string()).default([]),
});

export type GrupoEconomico = z.infer<typeof grupoEconomicoSchema>;
export type DatabaseMap = z.infer<typeof databaseMapSchema>;

/**
 * Firestore collection path for GrupoEconomico documents. Top-level,
 * matches the Flutter app's `@EasyFirebase(collectionName: 'grupoEconomico')`
 * default. Fixed string — no `{}` placeholders since this IS the tenant
 * registry.
 */
export const GRUPO_ECONOMICO_COLLECTION_PATH = 'grupoEconomico';
