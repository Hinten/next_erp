/**
 * **The photo UP-direction: `arquivos` → `upload_image` → `image_id`, cached on
 * `arquivos.externalIds`.**
 *
 * A publish sends `image_id`s, never bytes and never URLs. This module turns the
 * produto's `Foto[]` into that list: a cached id is reused, a missing one is
 * downloaded from Firebase Storage, uploaded through `upload_image` and the
 * minted id is written back so the next publish costs one document read.
 *
 * ## ⚠️ A FACTORY, because the memo has to outlive one call
 *
 * One publish resolves the ITEM's photo set AND one set per tier-1 option (the
 * `fotosForVariacao` cascade hands the same `Foto` to a parent and to an
 * option). The miss path appends to `externalIds` with `arrayUnion`, so a second
 * pass that re-read the document would be reading its own write — and a
 * six-colour produto would read each `arquivos` document seven times and could
 * upload the same bytes twice. {@link criarResolvedorDeImagens} therefore hands
 * back ONE resolver whose memo spans every {@link ResolvedorDeImagensShopee.resolver}
 * call of that publish. {@link resolverImagensParaPublicar} exists for the
 * single-set caller and is deliberately NOT what the publisher uses.
 *
 * ## ⚠️ `slice`, not `break` — and the ORDER is the contract
 *
 * Shopee renders `image_id_list` POSITIONALLY, so the answer is the input order
 * minus the failures: a re-order is a visible change to a live listing. The cap
 * is applied with `slice` BEFORE any work, so "considered" is a number the
 * caller can trust; stopping after N successes would make the discard count
 * depend on how many photos failed.
 *
 * ## ⚠️ Why this does not reuse the import direction's reader
 *
 * `produtos/fotosShopee.ts`'s `idsDeImagemJaImportados` answers a `string[]` —
 * the SET of ids already cached, with the arquivo→id mapping discarded. That is
 * exactly right for the import direction (it only has to subtract), and useless
 * here: this direction needs to know WHICH arquivo owns which id, positionally.
 * The tolerant `documents/integracao/<id>` vs `integracao/<id>` comparison is
 * copied in spirit and re-derived here on the entry rather than on the id.
 *
 * ## ⚠️ The SSRF guard is the allow-list PLUS `redirect: 'manual'`
 *
 * These bytes are fetched SERVER-side. The host is matched against an ANCHORED
 * allow-list before the request, and because `fetch` follows redirects by
 * default — connecting to whatever the allowed host answered with, which the
 * allow-list never sees — any 3xx is refused outright, naming the status and the
 * host we ASKED for. Never the `Location` value: that is attacker-chosen text
 * and would land in the one log line this module exists to keep clean.
 *
 * ## ⚠️ The failure split, and why it is NOT the import direction's
 *
 * A picture problem ({@link ShopeeFotoPublicacaoError}), a `TypeError` (how a
 * fetch network failure surfaces), a per-INDEX `error` inside `image_info_list`,
 * and an `upload_image` refusal of the image CONTENT are skipped, counted and
 * logged once. **Everything else propagates and fails the publish** — a rate
 * limit, a reauth, any other `ShopeeApiError`, any Firestore error. A listing
 * created live with half its pictures because the app was throttled is worse
 * than a publish that failed and can be retried. The import direction skips a
 * picture on ANY Shopee image error; that asymmetry is deliberate.
 *
 * ⚠️ `imageIds.length === 0` is **not** a throw here. The module answers an
 * empty list and the publisher refuses with `sem-fotos` before `add_item`, where
 * the blocked vocabulary lives.
 *
 * ## ⚠️ No clock, no environment
 *
 * The multipart filename is `${arquivoId}.${ext}` — deterministic. The legacy
 * Flutter exporter named it `image<microsecondsSinceEpoch>`, which made two
 * uploads of the same bytes indistinguishable from two different pictures. The
 * Storage-emulator origin is a PARAMETER read at the composition root; nothing
 * in this folder reads `process.env`.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type ShopeeUploadImageResponse,
  type UploadImageParams,
  ShopeeApiError,
  SHOPEE_ITEM_IMAGE_MAX,
  SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES,
  SHOPEE_UPLOAD_IMAGE_MAX_BYTES,
  shopeeCodeSemPrefixoDeModulo,
} from '@delfrance/integrations-shopee';
import { type Foto, normalizeContentType, toOuterRef } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { isNotFound } from '@delfrance/data/admin';

/* -------------------------------------------------------------------------- */
/*                          The picture-level vocabulary                      */
/* -------------------------------------------------------------------------- */

/**
 * Why one picture was skipped.
 *
 * ⚠️ **NOT a persisted vocabulary.** It reaches a log line and (through the
 * publisher) a problema `mensagem`; no document stores it, so renaming a member
 * is free. The persisted publish vocabularies live in `errosPublicacao.ts`.
 */
export type MotivoFotoPublicacao =
  | 'arquivo-ausente'
  | 'sem-url'
  | 'host-nao-permitido'
  | 'esquema-nao-permitido'
  | 'redirecionamento'
  | 'http'
  | 'content-type'
  | 'tamanho'
  | 'upload-recusado'
  | 'sem-image-id';

/** One motivo per key, so a producer never spells the slug by hand. */
export const MOTIVO_FOTO_PUBLICACAO = {
  arquivoAusente: 'arquivo-ausente',
  semUrl: 'sem-url',
  hostNaoPermitido: 'host-nao-permitido',
  esquemaNaoPermitido: 'esquema-nao-permitido',
  redirecionamento: 'redirecionamento',
  http: 'http',
  contentType: 'content-type',
  tamanho: 'tamanho',
  uploadRecusado: 'upload-recusado',
  semImageId: 'sem-image-id',
} as const satisfies Record<string, MotivoFotoPublicacao>;

/**
 * A picture-level problem: skip this picture, count it, keep publishing.
 *
 * ⚠️ Deliberately NOT a `ShopeeError`: it never crosses an HTTP boundary and is
 * never classified by `respond.ts`. It exists so the catch below can narrow by
 * class instead of by message (root `CLAUDE.md` rule 6).
 */
export class ShopeeFotoPublicacaoError extends Error {
  readonly motivo: MotivoFotoPublicacao;
  /**
   * The host the download was ASKED for, when the failure knows one.
   *
   * ⚠️ A FIELD and not a re-parse of `message`, and not a re-parse of the url at
   * the log site either. The log line must name the host and must never name the
   * url (a Firebase download link carries a token), so the one value that is
   * safe to log travels as data. `null` whenever no host was involved — an
   * absent arquivo, a url that does not parse, an upload refusal.
   */
  readonly host: string | null;

  constructor(motivo: MotivoFotoPublicacao, message: string, host: string | null = null) {
    super(message);
    this.name = 'ShopeeFotoPublicacaoError';
    this.motivo = motivo;
    this.host = host;
  }
}

export interface FalhaDeFotoPublicacao {
  readonly arquivoId: string;
  readonly motivo: MotivoFotoPublicacao;
  /** A MECHANISM sentence. Never a URL, never a token, never bytes. */
  readonly mensagem: string;
}

export interface ResultadoFotosPublicacao {
  /**
   * In the SAME ORDER as the input, minus the failures — Shopee renders
   * `image_id_list` positionally.
   */
  readonly imageIds: readonly string[];
  /** Cache hits: no fetch, no upload. A MEMO hit counts here for neither. */
  readonly reutilizadas: number;
  /** Fetched and uploaded on this call. */
  readonly enviadas: number;
  readonly falhas: readonly FalhaDeFotoPublicacao[];
  /** `fotos.length` AFTER the cap — what was attempted. */
  readonly consideradas: number;
  /** `fotos.length` BEFORE the cap, minus {@link ResultadoFotosPublicacao.consideradas}. */
  readonly descartadasPeloLimite: number;
}

/**
 * The whole publish's running totals, for the ONE log line at the end.
 *
 * ⚠️ `falhas` is a COUNT here and a LIST on {@link ResultadoFotosPublicacao}.
 * This shape is written straight into a log line, and a log line in this app
 * carries ids, counts, enum tokens and booleans — never prose.
 */
export interface ResumoFotosPublicacao {
  readonly consideradas: number;
  readonly reutilizadas: number;
  readonly enviadas: number;
  readonly falhas: number;
  readonly descartadasPeloLimite: number;
}

export interface DepsFotosPublicacao {
  readonly db: Firestore;
  readonly integracaoId: string;
  /** For the log line only — this module reads no produto document. */
  readonly produtoId: string;
  /**
   * The package's partner-client upload, injected as a FUNCTION rather than a
   * client (C8): the unit test needs no client double, and the signing mode is
   * decided ONCE at the composition root. The publisher binds it as
   * `(p) => deps.partnerClient().uploadImage(p)`.
   *
   * ⚠️ The WHOLE parsed envelope comes back, like every write in the package
   * (C9) — `warning` is a partial-failure channel and unwrapping it here would
   * make it unreachable.
   */
  readonly enviarImagem: (p: UploadImageParams) => Promise<ShopeeUploadImageResponse>;
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * The Storage-emulator ORIGIN (`http://127.0.0.1:9199`), when one is
   * configured. Read at the COMPOSITION ROOT and passed in: this folder reads no
   * environment.
   */
  readonly hostEmulador?: string | null;
}

export interface ResolvedorDeImagensShopee {
  /**
   * `cap` defaults to `SHOPEE_ITEM_IMAGE_MAX`. The tier-1 option pass uses
   * `{ cap: 1 }` — an option carries at most one image.
   */
  resolver(
    fotos: readonly Foto[],
    opcoes?: { readonly cap?: number },
  ): Promise<ResultadoFotosPublicacao>;
  /** The totals across EVERY `resolver()` call of this publish. */
  resumo(): ResumoFotosPublicacao;
}

/* -------------------------------------------------------------------------- */
/*                            The download allow-list                         */
/* -------------------------------------------------------------------------- */

/**
 * The hosts a Firebase Storage download URL can name.
 *
 * `putArquivoAdmin` mints every url through `firebaseDownloadUrl`, which is
 * always `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/…`. The second
 * entry covers the migrated corpus, whose Flutter-written urls can be the
 * classic `storage.googleapis.com` object form.
 *
 * ⚠️ Anchored `^…$`, no wildcard tail — the `HOSTS_DE_IMAGEM_SHOPEE` rule: a
 * permissive tail is satisfied by a domain we do not own
 * (`firebasestorage.googleapis.com.<anything an attacker registers>`), and this
 * fetch runs SERVER-side.
 */
export const HOSTS_DE_DOWNLOAD_ARQUIVO: readonly RegExp[] = [
  /^firebasestorage\.googleapis\.com$/i,
  /^storage\.googleapis\.com$/i,
];

/** The extension the deterministic filename carries, per accepted content type. */
const EXTENSAO_POR_TIPO: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

const PREFIXO_ARQUIVOS = 'arquivos/';

/** `origin` (scheme + host + port) of an origin string, or `null` when unusable. */
function origemDe(bruta: string): string | null {
  try {
    return new URL(bruta).origin;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * Validate the URL before the server-side fetch.
 *
 * ⚠️ `http:` is REFUSED here, not upgraded. The import direction upgrades
 * because Shopee's CDN serves both; a Firebase download url is `https` BY
 * CONSTRUCTION, so an `http:` one is not ours and upgrading it would connect to
 * a host nobody vouched for.
 *
 * The ONE exception is the injected emulator origin, which is
 * `http://127.0.0.1:<port>` by nature. It is compared ORIGIN-EXACTLY — scheme,
 * host AND port — and never by regex, so a different port on the same loopback
 * host is refused like any other unknown origin. It is checked FIRST precisely
 * because it is the arm that is allowed to be `http:`.
 */
export function urlDeDownloadSegura(bruta: string, hostEmulador?: string | null): URL {
  let parsed: URL;
  try {
    parsed = new URL(bruta);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ShopeeFotoPublicacaoError(
        MOTIVO_FOTO_PUBLICACAO.esquemaNaoPermitido,
        'URL de download inválida',
      );
    }
    throw err;
  }

  if (typeof hostEmulador === 'string' && hostEmulador !== '') {
    const alvo = origemDe(hostEmulador);
    if (alvo !== null && parsed.origin === alvo) return parsed;
  }

  if (parsed.protocol !== 'https:') {
    throw new ShopeeFotoPublicacaoError(
      MOTIVO_FOTO_PUBLICACAO.esquemaNaoPermitido,
      `esquema de URL não permitido: ${parsed.protocol}`,
      parsed.host,
    );
  }
  if (!HOSTS_DE_DOWNLOAD_ARQUIVO.some((re) => re.test(parsed.hostname))) {
    throw new ShopeeFotoPublicacaoError(
      MOTIVO_FOTO_PUBLICACAO.hostNaoPermitido,
      `host de download não permitido: ${parsed.host}`,
      parsed.host,
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/*                                  The resolver                              */
/* -------------------------------------------------------------------------- */

/**
 * The integração ref match, TOLERANT on purpose.
 *
 * The canonical `documents/integracao/<id>` and the bare `integracao/<id>` form
 * both count: a strict comparison would silently re-upload every picture of
 * every produto whose arquivos were written in the older form. A ref naming a
 * DIFFERENT integração never matches — the cache is per conta.
 */
function refCasaIntegracao(ref: unknown, integracaoId: string): boolean {
  if (typeof ref !== 'string') return false;
  return ref === `documents/integracao/${integracaoId}` || ref === `integracao/${integracaoId}`;
}

/** `arquivos/<id>` → `<id>`; anything else is already the bare id. */
function arquivoIdDaFoto(foto: Foto): string {
  const ref = foto.arquivoOuterRef;
  if (typeof ref !== 'string') return '';
  return ref.startsWith(PREFIXO_ARQUIVOS) ? ref.slice(PREFIXO_ARQUIVOS.length) : ref;
}

/** The cached `image_id` for THIS integração, or `null`. */
function idEmCache(dados: unknown, integracaoId: string): string | null {
  const externos = (dados as { externalIds?: unknown } | undefined)?.externalIds;
  if (!Array.isArray(externos)) return null;
  for (const entrada of externos as Array<Record<string, unknown>>) {
    const id = entrada.externalId;
    if (typeof id !== 'string' || id === '') continue;
    if (refCasaIntegracao(entrada.integracaoPath, integracaoId)) return id;
  }
  return null;
}

/**
 * Is this `upload_image` refusal about the image CONTENT?
 *
 * Orchestrator ruling O8, from the 2026-09-17 sandbox probe: a 16×16 PNG came
 * back `product.error_param: image is invalid or not supported`, so an
 * undocumented minimum image size exists and it is a PICTURE problem. The
 * `error_image*` family is the same class.
 *
 * ⚠️ Narrowed by `kind` and by the module-prefix-STRIPPED code, never by the
 * message: `product.error_param` and `error_param` are one code, and a rate
 * limit or a reauth carries a kind of its own and must never land here.
 */
function ehRecusaDeConteudo(err: ShopeeApiError): boolean {
  if (err.kind !== 'other') return false;
  const semPrefixo = shopeeCodeSemPrefixoDeModulo(err.code) ?? err.code;
  return semPrefixo === 'error_param' || semPrefixo.startsWith('error_image');
}

/** The `image_id` this envelope minted, or the picture problem it carries. */
function idDaResposta(envelope: ShopeeUploadImageResponse): string {
  const direto = envelope.response.image_info?.image_id;
  if (typeof direto === 'string' && direto !== '') return direto;

  const lista = envelope.response.image_info_list ?? [];
  for (const entrada of lista) {
    const erro = entrada.error;
    if (typeof erro === 'string' && erro !== '') continue;
    const id = entrada.image_info?.image_id;
    if (typeof id === 'string' && id !== '') return id;
  }
  // ⚠️ Shopee's `error` CODE, never its `message` — that one is provider prose.
  const recusada = lista.find((e) => typeof e.error === 'string' && e.error !== '');
  if (recusada !== undefined) {
    throw new ShopeeFotoPublicacaoError(
      MOTIVO_FOTO_PUBLICACAO.uploadRecusado,
      `upload recusado por índice: ${String(recusada.error)}`,
    );
  }
  throw new ShopeeFotoPublicacaoError(
    MOTIVO_FOTO_PUBLICACAO.semImageId,
    'upload aceito sem image_id',
  );
}

/**
 * ONE resolver per publish. The memo spans every
 * {@link ResolvedorDeImagensShopee.resolver} call — see the module header.
 */
export function criarResolvedorDeImagens(deps: DepsFotosPublicacao): ResolvedorDeImagensShopee {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  /** `arquivoId` → the `image_id` already resolved in THIS publish. */
  const memo = new Map<string, string>();
  let totalConsideradas = 0;
  let totalReutilizadas = 0;
  let totalEnviadas = 0;
  let totalFalhas = 0;
  let totalDescartadas = 0;

  /**
   * ONE read of `arquivos/{id}`, answering either the cached id or the url to
   * download.
   *
   * ⚠️ One read, deliberately: a second `.get()` for the url would double every
   * miss's document reads and Enterprise bills data scanned. The memo above then
   * makes the whole publish cost one read per DISTINCT arquivo.
   */
  async function lerArquivo(
    arquivoId: string,
  ): Promise<
    | { readonly kind: 'cache'; readonly id: string }
    | { readonly kind: 'baixar'; readonly url: string }
  > {
    const snap = await arquivoCollection.docRef(deps.db, {}, arquivoId).get();
    if (!snap.exists) {
      throw new ShopeeFotoPublicacaoError(
        MOTIVO_FOTO_PUBLICACAO.arquivoAusente,
        'documento de arquivo ausente',
      );
    }
    const dados = snap.data();
    const cacheado = idEmCache(dados, deps.integracaoId);
    if (cacheado !== null) return { kind: 'cache', id: cacheado };

    const url = (dados as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string' || url === '') {
      throw new ShopeeFotoPublicacaoError(MOTIVO_FOTO_PUBLICACAO.semUrl, 'arquivo sem url');
    }
    return { kind: 'baixar', url };
  }

  /** Download the bytes, refusing anything the allow-list or Shopee will not take. */
  async function baixar(
    url: URL,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }> {
    // ⚠️ `redirect: 'manual'` — the allow-list checked the host we ASK for, and a
    // followed redirect would connect to one nobody checked. See the header.
    const res = await doFetch(url.toString(), { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      // ⚠️ The status and the HOST we asked — never the `Location` value.
      throw new ShopeeFotoPublicacaoError(
        MOTIVO_FOTO_PUBLICACAO.redirecionamento,
        `redirecionamento HTTP ${String(res.status)} recusado (host ${url.host})`,
        url.host,
      );
    }
    if (!res.ok) {
      throw new ShopeeFotoPublicacaoError(
        MOTIVO_FOTO_PUBLICACAO.http,
        `HTTP ${String(res.status)} ao baixar o arquivo`,
        url.host,
      );
    }

    const contentType = normalizeContentType(res.headers.get('content-type') ?? '');
    if (!(SHOPEE_UPLOAD_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      // ⚠️ Stricter than `image/*`: a GIF or a WebP original is real in this
      // corpus and Shopee refuses it. A named skip beats an `error_param`.
      throw new ShopeeFotoPublicacaoError(
        MOTIVO_FOTO_PUBLICACAO.contentType,
        `content-type não aceito pelo Shopee: "${contentType}"`,
        url.host,
      );
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > SHOPEE_UPLOAD_IMAGE_MAX_BYTES) {
      // ⚠️ Checked here as well as in the package guard: here it costs ONE
      // skipped picture, there it would be a ShopeeConfigError aborting the
      // whole publish.
      throw new ShopeeFotoPublicacaoError(
        MOTIVO_FOTO_PUBLICACAO.tamanho,
        `arquivo de ${String(bytes.byteLength)} bytes acima do limite do upload`,
        url.host,
      );
    }
    return { bytes, contentType };
  }

  /**
   * Cache the minted id.
   *
   * ⚠️ `arrayUnion` (root `CLAUDE.md` rule 7, **tier 0** — nothing to compare,
   * nothing to lose): the array is shared across contas and a whole-array write
   * would drop a sibling conta's entry. NOT `mergeIfExists`: that handle
   * full-parses the patch, and a `FieldValue` sentinel is not an array of
   * `externalIdSchema`.
   *
   * ⚠️ A gRPC NOT_FOUND is tier 3 DOWNGRADED to a log line: the arquivo was
   * deleted between the read above and here (the orphan sweep does exactly
   * that), the `image_id` is already minted and usable, and only the CACHE entry
   * is lost. Every other gRPC code propagates and fails the publish.
   */
  async function gravarCache(arquivoId: string, imageId: string): Promise<void> {
    try {
      await arquivoCollection.docRef(deps.db, {}, arquivoId).update({
        externalIds: FieldValue.arrayUnion({
          externalId: imageId,
          integracaoPath: toOuterRef(`integracao/${deps.integracaoId}`),
        }),
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      console.warn('[shopee/publicacao] cache de image_id não gravado: arquivo ausente', {
        produtoId: deps.produtoId,
        integracaoId: deps.integracaoId,
        arquivoId,
      });
    }
  }

  /** One picture, end to end. Answers the `image_id`; throws a picture problem. */
  async function resolverUma(
    arquivoId: string,
  ): Promise<{ readonly id: string; readonly reutilizada: boolean }> {
    const lido = await lerArquivo(arquivoId);
    if (lido.kind === 'cache') return { id: lido.id, reutilizada: true };

    const url = urlDeDownloadSegura(lido.url, deps.hostEmulador);
    const { bytes, contentType } = await baixar(url);
    const envelope = await deps.enviarImagem({
      bytes,
      // ⚠️ DETERMINISTIC. There is no clock under `anuncios/`.
      filename: `${arquivoId}.${EXTENSAO_POR_TIPO[contentType] ?? 'jpg'}`,
      contentType,
    });
    const imageId = idDaResposta(envelope);
    await gravarCache(arquivoId, imageId);
    return { id: imageId, reutilizada: false };
  }

  return {
    async resolver(fotos, opcoes) {
      const cap = opcoes?.cap ?? SHOPEE_ITEM_IMAGE_MAX;
      // ⚠️ `slice` BEFORE any work, never a `break` after N successes.
      const consideradas = fotos.slice(0, cap);
      const descartadasPeloLimite = fotos.length - consideradas.length;

      const imageIds: string[] = [];
      const falhas: FalhaDeFotoPublicacao[] = [];
      let reutilizadas = 0;
      let enviadas = 0;

      for (const foto of consideradas) {
        const arquivoId = arquivoIdDaFoto(foto);
        const memoizado = memo.get(arquivoId);
        if (memoizado !== undefined) {
          // Already counted on its first resolution in this publish.
          imageIds.push(memoizado);
          continue;
        }
        try {
          const { id, reutilizada } = await resolverUma(arquivoId);
          memo.set(arquivoId, id);
          imageIds.push(id);
          if (reutilizada) reutilizadas += 1;
          else enviadas += 1;
        } catch (err) {
          const motivo = motivoDeFalha(err);
          if (motivo === null) throw err;
          falhas.push({ arquivoId, motivo, mensagem: mensagemDeFalha(err) });
          // ⚠️ ONE line, and it carries the HOST — never the URL, which is a
          // Firebase download link and therefore carries a token.
          console.warn('[shopee/publicacao] foto ignorada', {
            produtoId: deps.produtoId,
            integracaoId: deps.integracaoId,
            arquivoId,
            host: hostDeFalha(err),
            motivo,
          });
        }
      }

      totalConsideradas += consideradas.length;
      totalDescartadas += descartadasPeloLimite;
      totalReutilizadas += reutilizadas;
      totalEnviadas += enviadas;
      totalFalhas += falhas.length;

      return {
        imageIds,
        reutilizadas,
        enviadas,
        falhas,
        consideradas: consideradas.length,
        descartadasPeloLimite,
      };
    },
    resumo() {
      return {
        consideradas: totalConsideradas,
        reutilizadas: totalReutilizadas,
        enviadas: totalEnviadas,
        falhas: totalFalhas,
        descartadasPeloLimite: totalDescartadas,
      };
    },
  };
}

/**
 * The motivo a skippable failure carries, or `null` when it must PROPAGATE.
 *
 * Skippable: a picture problem, a fetch network failure (a `TypeError`), and an
 * `upload_image` refusal of the image CONTENT (O8). Everything else — a rate
 * limit, a reauth, any other `ShopeeApiError`, any Firestore error — fails the
 * publish.
 */
function motivoDeFalha(err: unknown): MotivoFotoPublicacao | null {
  if (err instanceof ShopeeFotoPublicacaoError) return err.motivo;
  if (err instanceof ShopeeApiError) {
    return ehRecusaDeConteudo(err) ? MOTIVO_FOTO_PUBLICACAO.uploadRecusado : null;
  }
  if (err instanceof TypeError) return MOTIVO_FOTO_PUBLICACAO.http;
  return null;
}

/** A MECHANISM sentence — a code for a Shopee refusal, never provider prose. */
function mensagemDeFalha(err: unknown): string {
  if (err instanceof ShopeeApiError) return `upload recusado: ${err.code}`;
  if (err instanceof ShopeeFotoPublicacaoError) return err.message;
  if (err instanceof TypeError) return 'falha de rede ao baixar o arquivo';
  return 'falha desconhecida';
}

/**
 * The host the log line names.
 *
 * ⚠️ Read off the ERROR's own field, never off the url at the call site: the
 * whole point of this module's logging rule is that the token-bearing string
 * never reaches a place where a `String(...)` could pick it up.
 */
function hostDeFalha(err: unknown): string | null {
  return err instanceof ShopeeFotoPublicacaoError ? err.host : null;
}

/**
 * The single-set convenience.
 *
 * ⚠️ The publisher does NOT call this — it needs one resolver whose memo spans
 * the item pass and every tier-1 option pass (C7).
 */
export function resolverImagensParaPublicar(
  deps: DepsFotosPublicacao,
  fotos: readonly Foto[],
): Promise<ResultadoFotosPublicacao> {
  return criarResolvedorDeImagens(deps).resolver(fotos);
}
