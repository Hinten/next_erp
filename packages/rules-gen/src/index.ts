export { generateRulesSource } from './generate';
export { emitRules } from './emit';
export { clausesForSchema } from './constraints';
export { resolvePermissions } from './claims-map';
export { sizeGate, FAIL_BYTES, WARN_BYTES } from './size-gate';
export { DOMAINS, EXTRA_MATCH_BLOCKS, VALIDATOR_WHITELIST, WRITE_GUARDS } from './registry';
export { ARQUIVO_PATH_GUARD, type WriteGuard } from './writeGuards';
