/**
 * The product import's PHOTOS (master plan step 9, "complete"): a store product's pictures copied
 * onto the ERP produto that has NONE — one picture per unit, resumable from a cursor the dispatch
 * checkpoints after every unit. Next-free; `db` is a parameter.
 *
 * ## When ({@link deveImportarFotosLi})
 *
 * Under `acao: completar` with `fotos: soSemFotos`, for each produto of a family — the root (a
 * store parent or simple product) and each variation's produto — whose `fotos` is ABSENT, `null`
 * or `[]` when its pictures START ({@link semFotosNoErpLi}). Never onto one with any photo: a
 * non-empty list is the operator's, and a value of any other shape (`''`, a map, a number) is a
 * value, never written over — the fill-empty rule (`completar.ts`). A sole member (`familia-de-um`)
 * is never a target: its root carries the pictures, as the web's "Novo produto" builds it.
 *
 * ## Which ({@link planejarAlvosDeFotosLi})
 *
 * The detail's `imagens` EXACTLY as the shared reader hands them over (`lerDetalheProdutoLi`): the
 * principal first (`imagem_principal` folded in), then `posicao` ascending with a `null` or
 * unreadable one after every number, then the store's order; de-duplicated by id; at most 50.
 * Nothing is re-sorted or re-filtered here: one order, one reader. A VARIATION's pictures only when
 * the SET of its image ids differs from its parent's ({@link mesmoConjuntoDeImagensLi}): one whose
 * detail repeats the parent's set gets none (the parent does), so a family never receives a copy of
 * the parent's pictures per variation. (The captures saw variation details with no images at all;
 * a detail never read gives no image either: nothing to fetch.)
 *
 * ## One unit = at most ONE download ({@link executarUnidadeDeFotoLi})
 *
 * Its budget row is `foto` (`orcamento.ts`: the pacer's 2 s + `PRAZO_CDN_LI_MS` + the upload
 * deadline = 52 s). A unit:
 *
 *  1. when a produto's pictures START, reads it ONCE: gone ⇒ `ausente`; any photo ⇒ `com-fotos`;
 *     either way it is done with no download and the unit moves to the next target (a unit may pass
 *     several such produtos before its download, a read each);
 *  2. waits the pacer's interval (`RITMO_LEITURA_LI_MS`, like every call of the import) and asks
 *     the CDN reader for ONE picture, through `contexto.cdn` only — the reader built behind the read
 *     switch, never one of its own — in the ORIGINAL form (`/<caminho>`, full resolution: the ERP
 *     makes its own derivatives);
 *  3. on `ok`: the picture is stored (below) and joins the cursor's `enviadas`;
 *     on `muito-grande` of the ORIGINAL: nothing more in this unit — the cursor says `reduzida`
 *     and the NEXT unit asks for `/800x800/<caminho>` under its own budget check (inside one unit
 *     the two would cost 74 s, which no 70 s budget starts; `orcamento.ts`);
 *     on any other outcome — `caminho-invalido`, `redirecionamento`, `nao-encontrada`, `http` (a
 *     CDN 401, 403 or 429 included: the CDN never saw the credential, so nothing is parked),
 *     `nao-e-imagem`, or `muito-grande` of the 800x800 form — the picture is REFUSED
 *     (`foto-recusada`, informational, on the item) and the next one is still processed;
 *  4. after the produto's LAST picture is decided, writes them (below), in the same unit.
 *
 * The type of a picture is the one its BYTES are (the reader sniffs JPEG, PNG, WebP and GIF), never
 * the header (the CDN answers a non-standard `image/jpg`), the extension or the detail's `mime`.
 * A transport failure of the CDN read (`LiTimeoutError`, `LiNetworkError`) is not an outcome: it
 * propagates like any read's, and the task retries the same unit from its cursor.
 *
 * ## Storing one picture ({@link criarGuardarFotoLi}, the `guardarFotoLi` seam)
 *
 * sha-512 of the bytes (hex) ⇒ the document id `productArquivoId(produtoId, hash)` and the object
 * `productOriginalPath(produtoId, hash, <the bytes' extension>)` ⇒ the shared uploader
 * `putArquivoAdmin`: create-first (the anchor document before the bytes), content-addressed (a
 * document that already has its `url` is not uploaded again — only its `externalIds` are
 * unioned), `resizeState: 'pending'` (the deployed resize function makes the 200/400/jpeg
 * derivatives) and `externalIds` = the store image id under this conta's ref. sha-512 is the
 * hash every other uploader of this repo uses, so a picture another flow already stored for this
 * produto lands on the SAME document.
 *
 * ⚠️ The uploader takes no deadline and no signal, so the unit RACES it against
 * `PRAZO_UPLOAD_LI_MS` (30 s). An upload past it ends the photo units of THIS dispatch (`parar`,
 * the cursor unchanged): the next dispatch fetches the picture again and stores it again — a no-op
 * when the abandoned upload did land, a heal of the anchor when it did not. The abandoned upload is
 * never awaited again; its late failure is one WARN line, never an unhandled rejection. A half-made
 * `arquivos` document (anchor without bytes) is the existing orphan reconcile's, the create-first
 * design. ⚠️ Accepted residual: an abandoned upload still running when the retry heals the same
 * anchor makes two saves of one object with two download tokens; the `url` keeps whichever patch
 * lands last. Closing it needs a deadline inside the shared uploader (a follow-up of the plan).
 *
 * A Storage failure, and any Firestore failure, PROPAGATES: the task retries the unit.
 *
 * ## Writing a produto's pictures (root rule 7, the plan's row 14)
 *
 * After its last picture, the produto is RE-READ (the read the write is guarded by is taken AFTER
 * every upload) and written ONCE, tier 1: `update({ fotos, fotosArquivosIds, ultimaModificacao },
 * { lastUpdateTime: <that read> })`. `fotos` are the stored pictures in plan order
 * (`buildFotoRefs`, item-level: no variation scope); `fotosArquivosIds` the ids already stored kept
 * as they are, plus `deriveFotosArquivosIds(fotos)`; `ultimaModificacao` the job's clock in ms (the
 * TableView monitor watches it). Then:
 *
 *  - the read finds EXACTLY these `fotos` stored ⇒ our own write landed earlier (a lost reply, or a
 *    unit retried after it): counted as written, never redone;
 *  - the read finds any OTHER photo ⇒ `perdeu`: the operator's (or another flow's) photos stay, ours
 *    are written nowhere, and the uploaded `arquivos` are reclaimed by the orphan reconcile;
 *  - a 9 (or 5) ⇒ re-read and decide again as above; still no photo ⇒ write again, at most 3
 *    writes, then `conflito-de-escrita` — never forced;
 *  - the produto gone ⇒ `ausente` (`conflito-de-escrita`, as the fill reports a produto lost to a
 *    delete).
 *
 * The produto's LINK is written after this (the caller's order: fill, photos, link last), so the
 * anchor trigger's write on the produto never lands inside this window from this job's own link.
 *
 * ## The cursor ({@link CursorFotosLi})
 *
 * Which produto is under way, the index of its next picture, whether that picture's ORIGINAL came
 * back too large (the next unit is its `800x800`), the pictures of that produto already stored (the
 * store image id and the hash: `buildFotoRefs` needs nothing else), and the family's tallies so far
 * (the produtos done and every refusal). The caller checkpoints it after every unit; a unit retried
 * from an older cursor re-fetches and re-stores (content-addressed, so nothing is stored twice).
 * ⚠️ Accepted residual: a produto with ONE picture whose write LANDED and whose unit was then
 * retried from the cursor before it (a crash between the write and the checkpoint) reads `com-fotos`
 * on the retry — the picture is on the produto, but the report does not count it.
 *
 * ## Simular ({@link contarFotosSimuladasLi})
 *
 * NO download and no upload at all: Simular writes only the job, and a picture fetched only to be
 * thrown away is a CDN call that decides nothing. Each existing target is read once (photos ⇒ none
 * planned); a produto the run would create is not read (it would be created with none). The answer
 * is the count a real run would fetch; it cannot foresee a refusal.
 *
 * ## No bucket
 *
 * `guardar: null` (the functions codebase found no default bucket) ⇒ `sem-bucket`, with ZERO reads
 * and ZERO downloads: the caller skips the run's photos and stamps the job `fotosIndisponiveis`.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * `produtos/{id}` by id; the uploader reads `arquivos/{id}` by id. No query, so no index.
 *
 * ## Errors (root rule 6)
 *
 * Only the precondition codes a guarded write loses with are caught (`FAILED_PRECONDITION`,
 * `NOT_FOUND`), each by its gRPC code. The upload's settled value is captured once so that a
 * failure BEFORE the deadline is rethrown as-is, and one AFTER it is logged; nothing else is
 * caught. Never name the Admin SDK's multi-document read-and-write call here — not even in a
 * comment (`estrutura.test.ts`).
 */
import { createHash } from 'node:crypto';
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  FORMA_IMAGEM_LI,
  type FormaImagemLi,
  type LeitorCdnLi,
  type ResultadoImagemLi,
  TIPO_IMAGEM_LI,
  type TipoImagemLi,
} from '@delfrance/integrations-loja-integrada';
import {
  ACAO_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  type Foto,
  type ImagemProdutoLi,
  type ImportacaoLojaIntegrada,
  PENDENCIA_IMPORTACAO_LI,
  buildFotoRefs,
  deriveFotosArquivosIds,
  filetypeFromMime,
  productArquivoId,
  productOriginalPath,
  toOuterRef,
} from '@delfrance/schemas';
import { type Bucket, putArquivoAdmin } from '@delfrance/storage/admin';
import { z } from 'zod';

import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import { guardaOPatchLi } from './job';
import { PRAZO_UPLOAD_LI_MS, UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';
import type { PendenciaDoPlanoLi } from './plano';

/* -------------------------------------------------------------------------- */
/*                                   When, which                               */
/* -------------------------------------------------------------------------- */

/** Whether a job imports photos at all: `completar` with `fotos: soSemFotos` (module header). */
export function deveImportarFotosLi(job: Pick<ImportacaoLojaIntegrada, 'acao' | 'fotos'>): boolean {
  return job.acao === ACAO_IMPORTACAO_LI.completar && job.fotos === FOTOS_IMPORTACAO_LI.soSemFotos;
}

/**
 * Whether a STORED produto has no photo (module header, "When"): `fotos` absent, `null` or `[]`.
 * Anything else — a non-empty list, or a value of another shape — is a value. Pure.
 */
export function semFotosNoErpLi(produto: Readonly<Record<string, unknown>>): boolean {
  const fotos = produto.fotos;
  return fotos === undefined || fotos === null || (Array.isArray(fotos) && fotos.length === 0);
}

/**
 * Whether `imagens` names exactly the image ids of `ids`, as SETS (order and repeats aside): the
 * variation rule of "Which". Store image ids are integers, compared exactly. Pure.
 */
export function mesmoConjuntoDeImagensLi(
  imagens: readonly Pick<ImagemProdutoLi, 'id'>[],
  ids: ReadonlySet<number>,
): boolean {
  const deste = new Set(imagens.map((i) => i.id));
  return deste.size === ids.size && [...deste].every((id) => ids.has(id));
}

/** One produto of a family whose pictures may be imported, as the caller knows it. */
export interface CandidatoAFotosLi {
  /** The ERP produto (existing, or created by this run). */
  readonly produtoId: string;
  /** The store product the pendências name: `null` for the item's root, else the variation's id. */
  readonly liId: number | null;
  /** Its detail's `imagens` as read (`ProdutoLiDetalhado.imagens`); `[]` when no detail was read. */
  readonly imagens: readonly ImagemProdutoLi[];
}

/** A produto whose pictures WILL be attempted, in the family's order. */
export type AlvoDeFotosLi = CandidatoAFotosLi;

/**
 * A family's photo targets, in order: the root when its detail has pictures, then each variation
 * (the caller's order) whose pictures are not the root's set (module header, "Which"). A target
 * with no picture is no target. Pure.
 *
 * @throws {RangeError} when one produto is named twice (a caller's bug, never a store's).
 */
export function planejarAlvosDeFotosLi(familia: {
  readonly raiz: CandidatoAFotosLi;
  readonly filhos: readonly CandidatoAFotosLi[];
}): AlvoDeFotosLi[] {
  const produtos = [familia.raiz, ...familia.filhos].map((c) => c.produtoId);
  if (new Set(produtos).size !== produtos.length) {
    throw new RangeError('planejarAlvosDeFotosLi: um produto aparece duas vezes na família');
  }
  const idsDaRaiz = new Set(familia.raiz.imagens.map((i) => i.id));
  const filhos = familia.filhos.filter((f) => !mesmoConjuntoDeImagensLi(f.imagens, idsDaRaiz));
  return [familia.raiz, ...filhos].filter((c) => c.imagens.length > 0);
}

/* -------------------------------------------------------------------------- */
/*                                   The cursor                                */
/* -------------------------------------------------------------------------- */

/** Why a picture was refused: every CDN outcome but `ok` (module header, step 3). */
export const motivoFotoRecusadaLiSchema = z.enum([
  'caminho-invalido',
  'redirecionamento',
  'nao-encontrada',
  'http',
  'muito-grande',
  'nao-e-imagem',
]);
export type MotivoFotoRecusadaLi = z.infer<typeof motivoFotoRecusadaLiSchema>;
/** Named members of {@link motivoFotoRecusadaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_FOTO_RECUSADA_LI = {
  caminhoInvalido: 'caminho-invalido',
  redirecionamento: 'redirecionamento',
  naoEncontrada: 'nao-encontrada',
  http: 'http',
  muitoGrande: 'muito-grande',
  naoEImagem: 'nao-e-imagem',
} as const satisfies Record<string, MotivoFotoRecusadaLi>;

// The motivos ARE the reader's outcomes but `ok`, both ways: a new outcome of the package does not
// compile until it is decided here.
type ComoMotivo = Exclude<ResultadoImagemLi, 'ok'>;
const _todoResultadoTemMotivo: ComoMotivo extends MotivoFotoRecusadaLi ? true : never = true;
const _todoMotivoEResultado: MotivoFotoRecusadaLi extends ComoMotivo ? true : never = true;
void _todoResultadoTemMotivo;
void _todoMotivoEResultado;

/** How a produto's pictures ended (module header). */
export const desfechoFotosDoProdutoLiSchema = z.enum([
  /** Written (Simular: would be): `fotos` counts them. */
  'importadas',
  /** It had a photo when its pictures started: nothing fetched. */
  'com-fotos',
  /** Another writer's photo arrived before our write: theirs stay, ours are written nowhere. */
  'perdeu',
  /** The produto is gone. */
  'ausente',
  /** Every write lost, and it still has no photo: `conflito-de-escrita`. */
  'conflito',
  /** Every picture was refused: nothing to write. */
  'nenhuma-aceita',
]);
export type DesfechoFotosDoProdutoLi = z.infer<typeof desfechoFotosDoProdutoLiSchema>;
/** Named members of {@link desfechoFotosDoProdutoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const DESFECHO_FOTOS_DO_PRODUTO_LI = {
  importadas: 'importadas',
  comFotos: 'com-fotos',
  perdeu: 'perdeu',
  ausente: 'ausente',
  conflito: 'conflito',
  nenhumaAceita: 'nenhuma-aceita',
} as const satisfies Record<string, DesfechoFotosDoProdutoLi>;

const idLiSchema = z.number().int().positive();

/** A sha-512 digest, in lowercase hex. */
const HASH_SHA512_HEX = /^[0-9a-f]{128}$/;

/**
 * The resumable state of one family's pictures (module header, "The cursor"): what the caller
 * checkpoints after every unit and hands back to the next. Read back through
 * {@link lerCursorFotosLi}. ⚠️ The job contract has no field of its own for it yet.
 */
export const cursorFotosLiSchema = z.object({
  /** The produto whose pictures are under way; `null` once every target is done. */
  produtoId: z.string().min(1).nullable(),
  /** The index, in that produto's pictures, of the next one to fetch. */
  proxima: z.number().int().nonnegative(),
  /** That picture's ORIGINAL came back too large: the next unit fetches its `800x800`. */
  reduzida: z.boolean(),
  /** That produto's pictures already stored, in plan order. */
  enviadas: z.array(z.object({ imagemId: idLiSchema, hash: z.string().regex(HASH_SHA512_HEX) })),
  /** The produtos of the family done so far, in order. */
  feitos: z.array(
    z.object({
      produtoId: z.string().min(1),
      liId: idLiSchema.nullable(),
      desfecho: desfechoFotosDoProdutoLiSchema,
      fotos: z.number().int().nonnegative(),
    }),
  ),
  /** Every picture of the family refused so far. */
  recusadas: z.array(
    z.object({
      liId: idLiSchema.nullable(),
      imagemId: idLiSchema,
      motivo: motivoFotoRecusadaLiSchema,
    }),
  ),
});
export type CursorFotosLi = z.infer<typeof cursorFotosLiSchema>;
export type ProdutoComFotosLi = CursorFotosLi['feitos'][number];
export type FotoRecusadaLi = CursorFotosLi['recusadas'][number];
type FotoEnviadaLi = CursorFotosLi['enviadas'][number];

/** A stored cursor read back, or `null` when it does not parse: the family's pictures restart. */
export function lerCursorFotosLi(armazenado: unknown): CursorFotosLi | null {
  const lido = cursorFotosLiSchema.safeParse(armazenado);
  return lido.success ? lido.data : null;
}

/** The cursor before a family's first unit. */
export function cursorInicialDeFotosLi(alvos: readonly AlvoDeFotosLi[]): CursorFotosLi {
  return {
    produtoId: alvos[0]?.produtoId ?? null,
    proxima: 0,
    reduzida: false,
    enviadas: [],
    feitos: [],
    recusadas: [],
  };
}

/** The unit every photo step costs (`orcamento.ts`): one download and one upload, 52 s. */
export function unidadeDaFotoLi(): UnidadeImportacaoLi {
  return UNIDADE_IMPORTACAO_LI.foto;
}

/* -------------------------------------------------------------------------- */
/*                                  The upload                                 */
/* -------------------------------------------------------------------------- */

/** One picture to store: its produto, the bytes' digest and type, and the store image id. */
export interface FotoAGuardarLi {
  readonly produtoId: string;
  /** sha-512 of `bytes`, lowercase hex. */
  readonly hash: string;
  readonly bytes: Uint8Array;
  /** The type the BYTES are (the reader's sniff). */
  readonly tipo: TipoImagemLi;
  readonly imagemId: number;
}

/** The upload seam: resolves once the picture is stored (module header, "Storing one picture"). */
export type GuardarFotoLi = (foto: FotoAGuardarLi) => Promise<void>;

/** The object's extension for each type the reader accepts (the shared uploaders' own names). */
const EXTENSAO_DO_TIPO_LI = {
  [TIPO_IMAGEM_LI.jpeg]: 'jpeg',
  [TIPO_IMAGEM_LI.png]: 'png',
  [TIPO_IMAGEM_LI.webp]: 'webp',
  [TIPO_IMAGEM_LI.gif]: 'gif',
} as const satisfies Record<TipoImagemLi, string>;

/** sha-512 of the bytes, lowercase hex: the content address. */
export function hashDaFotoLi(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('hex');
}

/**
 * The `guardarFotoLi` seam bound to the shared uploader (module header, "Storing one picture"):
 * create-first, content-addressed, `resizeState: 'pending'`, the store image id in `externalIds`
 * under this conta's ref (`documents/integracao/<conta>`).
 */
export function criarGuardarFotoLi(deps: {
  readonly db: Firestore;
  readonly bucket: Bucket;
  readonly contaId: string;
}): GuardarFotoLi {
  const integracaoPath = toOuterRef(`integracao/${deps.contaId}`);
  return async ({ produtoId, hash, bytes, tipo, imagemId }) => {
    await putArquivoAdmin({
      db: deps.db,
      bucket: deps.bucket,
      docId: productArquivoId(produtoId, hash),
      storagePath: productOriginalPath(produtoId, hash, EXTENSAO_DO_TIPO_LI[tipo]),
      bytes,
      contentType: tipo,
      filetype: filetypeFromMime(tipo),
      resizeState: 'pending',
      externalIds: [{ externalId: String(imagemId), integracaoPath }],
    });
  };
}

/** The one sink a unit writes to besides its result (ids and counts only). */
export interface LoggerFotosLi {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** A settled upload, captured as a value so that no rejection is ever left unhandled. */
type DesfechoDoEnvioLi =
  | { readonly tipo: 'guardada' }
  | { readonly tipo: 'falhou'; readonly erro: unknown }
  | { readonly tipo: 'prazo' };

/** An error's class name for a log line (never its message), without assuming it is an `Error`. */
function nomeDoErro(erro: unknown): string {
  if (typeof erro === 'object' && erro !== null && 'name' in erro) return String(erro.name);
  return typeof erro;
}

/**
 * Store one picture, raced against {@link PRAZO_UPLOAD_LI_MS} (module header): `true` once stored,
 * `false` when the deadline passed first (the upload is abandoned, never awaited again, its late
 * failure one WARN line). A failure before the deadline is rethrown as it came.
 */
async function guardarComPrazoLi(
  guardar: GuardarFotoLi,
  foto: FotoAGuardarLi,
  logger: LoggerFotosLi,
): Promise<boolean> {
  const envio: Promise<DesfechoDoEnvioLi> = guardar(foto).then(
    (): DesfechoDoEnvioLi => ({ tipo: 'guardada' }),
    (erro: unknown): DesfechoDoEnvioLi => ({ tipo: 'falhou', erro }),
  );
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<DesfechoDoEnvioLi>((resolve) => {
    temporizador = setTimeout(() => {
      resolve({ tipo: 'prazo' });
    }, PRAZO_UPLOAD_LI_MS);
  });
  let primeiro: DesfechoDoEnvioLi;
  try {
    primeiro = await Promise.race([envio, prazo]);
  } finally {
    clearTimeout(temporizador);
  }
  if (primeiro.tipo === 'guardada') return true;
  if (primeiro.tipo === 'falhou') throw primeiro.erro;
  void envio.then((tarde) => {
    if (tarde.tipo !== 'falhou') return;
    logger.warn('[loja-integrada] importação: envio de foto abandonado falhou depois do prazo', {
      produtoId: foto.produtoId,
      imagemId: foto.imagemId,
      erro: nomeDoErro(tarde.erro),
    });
  });
  return false;
}

/* -------------------------------------------------------------------------- */
/*                                 The produto                                  */
/* -------------------------------------------------------------------------- */

/** At most this many guarded writes of a produto's pictures (the plan's row 14). */
export const MAX_TENTATIVAS_FOTOS_LI = 3;

/** The stored data of a snapshot, as a plain record. */
function dadosDe(snap: DocumentSnapshot): Record<string, unknown> {
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/** The `Foto` a stored picture becomes: item-level, the four refs `buildFotoRefs` derives. */
function fotoDoHash(produtoId: string, hash: string): Foto {
  return { ...buildFotoRefs(produtoId, hash), grupoDeVariacoesOuterRef: null, variantePath: null };
}

/** The ids already stored in `fotosArquivosIds` (text only, in order), then each new one. */
function idsDeArquivos(armazenado: unknown, novos: readonly string[]): string[] {
  const ids = Array.isArray(armazenado)
    ? armazenado.filter((id): id is string => typeof id === 'string')
    : [];
  for (const id of novos) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * The produto's pictures, written ONCE on a read taken after every upload (module header, "Writing
 * a produto's pictures").
 */
async function gravarFotosDoProdutoLi(
  deps: Pick<DepsFotosLi, 'db' | 'agoraMs'>,
  alvo: AlvoDeFotosLi,
  enviadas: readonly FotoEnviadaLi[],
): Promise<ProdutoComFotosLi> {
  const feito = (desfecho: DesfechoFotosDoProdutoLi, fotos = 0): ProdutoComFotosLi => ({
    produtoId: alvo.produtoId,
    liId: alvo.liId,
    desfecho,
    fotos,
  });
  if (enviadas.length === 0) return feito(DESFECHO_FOTOS_DO_PRODUTO_LI.nenhumaAceita);
  // As the collection writes them, so "are they ours?" compares like with like.
  const fotos = produtoCollection.parseMerge({
    fotos: enviadas.map((e) => fotoDoHash(alvo.produtoId, e.hash)),
  }).fotos;
  const ref = produtoCollection.docRef(deps.db, {}, alvo.produtoId);
  for (let escritas = 0; ; escritas += 1) {
    const snap = await ref.get();
    if (!snap.exists || snap.updateTime === undefined) {
      return feito(DESFECHO_FOTOS_DO_PRODUTO_LI.ausente);
    }
    const dados = dadosDe(snap);
    // Exactly our pictures: our own write landed (a lost reply, or a retried unit).
    if (guardaOPatchLi(dados, { fotos })) {
      return feito(DESFECHO_FOTOS_DO_PRODUTO_LI.importadas, enviadas.length);
    }
    if (!semFotosNoErpLi(dados)) return feito(DESFECHO_FOTOS_DO_PRODUTO_LI.perdeu);
    if (escritas >= MAX_TENTATIVAS_FOTOS_LI) return feito(DESFECHO_FOTOS_DO_PRODUTO_LI.conflito);
    const escrito = produtoCollection.parseMerge({
      fotos,
      fotosArquivosIds: idsDeArquivos(dados.fotosArquivosIds, deriveFotosArquivosIds(fotos)),
      ultimaModificacao: deps.agoraMs(),
    });
    try {
      await ref.update(escrito, { lastUpdateTime: snap.updateTime });
      return feito(DESFECHO_FOTOS_DO_PRODUTO_LI.importadas, enviadas.length);
    } catch (err) {
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
}

/** How a target stands when its pictures START: gone, with photos, or ready. */
async function situacaoNoInicioLi(
  db: Firestore,
  produtoId: string,
): Promise<'ausente' | 'com-fotos' | 'sem-fotos'> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!snap.exists) return 'ausente';
  return semFotosNoErpLi(dadosDe(snap)) ? 'sem-fotos' : 'com-fotos';
}

/* -------------------------------------------------------------------------- */
/*                                   One unit                                  */
/* -------------------------------------------------------------------------- */

export interface DepsFotosLi {
  readonly db: Firestore;
  /** `contexto.cdn`: the photo reader built behind the read switch, and only there. */
  readonly cdn: LeitorCdnLi;
  /** The upload seam ({@link criarGuardarFotoLi}); `null` = no bucket, nothing is attempted. */
  readonly guardar: GuardarFotoLi | null;
  /** The pacer's sleep: {@link RITMO_LEITURA_LI_MS} before every download. */
  readonly esperar: (ms: number) => Promise<void>;
  /** The job's clock, ms: the produto's `ultimaModificacao`. */
  readonly agoraMs: () => number;
  readonly logger: LoggerFotosLi;
}

/** A family's pictures, once every target is done: the tallies and the pendências. */
export interface ResultadoFotosDaFamiliaLi {
  /** Every target, in order, with how it ended. */
  readonly produtos: readonly ProdutoComFotosLi[];
  /** Pictures written onto produtos (the job's `contadores.fotos`). */
  readonly gravadas: number;
  /** `foto-recusada` (informational) per picture refused; `conflito-de-escrita` per produto lost. */
  readonly pendencias: readonly PendenciaDoPlanoLi[];
}

/** What one unit came to. */
export type PassoFotosLi =
  /** No bucket: nothing read, nothing fetched. The caller stamps `fotosIndisponiveis`. */
  | { readonly tipo: 'sem-bucket' }
  /** Checkpoint `cursor`; the family has more pictures. */
  | { readonly tipo: 'progresso'; readonly cursor: CursorFotosLi; readonly downloads: number }
  /**
   * An upload outlived its deadline: checkpoint `cursor` (that picture still to do) and run no more
   * photo unit in this dispatch.
   */
  | { readonly tipo: 'parar'; readonly cursor: CursorFotosLi; readonly downloads: number }
  /** Every target is done. */
  | {
      readonly tipo: 'concluido';
      readonly resultado: ResultadoFotosDaFamiliaLi;
      readonly downloads: number;
    };

/** Named members of {@link PassoFotosLi}'s `tipo`. */
export const TIPO_PASSO_FOTOS_LI = {
  semBucket: 'sem-bucket',
  progresso: 'progresso',
  parar: 'parar',
  concluido: 'concluido',
} as const satisfies Record<string, PassoFotosLi['tipo']>;

/** The family's result from a cursor's tallies. Pure. */
export function resultadoDasFotosLi(
  cursor: Pick<CursorFotosLi, 'feitos' | 'recusadas'>,
): ResultadoFotosDaFamiliaLi {
  const pendencias: PendenciaDoPlanoLi[] = [
    ...cursor.recusadas.map((r) => ({
      codigo: PENDENCIA_IMPORTACAO_LI.fotoRecusada,
      liId: r.liId,
      referencias: [String(r.imagemId), r.motivo],
    })),
    ...cursor.feitos
      .filter(
        (f) =>
          f.desfecho === DESFECHO_FOTOS_DO_PRODUTO_LI.conflito ||
          f.desfecho === DESFECHO_FOTOS_DO_PRODUTO_LI.ausente,
      )
      .map((f) => ({
        codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
        liId: f.liId,
        referencias: [f.produtoId],
      })),
  ];
  return {
    produtos: cursor.feitos,
    gravadas: cursor.feitos.reduce((soma, f) => soma + f.fotos, 0),
    pendencias,
  };
}

/** The cursor once `feito` closes the current target: the next target, from its first picture. */
function avancar(
  alvos: readonly AlvoDeFotosLi[],
  cursor: CursorFotosLi,
  feito: ProdutoComFotosLi,
): CursorFotosLi {
  const i = alvos.findIndex((a) => a.produtoId === cursor.produtoId);
  return {
    produtoId: alvos[i + 1]?.produtoId ?? null,
    proxima: 0,
    reduzida: false,
    enviadas: [],
    feitos: [...cursor.feitos, feito],
    recusadas: cursor.recusadas,
  };
}

/** Its pictures START: no picture of it decided yet. */
function comecando(cursor: CursorFotosLi): boolean {
  return cursor.proxima === 0 && !cursor.reduzida && cursor.enviadas.length === 0;
}

/**
 * ONE unit of a family's pictures (module header, "One unit"): from `cursor` (`null` = the family's
 * first unit), at most one download, its upload, and — after a produto's last picture — that
 * produto's write.
 *
 * @throws {RangeError} for a cursor naming a produto the targets do not hold (another plan's).
 */
export async function executarUnidadeDeFotoLi(
  deps: DepsFotosLi,
  alvos: readonly AlvoDeFotosLi[],
  cursor: CursorFotosLi | null,
): Promise<PassoFotosLi> {
  const guardar = deps.guardar;
  if (guardar === null) return { tipo: TIPO_PASSO_FOTOS_LI.semBucket };
  let estado = cursor ?? cursorInicialDeFotosLi(alvos);
  let downloads = 0;
  for (;;) {
    if (estado.produtoId === null) {
      return {
        tipo: TIPO_PASSO_FOTOS_LI.concluido,
        resultado: resultadoDasFotosLi(estado),
        downloads,
      };
    }
    const produtoId = estado.produtoId;
    const alvo = alvos.find((a) => a.produtoId === produtoId);
    if (alvo === undefined) {
      throw new RangeError(`fotos: o cursor nomeia um produto fora do plano (${produtoId})`);
    }
    // Every picture of this produto is decided: write them (after this unit's download too).
    if (estado.proxima >= alvo.imagens.length) {
      estado = avancar(alvos, estado, await gravarFotosDoProdutoLi(deps, alvo, estado.enviadas));
      continue;
    }
    // At most one download per unit: the next one is the next unit's.
    if (downloads > 0) return { tipo: TIPO_PASSO_FOTOS_LI.progresso, cursor: estado, downloads };
    if (comecando(estado)) {
      const situacao = await situacaoNoInicioLi(deps.db, alvo.produtoId);
      if (situacao !== 'sem-fotos') {
        estado = avancar(alvos, estado, {
          produtoId: alvo.produtoId,
          liId: alvo.liId,
          desfecho:
            situacao === 'ausente'
              ? DESFECHO_FOTOS_DO_PRODUTO_LI.ausente
              : DESFECHO_FOTOS_DO_PRODUTO_LI.comFotos,
          fotos: 0,
        });
        continue;
      }
    }

    const imagem = alvo.imagens[estado.proxima];
    if (imagem === undefined) throw new RangeError('fotos: índice de imagem fora da lista');
    const forma: FormaImagemLi = estado.reduzida
      ? FORMA_IMAGEM_LI.reduzida
      : FORMA_IMAGEM_LI.original;
    await deps.esperar(RITMO_LEITURA_LI_MS);
    const baixada = await deps.cdn.baixarImagemLi(imagem.caminho, { forma });
    downloads += 1;

    if (baixada.resultado === 'ok') {
      const hash = hashDaFotoLi(baixada.bytes);
      const guardada = await guardarComPrazoLi(
        guardar,
        {
          produtoId: alvo.produtoId,
          hash,
          bytes: baixada.bytes,
          tipo: baixada.tipo,
          imagemId: imagem.id,
        },
        deps.logger,
      );
      if (!guardada) {
        deps.logger.warn(
          '[loja-integrada] importação: envio de foto passou do prazo; as fotos param neste despacho',
          { produtoId: alvo.produtoId, imagemId: imagem.id, prazoMs: PRAZO_UPLOAD_LI_MS },
        );
        return { tipo: TIPO_PASSO_FOTOS_LI.parar, cursor: estado, downloads };
      }
      estado = {
        ...estado,
        proxima: estado.proxima + 1,
        reduzida: false,
        enviadas: [...estado.enviadas, { imagemId: imagem.id, hash }],
      };
      continue;
    }
    if (baixada.resultado === 'muito-grande' && forma === FORMA_IMAGEM_LI.original) {
      // The reduced form is a unit of its own, under its own budget check (module header).
      return {
        tipo: TIPO_PASSO_FOTOS_LI.progresso,
        cursor: { ...estado, reduzida: true },
        downloads,
      };
    }
    deps.logger.warn('[loja-integrada] importação: foto recusada', {
      produtoId: alvo.produtoId,
      liId: alvo.liId,
      imagemId: imagem.id,
      forma,
      resultado: baixada.resultado,
      ...('status' in baixada ? { status: baixada.status } : {}),
      // A redirect's target HOST only, never its path or query.
      ...('host' in baixada ? { host: baixada.host } : {}),
    });
    estado = {
      ...estado,
      proxima: estado.proxima + 1,
      reduzida: false,
      recusadas: [
        ...estado.recusadas,
        { liId: alvo.liId, imagemId: imagem.id, motivo: baixada.resultado },
      ],
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Simular                                  */
/* -------------------------------------------------------------------------- */

/**
 * The pictures a real run WOULD fetch for a family's targets (module header, "Simular"): no
 * download, no upload, no write. A target in `criados` (a produto this run creates, or would) is
 * counted whole with no read; any other is read once: gone or with a photo ⇒ none.
 */
export async function contarFotosSimuladasLi(
  db: Firestore,
  alvos: readonly AlvoDeFotosLi[],
  criados: ReadonlySet<string>,
): Promise<ResultadoFotosDaFamiliaLi> {
  const produtos: ProdutoComFotosLi[] = [];
  for (const alvo of alvos) {
    const situacao = criados.has(alvo.produtoId)
      ? 'sem-fotos'
      : await situacaoNoInicioLi(db, alvo.produtoId);
    produtos.push({
      produtoId: alvo.produtoId,
      liId: alvo.liId,
      desfecho:
        situacao === 'sem-fotos'
          ? DESFECHO_FOTOS_DO_PRODUTO_LI.importadas
          : situacao === 'ausente'
            ? DESFECHO_FOTOS_DO_PRODUTO_LI.ausente
            : DESFECHO_FOTOS_DO_PRODUTO_LI.comFotos,
      fotos: situacao === 'sem-fotos' ? alvo.imagens.length : 0,
    });
  }
  return {
    produtos,
    gravadas: produtos.reduce((soma, p) => soma + p.fotos, 0),
    // A Simular foresees no refusal and loses no race: it reports nothing a real run would.
    pendencias: [],
  };
}
