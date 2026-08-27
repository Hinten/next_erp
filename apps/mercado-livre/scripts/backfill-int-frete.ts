/**
 * One-shot backfill for #782: give every Mercado Livre conta its Mercado Envios
 * `int_frete` companion doc.
 *
 * `onIntegracaoMercadoLivreChanged` keeps the doc in sync from here on, but it
 * deliberately skips a conta write that moved none of the mirrored fields — so a
 * no-op touch will NOT create a missing doc, and contas connected in the new UI
 * before the trigger shipped have no doc at all. This script drives the exact same
 * production core (`sincronizarIntFreteDaConta`), so the backfill and the trigger
 * can never disagree. It is idempotent: an already-synced project writes nothing,
 * and it normalizes any `contaMercadoLivreMercadoEnviosOuterRef` still stored in
 * the bare `integracao/<id>` form.
 *
 *   # dry run — reports what WOULD change, writes nothing
 *   pnpm --filter @delfrance/mercado-livre-app backfill:int-frete -- --project <id>
 *   # apply
 *   pnpm --filter @delfrance/mercado-livre-app backfill:int-frete -- --project <id> --apply
 *
 * `--project` is REQUIRED and never inferred — the same discipline as
 * `tools/migrations` — so a stray `FIREBASE_PROJECT_ID` can't point this at
 * production by accident.
 */
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '../lib/firebase/admin';
import {
  buscarIntFreteDaConta,
  montarCamposIntFrete,
  sincronizarIntFreteDaConta,
} from '../lib/marketplace/frete/intFreteSync';

const PAGE_SIZE = 200;

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI progress output
  console.log(message);
}

class BackfillArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillArgError';
  }
}

function parseArgs(argv: readonly string[]): { projectId: string; apply: boolean } {
  let projectId: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--project') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new BackfillArgError('--project requires a value.');
      }
      projectId = next;
      i += 1;
    } else if (arg.startsWith('--project=')) projectId = arg.slice('--project='.length);
    else throw new BackfillArgError(`Unknown argument: ${arg}`);
  }
  if (!projectId || projectId.trim().length === 0) {
    throw new BackfillArgError(
      '--project <id> is required. This backfill refuses to guess the target project.',
    );
  }
  return { projectId: projectId.trim(), apply };
}

/**
 * Page the ML contas by `nome` — the one ordering backed by the existing
 * `integracao(tipo, nome)` index. Ordering by `__name__` instead would need an
 * index that does not exist, and Enterprise would silently full-scan.
 */
async function* pagesDeContas(db: Firestore): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = integracaoCollection
      .ref(db, {})
      .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
      .orderBy('nome')
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

async function main(): Promise<void> {
  const { projectId, apply } = parseArgs(process.argv.slice(2));
  // getAdminFirestore() resolves the project from env; pin it to the explicit flag
  // so the credentials and the target can't drift apart.
  process.env.FIREBASE_PROJECT_ID = projectId;
  const db = getAdminFirestore();
  const nowMs = Date.now();

  log(`[backfill:int-frete] project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const totals: Record<string, number> = {};
  let contas = 0;

  for await (const docs of pagesDeContas(db)) {
    for (const doc of docs) {
      contas += 1;
      const conta = doc.data() as Record<string, unknown>;

      if (apply) {
        const disposicao = await sincronizarIntFreteDaConta(db, doc.id, conta, nowMs);
        totals[disposicao.action] = (totals[disposicao.action] ?? 0) + 1;
        log(
          `  ${doc.id} → ${disposicao.action}${fmtDetalhe(disposicao.campos, disposicao.faltando)}`,
        );
        continue;
      }

      // Dry run: the same decision, read-only. `buscarIntFreteDaConta` and
      // `montarCamposIntFrete` are exactly what the sync uses to decide.
      const { campos, faltando } = montarCamposIntFrete(doc.id, conta);
      const existente = await buscarIntFreteDaConta(db, doc.id);
      let action: string;
      let detalhe: string[] | undefined;
      if (existente == null) {
        action = faltando.length > 0 ? 'incompleto' : 'criado';
        detalhe = faltando.length > 0 ? faltando : Object.keys(campos);
      } else {
        const difs = Object.entries(campos)
          .filter(([campo, valor]) => existente.data[campo] !== valor)
          .map(([campo]) => campo);
        action = difs.length > 0 ? 'atualizado' : 'inalterado';
        detalhe = difs.length > 0 ? difs : undefined;
      }
      totals[action] = (totals[action] ?? 0) + 1;
      log(`  ${doc.id} → ${action}${detalhe ? ` [${detalhe.join(', ')}]` : ''}`);
    }
  }

  const resumo = Object.entries(totals)
    .map(([action, n]) => `${action}=${n}`)
    .join(' ');
  log(
    `[backfill:int-frete] done: ${contas} contas Mercado Livre — ${resumo || 'nenhuma'}. ` +
      `${apply ? 'APPLIED.' : 'DRY-RUN — no writes performed.'}`,
  );
}

function fmtDetalhe(campos?: string[], faltando?: string[]): string {
  const list = faltando ?? campos;
  return list && list.length > 0 ? ` [${list.join(', ')}]` : '';
}

await main();
