/**
 * #1087 §5 — **what did Mercado Livre actually keep?**
 *
 * The live run has to answer "do the attributes and their values match what we
 * sent, and does importing the listing back give the same produto?". Nothing in
 * this repo compares a published listing against its source: publish builds a
 * payload and forgets it, import maps a fetched item and forgets the produto.
 * This script closes that loop for one listing, and prints the answer as a diff
 * instead of leaving it to be eyeballed in two browser tabs.
 *
 *   pnpm --filter @delfrance/mercado-livre-app inspect:anuncio \
 *     --project <id> --integracaoId <id> --itemId MLB000000000
 *
 *   # …plus the raw ML bodies, for the fixture capture in #1087 §9
 *   pnpm --filter @delfrance/mercado-livre-app inspect:anuncio \
 *     --project <id> --integracaoId <id> --itemId MLB000000000 --json
 *
 * It compares three things that are normally never put side by side:
 *
 *  1. the ERP produto + its `produtoMercadoLivre` link — the source of truth;
 *  2. `GET /items/{id}` — what ML is actually serving to buyers;
 *  3. `mapMlItemToImport(item)` — what a re-import WOULD write back.
 *
 * (3) is the important column. A field that differs between (1) and (3) is a
 * round-trip loss whether or not anyone ever presses Importar, because it is
 * exactly what the mass import and the UPtin takeover would write.
 *
 * ⚠️ **Read-only, with one honest exception.** It issues no write to Mercado
 * Livre and no write to any business collection. It CAN cause one write:
 * resolving the channel context refreshes an expired OAuth token, and ML's
 * `refresh_token` is single-use and rotating, so the new credential is persisted
 * to `tokenDuravel` exactly as the backend would. That is the normal shared
 * "one wins" path, not a side effect this script invented — but it is a write,
 * so it is stated rather than hidden behind the word "read-only".
 *
 * ⚠️ `--project` is REQUIRED and never inferred — the same discipline as
 * `tools/migrations` and `check-deposito-source.ts`, so a stray
 * `FIREBASE_PROJECT_ID` cannot point it at production by accident.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  createMercadoLivreApi,
  mapMlItemToImport,
  mapMlVariationsToImport,
  MercadoLivreHttpError,
  type MappedMlItem,
  type MlItem,
} from '@delfrance/integrations-mercado-livre';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '../lib/firebase/admin';
import { loadMercadoLivreContext } from '../lib/marketplace/mercadoLivre';
import { refMatchesIntegracao } from '../lib/marketplace/linkRefs';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class InspectArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectArgError';
  }
}

interface Args {
  projectId: string;
  integracaoId: string;
  itemId: string;
  json: boolean;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) {
    throw new InspectArgError(`--${name} exige um valor.`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let integracaoId: string | undefined;
  let itemId: string | undefined;
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
        itemId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'json':
        json = true;
        break;
      default:
        throw new InspectArgError(`Opção desconhecida: --${name}`);
    }
  }

  if (!projectId?.trim()) throw new InspectArgError('--project é obrigatório.');
  if (!integracaoId?.trim()) throw new InspectArgError('--integracaoId é obrigatório.');
  if (!itemId?.trim()) throw new InspectArgError('--itemId é obrigatório.');

  return {
    projectId: projectId.trim(),
    integracaoId: integracaoId.trim(),
    itemId: itemId.trim(),
    json,
  };
}

/* --------------------------------- the diff -------------------------------- */

type Bucket = 'ok' | 'divergente' | 'ausente';

interface Row {
  campo: string;
  origem: unknown;
  reimport: unknown;
  bucket: Bucket;
}

/**
 * `null` and `undefined` both mean "ML has nothing here", and a number that
 * survived a `"0.6 kg"` → `0.6` parse can land a float ulp away from its source.
 */
function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

function row(campo: string, origem: unknown, reimport: unknown): Row {
  if (same(origem, reimport)) return { campo, origem, reimport, bucket: 'ok' };
  return {
    campo,
    origem,
    reimport,
    bucket: reimport == null ? 'ausente' : 'divergente',
  };
}

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 48 ? `${v.slice(0, 45)}…` : v;
  return JSON.stringify(v);
}

function printTable(titulo: string, rows: readonly Row[]): void {
  log('');
  log(`## ${titulo}`);
  const w = Math.max(...rows.map((r) => r.campo.length), 12);
  for (const r of rows) {
    const mark = r.bucket === 'ok' ? '  ' : r.bucket === 'ausente' ? '✗ ' : '≠ ';
    log(`${mark}${r.campo.padEnd(w)}  origem=${fmt(r.origem)}  reimport=${fmt(r.reimport)}`);
  }
}

/* -------------------------------- attributes ------------------------------- */

/**
 * Attributes are the heart of the question, and they do not diff as scalars: ML
 * fills `value_id`, rewrites `value_name` with its own unit, and drops the local
 * `name` of any id-bearing attribute. Compare the STORED link attributes against
 * what ML serves, id by id.
 */
function printAttributes(item: MlItem, linkAttrs: readonly Record<string, unknown>[]): void {
  log('');
  log('## Atributos — link (o que mandamos) × Mercado Livre (o que ele guardou)');
  const mlById = new Map<string, Record<string, unknown>>();
  for (const a of item.attributes ?? []) {
    if (typeof a.id === 'string' && a.id.length > 0) mlById.set(a.id, a as Record<string, unknown>);
  }

  for (const stored of linkAttrs) {
    const id = typeof stored.id === 'string' ? stored.id : null;
    if (id == null) {
      log(`  (característica própria) name=${fmt(stored.name)} value=${fmt(stored.value_name)}`);
      continue;
    }
    const live = mlById.get(id);
    if (live == null) {
      log(`✗ ${id}  o Mercado Livre NÃO devolveu este atributo`);
      continue;
    }
    const igual = same(stored.value_name, live.value_name) && same(stored.value_id, live.value_id);
    log(
      `${igual ? '  ' : '≠ '}${id}  ` +
        `link={value_id:${fmt(stored.value_id)}, value_name:${fmt(stored.value_name)}}  ` +
        `ml={value_id:${fmt(live.value_id)}, value_name:${fmt(live.value_name)}, unit_id:${fmt(live.unit_id)}}`,
    );
    mlById.delete(id);
  }

  for (const [id, live] of mlById) {
    log(
      `+ ${id}  só no Mercado Livre — value_name=${fmt(live.value_name)} (normalização ou default)`,
    );
  }
}

/* ---------------------------------- lookup --------------------------------- */

interface LinkHit {
  produtoId: string;
  linkDocId: string;
  link: Record<string, unknown>;
}

/**
 * Find the link doc for this ML item, on THIS conta. `id` is the ML item id (or
 * a User-Products family id), and the collection-group query is the same one the
 * items webhook uses — with the conta filter applied in code, because a listing
 * id can legitimately appear under two integrações.
 */
async function findLink(
  db: Firestore,
  integracaoId: string,
  itemId: string,
): Promise<LinkHit | null> {
  const snap = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', itemId)
    .get();
  for (const d of snap.docs) {
    const link = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(link.contaOuterRef, integracaoId)) continue;
    const produtoId = d.ref.parent.parent?.id;
    if (produtoId == null) continue;
    return { produtoId, linkDocId: d.id, link };
  }
  return null;
}

/* ----------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const { projectId, integracaoId, itemId, json } = parseArgs(process.argv.slice(2));
  process.env.FIREBASE_PROJECT_ID = projectId;

  const db = getAdminFirestore();
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

  log(`[inspect:anuncio] project=${projectId} integracao=${integracaoId} item=${itemId}`);

  const item = await api.getItem(itemId);
  // A listing with no description answers 404, and that is DATA — this script
  // exists to report it. Everything else (auth, rate limit, network) is a real
  // failure and must not be swallowed: a silent `null` here would read as "ML
  // has no description", which is the wrong finding to write into the run.
  const descricao = await api
    .getItemDescription(itemId)
    .then((d) => d.plain_text ?? null)
    .catch((err: unknown) => {
      if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
      throw err;
    });

  if (json) {
    log('');
    log('## RAW — GET /items/{id}  (capture isto como fixture, #1087 §9)');
    log(JSON.stringify(item, null, 2));
  }

  const hit = await findLink(db, integracaoId, itemId);
  if (hit == null) {
    log('');
    log(`❌ Nenhum link produtoMercadoLivre com id=${itemId} nesta integração.`);
    log('   O anúncio existe no ML mas o ERP não o conhece — isso já é um achado.');
    process.exitCode = 1;
    return;
  }

  const produtoSnap = await produtoCollection.docRef(db, {}, hit.produtoId).get();
  const produto = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  log(`  produto=${hit.produtoId} link=${hit.linkDocId} nome=${fmt(produto.nome)}`);

  // What a re-import would write back. This is the round-trip answer.
  const reimport: MappedMlItem = mapMlItemToImport(item);

  printTable('Produto — origem × re-import', [
    row('nome', produto.nome, reimport.nome),
    row('sku', produto.sku, reimport.sku),
    row('ehKit', produto.ehKit, reimport.ehKit),
    row('pesoLiquidoKg', produto.pesoLiquidoKg, reimport.pesoLiquidoKg),
    row('pesoBrutoKg', produto.pesoBrutoKg, reimport.pesoBrutoKg),
    row('alturaCm', produto.alturaCm, reimport.alturaCm),
    row('larguraCm', produto.larguraCm, reimport.larguraCm),
    row('profundidadeCm', produto.profundidadeCm, reimport.profundidadeCm),
  ]);

  printTable('Link do anúncio — armazenado × re-import', [
    row('category_id', hit.link.category_id, reimport.categoryId),
    row('listing_type_id', hit.link.listing_type_id, reimport.listingTypeId),
    row('condition', hit.link.condition, reimport.condition),
    row('estado', hit.link.estado, reimport.estado),
    row('status', hit.link.status, reimport.status),
    row('freteGratis', hit.link.freteGratis, reimport.freteGratis),
    row('isUserProductModel', hit.link.isUserProductModel, reimport.isUserProductModel),
    row('video_id', hit.link.video_id, reimport.videoId),
    row('precoPublicado', hit.link.precoPublicado, reimport.precoNormal),
  ]);

  const storedAttrs = Array.isArray(hit.link.attributes)
    ? (hit.link.attributes as Record<string, unknown>[])
    : [];
  printAttributes(item, storedAttrs);

  const variacoes = mapMlVariationsToImport(item);
  if (variacoes.length > 0) {
    log('');
    log(`## Variações — ${variacoes.length} no anúncio`);
    for (const v of variacoes) {
      const combos = v.combos.map((c) => `${c.id ?? c.name}=${c.value_name}`).join(', ');
      log(
        `  id=${v.variationId}  sku=${fmt(v.sku)}  qtd=${v.availableQuantity}  ` +
          `sellerCustomField=${fmt(v.sellerCustomField)}  [${combos}]`,
      );
    }
    log('  ⚠️ A ORDEM acima é a do Mercado Livre. `produto.ordem` não vai para o ML');
    log('     e não volta — divergência esperada (ver roundTrip.test.ts).');
  }

  log('');
  log('## Descrição');
  log(`  ML: ${fmt(descricao)}`);
  log(`  link.descricao: ${fmt(hit.link.descricao)}`);
  log('  ⚠️ A descrição NÃO faz parte do payload do item — é outra chamada.');

  log('');
  log('Classifique cada ≠ / ✗ / + como esperado, normalização do ML, ou BUG.');
  log(
    'A lista do que é esperado está em packages/integrations/mercado-livre/test/roundTrip.test.ts.',
  );
}

await main();
