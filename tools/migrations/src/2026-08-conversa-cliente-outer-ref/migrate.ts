import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  type MigrationContext,
  type MigrationSummary,
  isMainModule,
  runMigration,
} from '../runner';
import {
  type ClienteRow,
  type ClientesPorUsuario,
  indexarClientesPorUsuario,
  planConversaClienteRef,
} from './transform';

/**
 * Backfill `chat/{id}.clienteOuterRef` from `usarioOuterRef`, so the inbox's
 * Cliente filter can be a single equality on one field. See `transform.ts` for
 * the mapping and for why an unmapped conversa is reported rather than guessed.
 *
 *   pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref \
 *     --project <project-id> --report-only  # pre-flight: counts every verdict
 *   pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref \
 *     --project <project-id>            # dry-run: logs every doc it would touch
 *   pnpm --filter @delfrance/migrations migrate:conversa-cliente-outer-ref \
 *     --project <project-id> --apply    # write
 *
 * Run `--report-only` FIRST. A dry-run enumerates documents; the numbers that
 * decide whether this is ready are how many land on `sem-cliente` and `ambiguo`,
 * because those need a human BEFORE an `--apply` run rather than after it. An
 * `ambiguo` count above zero means duplicated cliente identities exist in the
 * corpus, which is its own decision (#1067) and not this pass's to make.
 *
 * ---- ⚠️ WHEN. Inside the cutover window (root `CLAUDE.md` rule 8 / ADR 0013),
 * and **after** the legacy data import — the corpus has to be there to map. It
 * must also land **before** the `chat(clienteOuterRef, ultima_modificacao)`
 * index is relied on by `apps/web` (#1160), or the first operator to filter by
 * a customer sees a correct-looking but half-empty list. Running early is not
 * harmful — the pass is idempotent — it is simply not finished, because the
 * legacy app keeps writing the source project until the window switches it off.
 *
 * ---- ⚠️ This writes DATA ONLY, and only where the field is ABSENT. It never
 * overwrites a `clienteOuterRef` a live writer already set. Readers keep their
 * `usarioOuterRef` fallback (`useClienteLink`) exactly as it is: `sem-cliente`
 * and `ambiguo` conversas will still have no cliente ref after this runs, and
 * that fallback is what keeps them usable.
 *
 * ---- Cost, honestly: ONE root-collection scan of `clientes` to build the uid
 * index, then ONE root-collection scan of `chat`. Firestore Enterprise bills
 * DATA SCANNED, so the index is built once in memory rather than issuing a
 * `where('userCliente','in',…)` per conversa — that would be one query per
 * document and would need the `clientes(userCliente ASC)` index hit N times.
 * Both scans are paged by document key, Firestore's always-available native
 * ordering, so neither needs an index. A `where` could not narrow the `chat`
 * scan either: the documents that need changing are the ones where a field is
 * MISSING, and Firestore cannot query for the absence of a field.
 */

const PAGE_SIZE = 300;

/** Page a root collection by document key. */
async function* pagesByDocId(
  ctx: MigrationContext,
  colecao: string,
): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db.collection(colecao).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Read every `clientes` doc once and index it by the uid its `userCliente`
 * names. Built up front because the alternative — a lookup per conversa — turns
 * one scan into N queries against a collection this pass reads in full anyway.
 */
async function carregarIndice(ctx: MigrationContext): Promise<{
  indice: ClientesPorUsuario;
  clientesLidos: number;
}> {
  const rows: ClienteRow[] = [];
  for await (const docs of pagesByDocId(ctx, 'clientes')) {
    for (const doc of docs) rows.push({ id: doc.id, userCliente: doc.data().userCliente });
  }
  return { indice: indexarClientesPorUsuario(rows), clientesLidos: rows.length };
}

/**
 * `--report-only`: classify every conversa and print counts, writing nothing.
 * This answers what a dry-run cannot — how much of the corpus is mappable at
 * all, and whether any `ambiguo` exists, which is the one verdict that has to be
 * resolved by a human before `--apply`.
 */
async function runReport(ctx: MigrationContext): Promise<MigrationSummary> {
  const { indice, clientesLidos } = await carregarIndice(ctx);

  const veredito = new Map<string, number>();
  const motivos = new Map<string, number>();
  const conta = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  const ambiguos: string[] = [];
  let docsScanned = 0;

  for await (const docs of pagesByDocId(ctx, 'chat')) {
    for (const doc of docs) {
      docsScanned += 1;
      const d = doc.data();
      const v = planConversaClienteRef(
        { clienteOuterRef: d.clienteOuterRef, usarioOuterRef: d.usarioOuterRef },
        indice,
      );
      conta(veredito, v.kind);
      if (v.kind === 'ref-invalida') conta(motivos, v.motivo);
      if (v.kind === 'ambiguo' && ambiguos.length < 20) {
        ambiguos.push(`${doc.ref.path} → usuario ${v.usuarioId} → ${v.clienteIds.join(', ')}`);
      }
    }
  }

  const linhas = [
    '[conversa-cliente-outer-ref] REPORT',
    `  clientes indexados: ${clientesLidos} doc(s) → ${indice.size} usuario(s) referenciado(s)`,
    `  chat: ${docsScanned} conversa(s)`,
  ];
  for (const [k, n] of [...veredito.entries()].sort((a, b) => b[1] - a[1])) {
    linhas.push(`    ${k.padEnd(16)} ${String(n).padStart(8)}`);
  }
  for (const [motivo, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1])) {
    linhas.push(`      ref-invalida: ${String(n).padStart(6)}  ${motivo}`);
  }
  if (ambiguos.length > 0) {
    linhas.push('  ⚠️ ambíguos (amostra) — cada um precisa de decisão humana (#1067):');
    for (const a of ambiguos) linhas.push(`      ${a}`);
  }

  // eslint-disable-next-line no-console -- the report IS the deliverable
  console.log(linhas.join('\n'));
  return { docsScanned, docsChanged: 0 };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.reportOnly) return runReport(ctx);

  const { indice } = await carregarIndice(ctx);

  let docsScanned = 0;
  let docsChanged = 0;
  let semCliente = 0;
  let ambiguos = 0;
  let invalidas = 0;
  let conflitos = 0;

  for await (const docs of pagesByDocId(ctx, 'chat')) {
    for (const doc of docs) {
      docsScanned += 1;
      const d = doc.data();
      const verdict = planConversaClienteRef(
        { clienteOuterRef: d.clienteOuterRef, usarioOuterRef: d.usarioOuterRef },
        indice,
      );

      switch (verdict.kind) {
        case 'ja-normalizado':
        case 'sem-usuario':
          continue;

        case 'ref-invalida':
          invalidas += 1;
          ctx.sink.skip(doc.ref.path, 'usarioOuterRef', verdict.valor, verdict.motivo);
          continue;

        case 'sem-cliente':
          // The contact was never paired with a cliente, or its cliente is gone.
          // A ref built from the uid would point at a doc that does not exist.
          semCliente += 1;
          ctx.sink.skip(
            doc.ref.path,
            'clienteOuterRef',
            verdict.usuarioId,
            'nenhum cliente aponta para este usuario',
          );
          continue;

        case 'ambiguo':
          // Duplicated cliente identity. Merging clientes is a human decision
          // (#1067), never a side effect of a backfill.
          ambiguos += 1;
          ctx.sink.skip(
            doc.ref.path,
            'clienteOuterRef',
            verdict.clienteIds,
            `${verdict.clienteIds.length} clientes apontam para o usuario ${verdict.usuarioId}`,
          );
          continue;

        case 'resolvido': {
          // ⚠️ tier 1 (root `CLAUDE.md` rule 7): the patch is DERIVED from this
          // snapshot, so it asserts the snapshot's `updateTime`. A blind update
          // holds `ja-normalizado` only at READ time, and the gap to the write
          // is real — `orderMessageImport.ts` sets `clienteOuterRef` on EXISTING
          // conversas inside its own watermark transaction, deriving the cliente
          // from `pedido.clientePedidoOuterRef` rather than the usuario hop used
          // here. When the two disagree, the loser must be REPORTED, not
          // silently overwritten — and the ML side’s guard cannot see a write
          // made outside its transaction.
          const gravou = await ctx.writer.updateGuarded(
            doc.ref,
            { clienteOuterRef: verdict.para },
            doc.updateTime,
          );
          if (!gravou) {
            conflitos += 1;
            ctx.sink.skip(
              doc.ref.path,
              'clienteOuterRef',
              verdict.para,
              'documento alterado depois da leitura — outro escritor venceu, nada foi sobrescrito',
            );
            continue;
          }
          ctx.sink.change(doc.ref.path, 'clienteOuterRef', null, verdict.para);
          docsChanged += 1;
          continue;
        }
      }
    }
  }

  if (conflitos > 0) {
    // eslint-disable-next-line no-console -- operator-facing run summary
    console.log(
      `[conversa-cliente-outer-ref] ${conflitos} conversa(s) alteradas por outro ` +
        `escritor entre a leitura e a escrita — NADA foi sobrescrito. O passe é ` +
        `idempotente: rode de novo e elas serão reavaliadas contra o valor atual.`,
    );
  }

  if (semCliente > 0 || ambiguos > 0 || invalidas > 0) {
    // eslint-disable-next-line no-console -- operator-facing run summary
    console.log(
      `[conversa-cliente-outer-ref] NÃO alteradas: ${semCliente} sem cliente, ${ambiguos} ` +
        `ambíguas, ${invalidas} com usarioOuterRef inválido. Procure "skip" no JSONL, ou rode ` +
        `--report-only para o resumo. As ambíguas indicam identidades de cliente duplicadas ` +
        `(#1067) e precisam de decisão humana; as demais continuam legíveis pela UI, que ainda ` +
        `resolve o cliente pelo usarioOuterRef.`,
    );
  }

  return { docsScanned, docsChanged };
}

// ⚠️ `isMainModule`, never an `argv[1].endsWith('migrate.ts')` test: EVERY
// module in this package is named `migrate.ts`, so that shape answers "is the
// entrypoint called migrate.ts", not "is the entrypoint me" (`runner.ts:28-33`).
if (isMainModule(import.meta.url)) {
  runMigration('conversa-cliente-outer-ref', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
