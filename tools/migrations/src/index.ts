// Reusable migration framework (the per-migration scripts live in dated
// subfolders, e.g. `2026-06-pedido-pagamento-micros/`).
export {
  BatchWriter,
  ChangeSink,
  MigrationArgError,
  parseArgs,
  runMigration,
  type MigrationArgs,
  type MigrationContext,
  type MigrationSummary,
} from './runner';
export { migrationDb } from './admin';
