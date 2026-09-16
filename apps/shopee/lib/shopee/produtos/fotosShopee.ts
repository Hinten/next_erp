/**
 * The listing's photos (#1517, step 9) — a SEPARATE, RETRIABLE unit that runs
 * LAST, after every produto, link and stock write has landed.
 *
 * ## ⚠️ Why last, and why separate
 *
 * The legacy committed its batch and THEN downloaded, so a download failure left
 * a produto with no images and no record anywhere that images were owed. Here
 * the catalogue data is already durable before the first byte is fetched, and a
 * picture that fails is counted, logged and skipped — the item is not re-run for
 * it and nothing is half-written.
 *
 * ## ⚠️ Dedup is free, and it converges with the legacy corpus
 *
 * `putArquivoAdmin` is content-addressed by document id: an `arquivos` document
 * that already carries a `url` is NOT re-uploaded, it only `arrayUnion`s the new
 * `externalIds`. The hash is **sha512** — not an arbitrary choice: Mercado
 * Livre's importer uses sha512, and the legacy Flutter app's arquivo document id
 * AND storage object name were both sha512 of the bytes. So a Shopee import of
 * an image a legacy export already uploaded lands on the SAME document, for
 * free. Switching to sha256 would silently fork every one of them.
 *
 * On top of that, a picture whose Shopee `image_id` is already cached on one of
 * this produto's arquivos FOR THIS INTEGRAÇÃO is not even fetched. ⚠️ Step 9 is
 * the FIRST writer of those ids: the legacy wrote `externalIds` only on the
 * EXPORT side (caching what `upload_image` returned) and its importer discarded
 * `image_id_list` entirely. Populating them here makes step 11's export skip a
 * re-upload for free.
 *
 * ## ⚠️ The SSRF guard, and the log that must not carry the URL
 *
 * The bytes are fetched SERVER-side, so the host is checked against an allow-list
 * before the request and `http:` is upgraded to `https:`; anything else is a
 * skipped picture, not a failed item. The log line carries the HOST and the
 * `image_id` and **never the URL** — a deliberate divergence from ML, because a
 * product image URL carries the shop and the listing, which this app's own
 * redaction denylist already treats as personal data.
 *
 * ## ⚠️ The failure split
 *
 * A picture-level problem ({@link ShopeeImagemError}) or a `TypeError` (which is
 * how a fetch network failure surfaces) is SKIPPED and counted. Anything else —
 * Storage, Firestore — PROPAGATES and fails the item, because those are
 * retryable infra failures and swallowing them would silently drop images for
 * ever.
 *
 * ⚠️ A missing bucket NAME skips photos for the whole run with one log line.
 * That is a backend misconfiguration, never a per-item concern, and the resolver
 * answers `null` rather than throwing so genuine Storage failures still surface.
 *
 * Next-free, clock-free.
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type Foto,
  buildFotoRefs,
  deriveFotosArquivosIds,
  filetypeFromMime,
  normalizeContentType,
  productArquivoId,
  productOriginalPath,
  toOuterRef,
} from '@delfrance/schemas';
import { arquivoCollection, produtoCollection } from '@delfrance/data/admin/collections';
import { type Bucket, putArquivoAdmin } from '@delfrance/storage/admin';

import type { ParDeImagemShopee } from './planoImportacao';

/** A picture-level problem: skip this picture, keep importing the rest. */
export class ShopeeImagemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeImagemError';
  }
}

/**
 * The hosts Shopee serves listing images from.
 *
 * BR assets come from `cf.shopee.com.br`; other regions use `cf.shopee.<tld>`
 * and the `susercontent.com` CDN. ONE exported constant, so a host Shopee adds
 * tomorrow is one literal away — and so a test can prove what is refused.
 *
 * ⚠️ The suffix is capped at TWO labels (`shopee.sg`, `shopee.com.br`) and every
 * label is letters only, because the registrable domain is what an allow-list
 * actually allows. A permissive tail (`shopee\.[a-z.]+$`) matches
 * `shopee.com.<anything an attacker registers>` — the allow-list would then be
 * satisfied by a domain Shopee does not own, and this fetch runs SERVER-side.
 */
export const HOSTS_DE_IMAGEM_SHOPEE: readonly RegExp[] = [
  /(^|\.)shopee\.[a-z]{2,}(\.[a-z]{2,})?$/i,
  /(^|\.)susercontent\.com$/i,
];

/** Extensions for the content types Shopee actually serves. */
const EXTENSAO_POR_TIPO: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const PREFIXO_ARQUIVOS = 'arquivos/';

/**
 * Validate the URL before the server-side fetch.
 *
 * ⚠️ `http:` is UPGRADED rather than refused (Shopee's CDN serves both), while
 * any other scheme — `file:`, `data:`, `gopher:` — is refused outright. A
 * non-matching host is refused too. All three are picture-level, so they skip.
 */
export function urlDeImagemSegura(bruta: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(bruta);
  } catch (err) {
    if (err instanceof TypeError) throw new ShopeeImagemError('URL de imagem inválida');
    throw err;
  }
  if (!HOSTS_DE_IMAGEM_SHOPEE.some((re) => re.test(parsed.hostname))) {
    throw new ShopeeImagemError(`host de imagem não permitido: ${parsed.host}`);
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  } else if (parsed.protocol !== 'https:') {
    throw new ShopeeImagemError(`esquema de URL não permitido: ${parsed.protocol}`);
  }
  return parsed;
}

/**
 * The Shopee `image_id`s already cached on this produto's arquivos for THIS
 * integração — the set the planner subtracts before it plans a download.
 *
 * ⚠️ The integração ref is compared TOLERANTLY: the canonical
 * `documents/integracao/<id>` and the bare `integracao/<id>` form both count. A
 * strict comparison would silently re-download every picture of every produto
 * whose arquivos were written in the older form.
 */
export async function idsDeImagemJaImportados(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<string[]> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!snap.exists) return [];
  const raw = (snap.data() ?? {}) as { fotos?: unknown };
  const fotos = Array.isArray(raw.fotos) ? (raw.fotos as Array<Record<string, unknown>>) : [];

  const arquivoIds = new Set<string>();
  for (const foto of fotos) {
    const ref = foto.arquivoOuterRef;
    if (typeof ref !== 'string') continue;
    const id = ref.startsWith(PREFIXO_ARQUIVOS) ? ref.slice(PREFIXO_ARQUIVOS.length) : ref;
    if (id.length > 0) arquivoIds.add(id);
  }

  const importados = new Set<string>();
  for (const id of arquivoIds) {
    const asnap = await arquivoCollection.docRef(db, {}, id).get();
    if (!asnap.exists) continue;
    const externos = (asnap.data() as { externalIds?: unknown } | undefined)?.externalIds;
    if (!Array.isArray(externos)) continue;
    for (const e of externos as Array<Record<string, unknown>>) {
      if (typeof e.externalId !== 'string') continue;
      if (refCasaIntegracao(e.integracaoPath, integracaoId)) importados.add(e.externalId);
    }
  }
  return [...importados];
}

function refCasaIntegracao(ref: unknown, integracaoId: string): boolean {
  if (typeof ref !== 'string') return false;
  return ref === `documents/integracao/${integracaoId}` || ref === `integracao/${integracaoId}`;
}

export interface DepsFotosShopee {
  readonly db: Firestore;
  /** Absent ⇒ photos are skipped for the whole run. */
  readonly bucket?: Bucket;
  readonly integracaoId: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface ResultadoFotosShopee {
  readonly importadas: number;
  readonly ignoradas: number;
  readonly falhas: number;
}

/**
 * Fetch, store and append every planned picture.
 *
 * `ignoradas` is the count the PLAN already decided (pictures whose `image_id`
 * was cached); this function only ever adds to `importadas` and `falhas`.
 */
export async function importarFotosShopee(
  deps: DepsFotosShopee,
  produtoId: string,
  pares: readonly ParDeImagemShopee[],
  ignoradasNoPlano = 0,
): Promise<ResultadoFotosShopee> {
  if (pares.length === 0) {
    return { importadas: 0, ignoradas: ignoradasNoPlano, falhas: 0 };
  }
  const bucket = deps.bucket;
  if (bucket === undefined) {
    console.warn('[shopee/importacao] sem bucket de Storage; as fotos do anúncio foram puladas', {
      produtoId,
      fotos: pares.length,
    });
    return { importadas: 0, ignoradas: ignoradasNoPlano + pares.length, falhas: 0 };
  }

  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const novas: Foto[] = [];
  let importadas = 0;
  let falhas = 0;

  for (const par of pares) {
    try {
      novas.push(await importarUmaFoto(deps, bucket, doFetch, produtoId, par));
      importadas += 1;
    } catch (err) {
      if (err instanceof ShopeeImagemError || err instanceof TypeError) {
        // ⚠️ HOST and `image_id` only — never the URL, and never the bytes.
        console.warn('[shopee/importacao] foto ignorada', {
          produtoId,
          imageId: par.imageId,
          host: hostOuNulo(par.url),
          causa: err.message,
        });
        falhas += 1;
        continue;
      }
      throw err;
    }
  }

  if (novas.length > 0) {
    // ⚠️ `arrayUnion` (tier 0): a concurrent photo append cannot be dropped, and
    // there is nothing to compare, so nothing to lose.
    await produtoCollection.docRef(deps.db, {}, produtoId).update({
      fotos: FieldValue.arrayUnion(...novas),
      fotosArquivosIds: FieldValue.arrayUnion(...deriveFotosArquivosIds(novas)),
    });
  }

  return { importadas, ignoradas: ignoradasNoPlano, falhas };
}

function hostOuNulo(bruta: string): string | null {
  try {
    return new URL(bruta).host;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

async function importarUmaFoto(
  deps: DepsFotosShopee,
  bucket: Bucket,
  doFetch: typeof globalThis.fetch,
  produtoId: string,
  par: ParDeImagemShopee,
): Promise<Foto> {
  const url = urlDeImagemSegura(par.url);
  const res = await doFetch(url.toString());
  if (!res.ok) throw new ShopeeImagemError(`HTTP ${String(res.status)} ao baixar a imagem`);

  const contentType = normalizeContentType(res.headers.get('content-type') ?? '');
  if (!contentType.startsWith('image/')) {
    throw new ShopeeImagemError(`content-type inesperado "${contentType}"`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha512').update(bytes).digest('hex');
  const ext = EXTENSAO_POR_TIPO[contentType] ?? null;

  await putArquivoAdmin({
    db: deps.db,
    bucket,
    docId: productArquivoId(produtoId, hash),
    storagePath: productOriginalPath(produtoId, hash, ext),
    bytes,
    contentType,
    filetype: filetypeFromMime(contentType),
    // What makes the DEPLOYED `resizeProductImage` produce the 200/400/jpeg
    // derivatives — no new function, no image processing here.
    resizeState: 'pending',
    externalIds:
      par.imageId !== null
        ? [
            {
              externalId: par.imageId,
              integracaoPath: toOuterRef(`integracao/${deps.integracaoId}`),
            },
          ]
        : [],
  });

  return {
    ...buildFotoRefs(produtoId, hash),
    // Item-level, never variation-bound — the legacy's own `Foto2.fromArquivo`
    // did the same, and per-option images are a recorded gap (ML parity).
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}
