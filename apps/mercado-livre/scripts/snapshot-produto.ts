/**
 * #1087 §5 — **capture a produto before deleting it, diff it after re-importing.**
 *
 * The live run's core question is "depois de exportar o produto, ao importar
 * teremos os mesmos valores?". Answering it honestly means running the REAL
 * round trip — delete the produto, import the listing back from Mercado Livre —
 * and that destroys the before-state before it can be compared.
 *
 *   # BEFORE deleting
 *   pnpm --filter @delfrance/mercado-livre-app snapshot:produto \
 *     --project <id> --integracaoId <id> --itemId MLB000000000 --save
 *
 *   # AFTER re-importing
 *   pnpm --filter @delfrance/mercado-livre-app snapshot:produto \
 *     --project <id> --integracaoId <id> --itemId MLB000000000 \
 *     --compare out/MLB000000000.json
 *
 * ---- Why not `inspect:anuncio` -------------------------------------------
 * That script compares three columns LIVE and in one shot, and its third column
 * is `mapMlItemToImport(item)` — the PURE MAPPER. The real import writer does
 * more than the mapper: child produtos, link docs, extraData, photo references.
 * A loss only the writer produces is invisible there, and nothing is persisted,
 * so after the delete there is nothing left to compare against.
 *
 * ---- Where the logic lives ------------------------------------------------
 * This file is the IO half only — argument parsing, Firestore reads, rendering.
 * The classification that decides what counts as a finding is
 * `lib/marketplace/anuncios/produtoSnapshotDiff.ts`, which is pure and has both
 * controls under test. An unverified classifier is the exact failure this run
 * keeps turning up: one that reports nothing reads identically to a clean pass.
 *
 * ⚠️ **Genuinely read-only.** Unlike `inspect:anuncio` this issues NO Mercado
 * Livre call at all, so it cannot trigger the token refresh-and-persist that
 * script honestly documents. Firestore reads only; the single write is the
 * snapshot file under `--out`.
 *
 * ⚠️ `--project` is REQUIRED and never inferred — the same discipline as
 * `inspect-anuncio.ts`, `dump-notificacoes.ts` and `tools/migrations`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '../lib/firebase/admin';
import { refMatchesIntegracao } from '../lib/marketplace/core/linkRefs';
import {
  type ProdutoDump,
  type Row,
  type Snapshot,
  diffSnapshots,
} from '../lib/marketplace/anuncios/produtoSnapshotDiff';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class SnapshotArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotArgError';
  }
}

class SnapshotLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotLookupError';
  }
}

/* ---------------------------------- args ----------------------------------- */

interface Args {
  projectId: string;
  integracaoId: string;
  itemId: string | null;
  produtoId: string | null;
  sku: string | null;
  save: boolean;
  compare: string | null;
  outDir: string;
  json: boolean;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) {
    throw new SnapshotArgError(`--${name} exige um valor.`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let integracaoId: string | undefined;
  let itemId: string | null = null;
  let produtoId: string | null = null;
  let sku: string | null = null;
  let save = false;
  let compare: string | null = null;
  let outDir = 'out';
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case 'project':
        projectId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'integracaoId':
        integracaoId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'itemId':
        itemId = valueOf(name, inline, argv[i + 1]).trim();
        break;
      case 'produtoId':
        produtoId = valueOf(name, inline, argv[i + 1]).trim();
        break;
      case 'sku':
        sku = valueOf(name, inline, argv[i + 1]).trim();
        break;
      case 'save':
        save = true;
        break;
      case 'compare':
        compare = valueOf(name, inline, argv[i + 1]).trim();
        break;
      case 'out':
        outDir = valueOf(name, inline, argv[i + 1]).trim();
        break;
      case 'json':
        json = true;
        break;
      default:
        throw new SnapshotArgError(`Opção desconhecida: --${name}`);
    }
  }

  if (!projectId?.trim()) throw new SnapshotArgError('--project é obrigatório.');
  if (!integracaoId?.trim()) throw new SnapshotArgError('--integracaoId é obrigatório.');
  if (itemId == null && produtoId == null && sku == null) {
    throw new SnapshotArgError('Informe --itemId, --produtoId ou --sku.');
  }
  if (save && compare != null) {
    throw new SnapshotArgError('--save e --compare são mutuamente exclusivos.');
  }
  if (!save && compare == null) {
    throw new SnapshotArgError('Escolha um modo: --save ou --compare <arquivo>.');
  }

  return {
    projectId: projectId.trim(),
    integracaoId: integracaoId.trim(),
    itemId,
    produtoId,
    sku,
    save,
    compare,
    outDir,
    json,
  };
}

/* --------------------------------- capture --------------------------------- */

/**
 * Read one produto doc plus every subcollection it actually carries.
 *
 * ⚠️ `listCollections()` rather than a hardcoded leaf list. The names have bitten
 * this repo twice — `subcollections.ts` records that guessed spellings
 * (`produtomercadolivre`, `variacoesml`) silently matched nothing in production —
 * and a snapshot that quietly omits a subcollection reports "no loss" for data it
 * never looked at. Asking Firestore what is there cannot drift.
 */
async function dumpProduto(db: Firestore, produtoId: string): Promise<ProdutoDump> {
  const ref = produtoCollection.docRef(db, {}, produtoId) as DocumentReference;
  const snap = await ref.get();
  if (!snap.exists) {
    throw new SnapshotLookupError(`Produto ${produtoId} não existe.`);
  }

  const subcolecoes: ProdutoDump['subcolecoes'] = {};
  for (const sub of await ref.listCollections()) {
    const docs = await sub.get();
    subcolecoes[sub.id] = docs.docs.map((d) => ({
      id: d.id,
      data: d.data() as Record<string, unknown>,
    }));
  }

  return { produtoId, produto: snap.data() as Record<string, unknown>, subcolecoes };
}

/** Child produtos — the variation half of the family. */
async function dumpFilhos(db: Firestore, paiId: string): Promise<ProdutoDump[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', paiId).get();
  const out: ProdutoDump[] = [];
  for (const d of snap.docs) {
    out.push(await dumpProduto(db, d.id));
  }
  // Deterministic order — Firestore's is not, and a diff must not depend on it.
  out.sort((a, b) => a.produtoId.localeCompare(b.produtoId));
  return out;
}

/* --------------------------------- lookup ---------------------------------- */

/**
 * Resolve the produto. ⚠️ The doc id CHANGES on a re-import, so the id in a saved
 * snapshot is useless for finding the produto afterwards — `--itemId` is the
 * stable handle, resolved through the link doc exactly as `inspect-anuncio.ts`
 * does, with the conta filter applied in code because one listing id can appear
 * under two integrações.
 */
async function resolverProdutoId(db: Firestore, args: Args): Promise<string> {
  if (args.produtoId != null) return args.produtoId;

  if (args.itemId != null) {
    const snap = await produtoMercadoLivreLinkCollection
      .groupQuery(db)
      .where('id', '==', args.itemId)
      .get();
    for (const d of snap.docs) {
      const link = d.data() as Record<string, unknown>;
      if (!refMatchesIntegracao(link.contaOuterRef, args.integracaoId)) continue;
      const produtoId = d.ref.parent.parent?.id;
      if (produtoId != null) return produtoId;
    }
    if (args.sku == null) {
      throw new SnapshotLookupError(
        `Nenhum link produtoMercadoLivre com id=${args.itemId} nesta conta. ` +
          'Se o produto acabou de ser reimportado o link pode ainda não existir — ' +
          'tente --sku, que não depende dele.',
      );
    }
  }

  const porSku = await produtoCollection.ref(db, {}).where('sku', '==', args.sku).limit(2).get();
  if (porSku.empty) throw new SnapshotLookupError(`Nenhum produto com sku=${args.sku}.`);
  if (porSku.size > 1) {
    throw new SnapshotLookupError(
      `sku=${args.sku} nomeia mais de um produto — use --produtoId para desambiguar.`,
    );
  }
  return porSku.docs[0]!.id;
}

/* -------------------------------- rendering -------------------------------- */

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 48 ? `${v.slice(0, 45)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function printTable(titulo: string, rows: readonly Row[]): void {
  log('');
  log(`## ${titulo}`);
  if (rows.length === 0) {
    log('  (nada a comparar)');
    return;
  }
  const w = Math.max(...rows.map((r) => r.campo.length), 12);
  for (const r of rows) {
    const mark =
      r.bucket === 'ok'
        ? '  '
        : r.bucket === 'conhecida'
          ? '~ '
          : r.bucket === 'ausente'
            ? '✗ '
            : '≠ ';
    log(`${mark}${r.campo.padEnd(w)}  antes=${fmt(r.antes)}  depois=${fmt(r.depois)}`);
    if (r.nota != null) log(`  ${' '.repeat(w)}  ↳ conhecida: ${r.nota}`);
  }
}

/* ----------------------------------- main ---------------------------------- */

function caminhoSnapshot(args: Args, itemId: string | null, produtoId: string): string {
  return resolve(args.outDir, `${itemId ?? produtoId}.json`);
}

async function capturar(db: Firestore, args: Args): Promise<Snapshot> {
  const produtoId = await resolverProdutoId(db, args);
  return {
    versao: 1,
    capturadoEm: new Date().toISOString(),
    projectId: args.projectId,
    integracaoId: args.integracaoId,
    itemId: args.itemId,
    raiz: await dumpProduto(db, produtoId),
    filhos: await dumpFilhos(db, produtoId),
  };
}

function lerSnapshot(caminho: string): Snapshot {
  const parsed: unknown = JSON.parse(readFileSync(resolve(caminho), 'utf-8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { versao?: unknown }).versao !== 1
  ) {
    throw new SnapshotLookupError(`${caminho} não é um snapshot versão 1.`);
  }
  return parsed as Snapshot;
}

function relatar(antes: Snapshot, depois: Snapshot): number {
  const r = diffSnapshots(antes, depois);

  log('');
  log(`# Round-trip do produto — ${antes.itemId ?? antes.raiz.produtoId}`);
  log(`  antes:  ${antes.raiz.produtoId}  (capturado ${antes.capturadoEm})`);
  log(`  depois: ${depois.raiz.produtoId}  (lido agora)`);
  if (antes.raiz.produtoId !== depois.raiz.produtoId) {
    log('  ⓘ o doc id mudou — esperado depois de excluir e reimportar.');
  }

  printTable('Produto — campos que o import DEVE restaurar', r.produto);
  printTable('Link produtoMercadoLivre — campos que o import DEVE restaurar', r.link);
  printTable('Subcoleções — contagem de documentos', r.subcolecoes);
  printTable(
    'Subcoleções que o Mercado Livre NUNCA carregou (perda esperada)',
    r.subcolecoesEsperadasPerdidas,
  );
  printTable('Variações (filhos)', r.filhos);

  log('');
  log('## Resumo');
  log(`  divergências conhecidas: ${r.conhecidas.length}  (não contam como achado)`);
  log(`  ACHADOS: ${r.achados.length}`);
  log('');
  if (r.achados.length === 0) {
    log('  ✅ O round-trip preservou tudo que o import se propõe a carregar.');
  } else {
    for (const a of r.achados) log(`  ❌ ${a.campo}`);
    log('');
    log('  Cada linha acima é uma perda do round-trip — §10 Findings do LIVE-TEST.md.');
  }
  return r.achados.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.FIREBASE_PROJECT_ID = args.projectId;

  const db = getAdminFirestore();
  const atual = await capturar(db, args);

  if (args.save) {
    const caminho = caminhoSnapshot(args, atual.itemId, atual.raiz.produtoId);
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, JSON.stringify(atual, null, 2), 'utf-8');
    log(`[snapshot:produto] produto ${atual.raiz.produtoId}`);
    log(
      `  ${atual.filhos.length} filho(s), ${Object.keys(atual.raiz.subcolecoes).length} subcoleção(ões)`,
    );
    log(`  salvo em ${caminho}`);
    log('');
    log('  Agora exclua o produto, reimporte pelo Mercado Livre e rode de novo com');
    log(`  --compare ${caminho}`);
    return;
  }

  const anterior = lerSnapshot(args.compare!);
  if (args.json) {
    log(JSON.stringify({ antes: anterior, depois: atual }, null, 2));
    return;
  }
  // Non-zero on an unexplained round-trip loss, so this can gate CI later
  // (#1087 §9) without rework.
  if (relatar(anterior, atual) > 0) process.exitCode = 1;
}

await main();
