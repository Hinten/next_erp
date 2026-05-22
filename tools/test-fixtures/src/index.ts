export { db, getApp, namespace } from './admin';
export { seed } from './seed';
export {
  seedClientesComEnderecos,
  cleanupClientesComEnderecos,
  SEED_MARKER,
  type SeedClientesResult,
} from './seed-clientes';
export { runTeardown, cleanupE2EDocs } from './teardown';
export { grantAllPerms, ALL_PERMS, type GrantAllPermsResult } from './grant-all-perms';
export { ensureTestUser } from './users';
