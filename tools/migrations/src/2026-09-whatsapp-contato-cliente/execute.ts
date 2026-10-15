import {
  fingerprint,
  WhatsappMigrationError,
  type Raw,
  type WhatsappMigrationPlan,
} from './transform';

/** Native preconditions belong in the adapter; decisions remain fake-testable. */
export interface StoredDocument {
  data: Raw;
  version: unknown;
}
export interface MigrationStore {
  read(path: string): Promise<StoredDocument | null>;
  create(path: string, data: Raw): Promise<void>;
  replace(path: string, data: Raw, version: unknown): Promise<void>;
  remove(path: string, version: unknown): Promise<void>;
  /** Full recursive inventory under chat roots, including missing-parent docs. */
  descendantPaths(root: string): Promise<string[]>;
}
export interface MigrationLog {
  (record: { kind: string; path: string; fingerprint?: string }): void;
}

const same = (a: Raw, b: Raw): boolean => fingerprint(a) === fingerprint(b);
const allowed = (path: string): boolean =>
  /^(chat|clientes|whatsappConversas|whatsappIdentidades|whatsappMensagens|whatsappConversaAliases)\/[^/]+(?:\/[^/]+\/[^/]+)*$/.test(
    path,
  );

export function validatePlan(
  plan: WhatsappMigrationPlan,
  projectId: string,
  allowPending = false,
): void {
  if (plan.version !== 1 || plan.projectId !== projectId)
    throw new WhatsappMigrationError('Manifesto de outra versão/projeto');
  if (plan.conflicts.length)
    throw new WhatsappMigrationError(`${plan.conflicts.length} conflitos bloqueiam a aplicação`);
  if (plan.pending.length && !allowPending)
    throw new WhatsappMigrationError(
      `${plan.pending.length} pendências legadas exigem decisão no manifesto antes da aplicação`,
    );
  const targets = new Set<string>();
  for (const write of plan.writes) {
    if (!allowed(write.path) || targets.has(write.path))
      throw new WhatsappMigrationError(`Destino inválido/duplicado: ${write.path}`);
    targets.add(write.path);
  }
  for (const path of plan.deletes) {
    if (
      !path.startsWith('chat/') ||
      targets.has(path) ||
      !plan.sources.some((s) => s.path === path)
    ) {
      throw new WhatsappMigrationError(`Exclusão fora do inventário: ${path}`);
    }
  }
}

/** Entire preflight precedes the first write; drift never leaves a half-started pass. */
export async function preflightPlan(
  store: MigrationStore,
  plan: WhatsappMigrationPlan,
): Promise<void> {
  const writes = new Map(plan.writes.map((w) => [w.path, w]));
  const deleted = new Set(plan.deletes);
  for (const source of plan.sources) {
    const current = await store.read(source.path);
    if (!current && deleted.has(source.path)) continue; // interrupted finalization
    if (
      current &&
      (same(current.data, source.data) ||
        (writes.has(source.path) && same(current.data, writes.get(source.path)!.after)))
    )
      continue;
    throw new WhatsappMigrationError(`Documento mudou desde o inventário: ${source.path}`);
  }
  for (const write of plan.writes) {
    const current = await store.read(write.path);
    if (!current && write.before === null) continue;
    if (
      current &&
      (same(current.data, write.after) || (write.before && same(current.data, write.before)))
    )
      continue;
    throw new WhatsappMigrationError(`Destino mudou desde o inventário: ${write.path}`);
  }
  // Detect additions after the scan, not just changes to documents already known.
  const known = new Set([...plan.sources.map((d) => d.path), ...plan.writes.map((d) => d.path)]);
  const roots = plan.sources.filter((s) => /^chat\/[^/]+$/.test(s.path)).map((s) => s.path);
  for (const root of roots)
    for (const path of await store.descendantPaths(root)) {
      if (!known.has(path))
        throw new WhatsappMigrationError(`Novo documento fora do inventário: ${path}`);
    }
}

export async function verifyPlan(
  store: MigrationStore,
  plan: WhatsappMigrationPlan,
  finalized = false,
): Promise<void> {
  validatePlan(plan, plan.projectId);
  for (const write of plan.writes) {
    const current = await store.read(write.path);
    if (!current || !same(current.data, write.after))
      throw new WhatsappMigrationError(`Destino não verificado: ${write.path}`);
  }
  if (finalized)
    for (const path of plan.deletes) {
      if (await store.read(path)) throw new WhatsappMigrationError(`Origem ainda existe: ${path}`);
    }
}

/** Copy, verify, then optionally remove old paths. Resume uses before/after hashes. */
export async function executePlan(
  store: MigrationStore,
  plan: WhatsappMigrationPlan,
  options: { apply: boolean; finalize: boolean; log: MigrationLog },
): Promise<{ writes: number; deletes: number }> {
  validatePlan(plan, plan.projectId, !options.apply);
  await preflightPlan(store, plan);
  let writes = 0;
  let deletes = 0;
  for (const write of plan.writes) {
    const current = await store.read(write.path);
    if (current && same(current.data, write.after)) {
      options.log({
        kind: 'already-applied',
        path: write.path,
        fingerprint: fingerprint(write.after),
      });
      continue;
    }
    if (current ? !write.before || !same(current.data, write.before) : write.before !== null) {
      throw new WhatsappMigrationError(`Conflito durante aplicação: ${write.path}`);
    }
    if (options.apply) {
      if (current) await store.replace(write.path, write.after, current.version);
      else await store.create(write.path, write.after);
    }
    options.log({
      kind: options.apply ? 'write' : 'would-write',
      path: write.path,
      fingerprint: fingerprint(write.after),
    });
    writes += 1;
  }
  if (!options.apply) {
    for (const path of plan.deletes) options.log({ kind: 'would-delete-after-verification', path });
    return { writes, deletes: 0 };
  }
  await verifyPlan(store, plan);
  if (options.finalize) {
    await preflightPlan(store, plan);
    const sources = new Map(plan.sources.map((s) => [s.path, s.data]));
    // Children first; onConversaDeleted sees an empty subtree if it is deployed.
    const order = [...plan.deletes].sort(
      (a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b, 'en'),
    );
    for (const path of order) {
      const current = await store.read(path);
      if (!current) continue;
      if (!same(current.data, sources.get(path)!))
        throw new WhatsappMigrationError(`Origem mudou antes da exclusão: ${path}`);
      await store.remove(path, current.version);
      options.log({ kind: 'delete', path });
      deletes += 1;
    }
    await verifyPlan(store, plan, true);
  }
  return { writes, deletes };
}
