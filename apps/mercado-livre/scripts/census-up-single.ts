/**
 * #1087 — how many produtos are in the OLD User-Products single shape?
 *
 * Publish used to write a UP produto as a ROOT produto with no children, while
 * the importer writes the family-of-one ML actually has (parent + one child,
 * stock on the child). Publish now writes the importer's shape too, so anything
 * still in the old one is a produto that predates the change.
 *
 * The belief is that there are NONE in production — the legacy Flutter catalogue
 * is produtos WITH variations, and staging is disposable and re-seedable
 * (root `CLAUDE.md` rule 8). This script exists to turn that belief into a
 * measurement before the cutover, because "we think the corpus is empty" and "we
 * counted and it is empty" are not the same claim, and only one of them survives
 * being wrong. If it reports a non-zero count, the one-time `tools/migrations`
 * script is written then — with the count telling us what it has to handle.
 *
 *   pnpm --filter @delfrance/mercado-livre-app census:up-single -- --project <id>
 *   # ...and list the produtos rather than just counting them
 *   pnpm --filter @delfrance/mercado-livre-app census:up-single -- --project <id> --listar
 *
 * It NEVER writes. `--project` is REQUIRED and never inferred — the same
 * discipline as `tools/migrations` and `check-deposito-source.ts` — so a stray
 * `FIREBASE_PROJECT_ID` cannot point it at production by accident.
 *
 * ⚠️ **Cost.** Firestore Enterprise bills DATA SCANNED and auto-creates ZERO
 * indexes, so phase 1 needs the `produtoMercadoLivre(isUserProductModel, __name__)`
 * COLLECTION_GROUP index declared in `firestore.indexes.json`. Until that index is
 * DEPLOYED the query still runs — Enterprise never throws `FAILED_PRECONDITION` —
 * it just full-scans every link document and puts the difference on the invoice.
 * The script prints the index it wants so the reading is never a surprise.
 *
 * ⚠️ Three documents, no join. The predicate spans the link (`isUserProductModel`),
 * the produto (`paiId == null`) and its children (none) — and a collectionGroup
 * query cannot filter by parent. So it is necessarily three phases, and phases 2
 * and 3 are a key read and a `limit(1)` prefix query per candidate rather than
 * anything that scans.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';

import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { isFamilyId } from '../lib/marketplace/core/linkRefs';
import { getAdminFirestore } from '../lib/firebase/admin';

/** Candidates per page — bounded so one page is never a large read. */
const PAGE = 300;

/**
 * The index phase 1 rides. Printed rather than assumed: on Enterprise a missing
 * index is silent, so the only way an operator learns is if we say so.
 */
const INDEX_JSON = `{
  "collectionGroup": "produtoMercadoLivre",
  "queryScope": "COLLECTION_GROUP",
  "fields": [
    { "fieldPath": "isUserProductModel", "order": "ASCENDING" },
    { "fieldPath": "__name__", "order": "ASCENDING" }
  ]
}`;

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class CensusArgError extends Error {}

function parseArgs(argv: string[]): { projectId: string; listar: boolean } {
  let projectId = '';
  let listar = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === '--listar') {
      listar = true;
    } else if (name === '--project') {
      const value = inline ?? argv[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new CensusArgError('--project needs a value.');
      }
      projectId = value;
      if (inline === undefined) i += 1;
    } else {
      throw new CensusArgError(`Unknown argument: ${arg}`);
    }
  }
  if (projectId.trim() === '') {
    throw new CensusArgError(
      '--project <id> is required. This census refuses to guess the target project.',
    );
  }
  return { projectId: projectId.trim(), listar };
}

/**
 * What a candidate turned out to be. Only `antiga` is work; every other bucket is
 * reported so the totals add up and a surprising distribution is visible rather
 * than rounded away.
 */
type Veredito =
  | 'antiga' // root produto, UP link, ZERO children — the shape this counts
  | 'ja-familia' // has children already: nothing to do
  | 'filho' // the link hangs off a CHILD produto
  | 'familia-sem-filhos' // link.id is a family id and the children are gone (#1087 trap)
  | 'produto-ausente'; // dangling link

interface Achado {
  produtoId: string;
  linkDocId: string;
  linkId: string;
  veredito: Veredito;
}

async function classificar(
  db: Firestore,
  produtoId: string,
  linkDocId: string,
  linkId: string,
): Promise<Achado> {
  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  const base = { produtoId, linkDocId, linkId };
  if (!produtoSnap.exists) return { ...base, veredito: 'produto-ausente' };

  const paiId = (produtoSnap.data() ?? {}).paiId ?? null;
  if (paiId != null) return { ...base, veredito: 'filho' };

  // `limit(1)`: the question is "any child at all", never how many. Rides the
  // declared `produtos(paiId ASC, nome ASC)` index by prefix.
  const filhos = await produtoCollection.ref(db, {}).where('paiId', '==', produtoId).limit(1).get();
  if (!filhos.empty) return { ...base, veredito: 'ja-familia' };

  // Zero children AND a family id on the link is the trap #1087 describes: publish
  // refuses it, and no amount of re-importing repairs it on its own.
  if (linkId !== '' && isFamilyId(linkId)) {
    return { ...base, veredito: 'familia-sem-filhos' };
  }
  return { ...base, veredito: 'antiga' };
}

async function main(): Promise<void> {
  let args: { projectId: string; listar: boolean };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof CensusArgError)) throw err;
    log(`❌ ${err.message}`);
    process.exitCode = 1;
    return;
  }

  process.env.FIREBASE_PROJECT_ID = args.projectId;
  const db = getAdminFirestore();

  log(`[census:up-single] projeto ${args.projectId}`);
  log('[census:up-single] índice esperado (COLLECTION_GROUP):');
  log(INDEX_JSON);
  log('');

  const achados: Achado[] = [];
  let candidatos = 0;
  let cursor: string | null = null;

  for (;;) {
    let q = produtoMercadoLivreLinkCollection
      .groupQuery(db)
      .where('isUserProductModel', '==', true)
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (cursor != null) q = q.startAfter(cursor);

    const page = await q.get();
    if (page.empty) break;

    for (const d of page.docs) {
      candidatos += 1;
      const produtoId = d.ref.parent?.parent?.id;
      if (produtoId == null) continue;
      const raw = d.data() as Record<string, unknown>;
      achados.push(
        await classificar(db, produtoId, d.id, typeof raw.id === 'string' ? raw.id : ''),
      );
    }

    if (page.size < PAGE) break;
    cursor = page.docs[page.docs.length - 1]!.ref.path;
  }

  const contagem = new Map<Veredito, number>();
  for (const a of achados) contagem.set(a.veredito, (contagem.get(a.veredito) ?? 0) + 1);

  log(`[census:up-single] ${candidatos} vínculo(s) User Products examinado(s)`);
  for (const [veredito, n] of [...contagem].sort((a, b) => b[1] - a[1])) {
    log(`  ${veredito.padEnd(20)} ${n}`);
  }

  const antigas = contagem.get('antiga') ?? 0;
  const presas = contagem.get('familia-sem-filhos') ?? 0;

  if (args.listar) {
    for (const a of achados) {
      if (a.veredito === 'antiga' || a.veredito === 'familia-sem-filhos') {
        log(`  ${a.veredito}  produto=${a.produtoId}  link=${a.linkDocId}  id=${a.linkId}`);
      }
    }
  }

  log('');
  if (antigas === 0 && presas === 0) {
    log('✅ Nenhum produto na forma antiga. Não há migração a escrever.');
    return;
  }
  if (antigas > 0) {
    log(
      `⚠️ ${antigas} produto(s) na forma antiga (raiz, sem filhos, vínculo User Products). ` +
        'O próximo publish converte cada um sozinho — escreva um script de migração ' +
        'apenas se eles precisarem ser convertidos ANTES disso.',
    );
  }
  if (presas > 0) {
    log(
      `❌ ${presas} produto(s) com vínculo de FAMÍLIA e nenhuma variação — o publish ` +
        'recusa esses, e nenhum re-import os conserta sozinho. Rode com --listar ' +
        'e trate um a um.',
    );
    process.exitCode = 1;
  }
}

await main();
