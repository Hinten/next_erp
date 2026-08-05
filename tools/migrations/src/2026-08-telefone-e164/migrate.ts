import {
  FieldPath,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import { buildUpdate, planTelefone, readNested } from './transform';

/**
 * Backfill: every stored telefone → the E.164 wire format
 * (`5511999998888`, digits only, no `+`). Idempotent, dry-run by default.
 * Runbook + the target ordering: `tools/migrations/telefone-e164.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:telefone-e164 -- \
 *     --project <staging-id>                      # dry-run, clientes only
 *   pnpm --filter @delfrance/migrations migrate:telefone-e164 -- \
 *     --project <staging-id> --apply              # write
 *   pnpm --filter @delfrance/migrations migrate:telefone-e164 -- \
 *     --project <id> --target clientes,cheque     # pick targets explicitly
 *
 * ⚠️ Targets are OPT-IN and the default is `clientes` alone. The endereço
 * family (`endereco`, `filial`, `intFrete`) feeds Melhor Envio's `from.phone` /
 * `to.phone`, and whether ME accepts a `55`-prefixed value is an OPEN QUESTION
 * — normalizing those before it is answered could break label purchase. Do not
 * enable that group until the ME issue closes.
 */

const PAGE_SIZE = 300;

/** A collection + the (possibly nested) field within it that holds a phone. */
interface TelefoneTarget {
  readonly name: string;
  /** Collection group, so subcollections are reached without walking parents. */
  readonly collectionGroup: string;
  readonly field: readonly string[];
  readonly note: string;
}

const TARGETS: readonly TelefoneTarget[] = [
  {
    name: 'clientes',
    collectionGroup: 'clientes',
    field: ['telefone'],
    note: 'the dedup key and the WhatsApp wa_id join — the only field with the isValidTelefone refine',
  },
  {
    name: 'endereco',
    collectionGroup: 'enderecos',
    field: ['telefone'],
    note: 'GATED on the Melhor Envio shape decision — feeds to.phone',
  },
  {
    name: 'filial',
    collectionGroup: 'filiais',
    field: ['sede', 'telefone'],
    note: 'GATED on the Melhor Envio shape decision — feeds from.phone',
  },
  {
    name: 'intFrete',
    collectionGroup: 'int_frete',
    field: ['enderecoDeOrigem', 'telefone'],
    note: 'GATED on the Melhor Envio shape decision — the freight-origin address',
  },
  {
    name: 'cheque',
    collectionGroup: 'pagamentos',
    field: ['cheque', 'telefone'],
    note: 'inert — never displayed, queried or transmitted',
  },
];

const DEFAULT_TARGETS = ['clientes'] as const;

export class UnknownTargetError extends Error {
  constructor(name: string) {
    super(`Unknown --target "${name}". Known targets: ${TARGETS.map((t) => t.name).join(', ')}.`);
    this.name = 'UnknownTargetError';
  }
}

/**
 * Resolve `--target a,b` (parsed by the shared runner) to the target set.
 * Empty selection means the safe default — `clientes` alone.
 */
export function resolveTargets(names: readonly string[]): TelefoneTarget[] {
  const selected = names.length > 0 ? names : DEFAULT_TARGETS;
  return selected.map((name) => {
    const target = TARGETS.find((t) => t.name === name);
    if (!target) throw new UnknownTargetError(name);
    return target;
  });
}

/** Page by document id — a stable cursor with bounded memory. */
async function* pagesByDocId(
  coll: CollectionReference | Query,
): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = coll.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  const targets = resolveTargets(ctx.args.targets);
  log(`[telefone-e164] targets: ${targets.map((t) => t.name).join(', ')}`);

  let docsScanned = 0;
  let docsChanged = 0;

  for (const target of targets) {
    log(`[telefone-e164] ${target.name} (${target.collectionGroup}) — ${target.note}`);
    // A collection group reaches `clientes/{id}/enderecos` and
    // `pedidos/{id}/pagamentos` without walking their parents. It is unindexed
    // on Enterprise, hence a full scan — acceptable for a one-shot migration,
    // and the reason this is a manual run rather than anything scheduled.
    for await (const docs of pagesByDocId(ctx.db.collectionGroup(target.collectionGroup))) {
      for (const doc of docs) {
        docsScanned += 1;
        const stored = readNested(doc.data() as Record<string, unknown>, target.field);
        const plan = planTelefone(stored);
        const field = target.field.join('.');
        if (plan.action === 'skip') {
          // An absent field is the overwhelming majority on a collection group
          // (every doc without a phone at all) — not worth a log line each.
          if (plan.reason !== 'empty') {
            ctx.sink.skip(doc.ref.path, field, plan.value, plan.reason);
          }
          continue;
        }
        ctx.sink.change(doc.ref.path, field, plan.from, plan.to);
        docsChanged += 1;
        await ctx.writer.update(doc.ref, buildUpdate(target.field, plan.to));
      }
    }
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('telefone-e164', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
