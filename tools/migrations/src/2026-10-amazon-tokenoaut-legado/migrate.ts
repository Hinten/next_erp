import {
  FieldPath,
  type DocumentReference,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase-admin/firestore';
import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import {
  COLECAO_PAI,
  contarPorTipo,
  descreverRemocao,
  type PlanoDaConta,
  planoDaConta,
  ROTULO_DO_REGISTRO,
  SUBCOLECAO_LEGADA,
  TAMANHO_DA_PAGINA,
} from './transform';

/**
 * Delete every legacy `integracao/{contaId}/tokenoaut/{docId}` document (the
 * legacy Amazon LWA token store) from the migrated corpus. Window item W3;
 * runbook: `tools/migrations/amazon-tokenoaut-legado.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado \
 *     --project <project-id> --report-only   # census per tipo + group total; also the post-apply check (0)
 *   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado \
 *     --project <project-id>                 # dry-run: logs each document it would delete
 *   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado \
 *     --project <project-id> --apply         # delete
 *
 * ---- ⚠️ WHEN. Only inside the migration window (root `CLAUDE.md` rule 8 /
 * ADR 0013), after the Phase-2 import and before Phase-3 traffic. The legacy app
 * keeps writing `tokenoaut` on the SOURCE project until it is switched off, and
 * every export carries those documents again, so an earlier run is superseded.
 * Agents never run it.
 *
 * ---- ⚠️ Nothing a token document holds is ever read. The key walk is
 * `select()` with an EMPTY projection (document names only), the census is a
 * `count()`, and the parent is read through a field mask of `tipo` alone. A JSONL
 * row carries the document path and the parent's `tipo`, nothing else.
 *
 * ---- What it walks. The parents come from `listDocuments()` on `integracao`,
 * which also returns MISSING parents: a conta deleted without its subcollections
 * leaves its token documents behind, and a walk over existing contas would never
 * see them. That listing is not a key-walk query. The key walk is per parent, on
 * the exact subcollection name, and rides the migration-only
 * `tokenoaut (__name__ ASC)` index (Enterprise has no implicit key index,
 * `tools/migrations/key-walks.json`), because a conta's subcollection is not
 * bounded in size.
 *
 * ---- The independent total. The census also counts the whole `tokenoaut`
 * collection group, which does not depend on the parent listing. It is the only
 * check that can see a token document under a parent the listing did not return
 * (whether Enterprise's `listDocuments()` returns every missing parent is
 * unmeasured). The census prints a mismatch, and `--apply` fails unless the
 * group reads 0 after its deletes.
 *
 * ---- Race (root `CLAUDE.md` rule 7): tier 0. A blind `delete()` of a named
 * document is idempotent and order-free, and nothing is derived from a read
 * beyond "this name exists", so there is nothing to compare or guard. No writer
 * in this codebase targets `tokenoaut`, and on the new project the legacy app
 * writes nothing. A document that lands behind the walk's cursor anyway, or a
 * delete that does not land, is caught by the parent's final `count()` and the
 * group total, never trusted to the walk.
 *
 * ---- Why a raw `WriteBatch` and not the runner's `BatchWriter`: the harness
 * withholds `delete` on purpose, because a produto or estoque delete cascades
 * through Cloud Functions triggers. No trigger in this codebase watches a
 * `tokenoaut` document (the `integracao` triggers are on the parent document
 * only), so a delete here fires nothing.
 */

/** The runner's log name: the JSONL lands at `out/<stamp>-amazon-tokenoaut-legado[-dryrun].jsonl`. */
export const NOME_DA_PASSAGEM = 'amazon-tokenoaut-legado';

/** The final `count()` of a parent was not 0 after its key walk deleted every page. */
export class TokenoautRemanescenteError extends Error {
  constructor(readonly remanescentes: ReadonlyArray<{ caminho: string; restantes: number }>) {
    super(
      `${remanescentes.length} conta(s) ainda com ${SUBCOLECAO_LEGADA} depois de --apply: ` +
        remanescentes.map((r) => `${r.caminho} (${r.restantes})`).join(', ') +
        '. Algo ainda escreve nessa subcoleção; nada foi perdido, rode de novo.',
    );
    this.name = 'TokenoautRemanescenteError';
  }
}

/**
 * Every listed parent's final `count()` read 0, but the `tokenoaut` collection
 * group did not: documents remain where this pass cannot reach them (under a
 * parent the `integracao` listing did not return, or under another collection).
 * Carries the count only.
 */
export class TokenoautForaDaListagemError extends Error {
  constructor(readonly restantes: number) {
    super(
      `${restantes} documento(s) do grupo ${SUBCOLECAO_LEGADA} restam depois de --apply, fora dos ` +
        `pais que ${COLECAO_PAI}.listDocuments() devolveu: esta passagem não os alcança. ` +
        'Nada fora dos pais listados foi apagado; investigue antes de rodar de novo.',
    );
    this.name = 'TokenoautForaDaListagemError';
  }
}

export interface OpcoesDaPassagem {
  /** Documents per key page, and so per delete batch (≤ 500). */
  tamanhoDaPagina: number;
}

interface Pai {
  ref: DocumentReference;
  existe: boolean;
  tipo: unknown;
}

function log(message: string): void {
  // eslint-disable-next-line no-console -- operator-facing run output
  console.log(message);
}

/**
 * Every `integracao` parent, existing or not, with its `tipo` read through a
 * field mask: the parent may still carry other legacy credential fields, and
 * none of them is pulled into this process.
 */
async function lerPais(ctx: MigrationContext, tamanho: number): Promise<Pai[]> {
  const refs = [...(await ctx.db.collection(COLECAO_PAI).listDocuments())].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const pais: Pai[] = [];
  for (let i = 0; i < refs.length; i += tamanho) {
    const lote = refs.slice(i, i + tamanho);
    const snaps = await ctx.db.getAll(...lote, { fieldMask: ['tipo'] });
    for (const snap of snaps) {
      pais.push({
        ref: snap.ref,
        existe: snap.exists,
        tipo: snap.exists ? (snap.get('tipo') as unknown) : undefined,
      });
    }
  }
  return pais;
}

async function contar(pai: DocumentReference): Promise<number> {
  const snap = await pai.collection(SUBCOLECAO_LEGADA).count().get();
  return snap.data().count;
}

/**
 * The whole `tokenoaut` collection group, counted without the parent listing.
 * No group-scope index backs it (none is declared, and a count needs no order),
 * so on Enterprise it scans the group instead of seeking: one pass over the
 * legacy token documents before the deletion, and over an empty group after it.
 */
async function contarGrupo(ctx: MigrationContext): Promise<number> {
  const snap = await ctx.db.collectionGroup(SUBCOLECAO_LEGADA).count().get();
  return snap.data().count;
}

/**
 * One page of the parent's `tokenoaut` names in key order. `select()` with no
 * field is the empty projection: the answer carries document names only, never
 * a field of a token document.
 */
function paginaDeChaves(
  pai: DocumentReference,
  tamanho: number,
  cursor?: QueryDocumentSnapshot,
): Promise<QuerySnapshot> {
  let q = pai.collection(SUBCOLECAO_LEGADA).orderBy(FieldPath.documentId()).select().limit(tamanho);
  if (cursor) q = q.startAfter(cursor);
  return q.get();
}

interface Recenseado {
  pai: Pai;
  plano: PlanoDaConta;
  contagem: number;
}

/**
 * Count every parent's subcollection and the whole group, and print the per-tipo
 * census. Writes nothing.
 */
async function recensear(ctx: MigrationContext, tamanho: number): Promise<Recenseado[]> {
  const pais = await lerPais(ctx, tamanho);
  const linhas: Recenseado[] = [];
  for (const pai of pais) {
    const contagem = await contar(pai.ref);
    linhas.push({ pai, contagem, plano: planoDaConta({ ...pai, contagem }) });
  }
  const tally = contarPorTipo(linhas);
  const contas = [...tally.values()].reduce((a, l) => a + l.contas, 0);
  const documentos = [...tally.values()].reduce((a, l) => a + l.documentos, 0);
  const orfas = pais.filter((p) => !p.existe).length;
  const grupo = await contarGrupo(ctx);
  const saida = [
    `[${NOME_DA_PASSAGEM}] CENSO: ${pais.length} pai(s) em ${COLECAO_PAI} (${orfas} sem documento), ` +
      `${contas} com ${SUBCOLECAO_LEGADA}, ${documentos} documento(s) de ${SUBCOLECAO_LEGADA}`,
  ];
  for (const [tipo, l] of [...tally.entries()].sort()) {
    saida.push(
      `  tipo ${tipo.padEnd(12)} contas ${String(l.contas).padStart(5)}  documentos ${String(l.documentos).padStart(7)}`,
    );
  }
  saida.push(`  grupo ${SUBCOLECAO_LEGADA} (sem a listagem): ${grupo} documento(s)`);
  if (grupo !== documentos) {
    saida.push(
      `  ⚠️ DIVERGÊNCIA: o grupo ${SUBCOLECAO_LEGADA} tem ${grupo} documento(s) e os pais listados ` +
        `somam ${documentos}; esta passagem não alcança a diferença`,
    );
  }
  log(saida.join('\n'));
  return linhas;
}

/**
 * Walk one parent's names by key with a cursor. Dry-run logs each name; apply
 * deletes each page in one batch and logs its rows only AFTER the batch commits,
 * so the log never claims a delete that did not happen.
 *
 * Apply walks with a cursor too, never by re-reading the first page: that page
 * would have to step over every index entry deleted so far (Firestore's "avoid
 * skipping over recently deleted data"), quadratic on a large subcollection. A
 * deleted document's key is still a valid cursor. The walk stops on a short page;
 * a delete that did not land, or a document written behind the cursor, is left
 * to the parent's final `count()`.
 */
async function caminharPorChave(
  ctx: MigrationContext,
  r: Recenseado,
  tamanho: number,
): Promise<number> {
  const { from, to } = descreverRemocao(r.plano.tipoRelatorio);
  let vistos = 0;
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const pagina = await paginaDeChaves(r.pai.ref, tamanho, cursor);
    if (ctx.apply && !pagina.empty) {
      const lote = ctx.db.batch();
      for (const doc of pagina.docs) lote.delete(doc.ref);
      await lote.commit();
    }
    for (const doc of pagina.docs) ctx.sink.change(doc.ref.path, ROTULO_DO_REGISTRO, from, to);
    vistos += pagina.size;
    if (pagina.size < tamanho) return vistos;
    cursor = pagina.docs[pagina.docs.length - 1];
  }
}

/** The whole pass, with the page size injectable so tests can cross a page boundary. */
export async function executarTokenoautLegado(
  ctx: MigrationContext,
  opcoes: OpcoesDaPassagem,
): Promise<MigrationSummary> {
  const tamanho = opcoes.tamanhoDaPagina;
  const recenseados = await recensear(ctx, tamanho);
  if (ctx.reportOnly) return { docsScanned: recenseados.length, docsChanged: 0 };

  const alvos = recenseados.filter((r) => r.plano.acao === 'apagar');
  let documentos = 0;
  if (!ctx.apply) {
    for (const r of alvos) documentos += await caminharPorChave(ctx, r, tamanho);
    log(`[${NOME_DA_PASSAGEM}] DRY-RUN: ${documentos} documento(s) seriam apagados`);
    return { docsScanned: documentos, docsChanged: documentos };
  }

  const remanescentes: Array<{ caminho: string; restantes: number }> = [];
  for (const r of alvos) {
    documentos += await caminharPorChave(ctx, r, tamanho);
    const restantes = await contar(r.pai.ref);
    if (restantes !== 0) remanescentes.push({ caminho: r.pai.ref.path, restantes });
  }
  // Always, even with no alvo: a parent the listing missed has no alvo to walk.
  const noGrupo = await contarGrupo(ctx);
  // The runner's "writes" counter counts its BatchWriter only; the deletes are counted here.
  log(
    `[${NOME_DA_PASSAGEM}] APAGADOS: ${documentos} documento(s) de ${SUBCOLECAO_LEGADA} em ` +
      `${alvos.length} conta(s); ${noGrupo} restante(s) no grupo`,
  );
  if (remanescentes.length > 0) throw new TokenoautRemanescenteError(remanescentes);
  if (noGrupo !== 0) throw new TokenoautForaDaListagemError(noGrupo);
  return { docsScanned: documentos, docsChanged: documentos };
}

/** The pass as the runner calls it. */
export function run(ctx: MigrationContext): Promise<MigrationSummary> {
  return executarTokenoautLegado(ctx, { tamanhoDaPagina: TAMANHO_DA_PAGINA });
}

if (isMainModule(import.meta.url)) {
  runMigration(NOME_DA_PASSAGEM, run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
