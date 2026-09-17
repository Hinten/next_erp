/**
 * **Re-verify ONE Shopee listing** (#1519, step 11 — S10) — the READ path the
 * operator presses when the stored reading looks stale.
 *
 * Two Shopee calls (three with models) and it writes only what it just READ:
 * `get_item_base_info` for the status, the deboost and the schedule;
 * `get_item_violation_info`, BEST-EFFORT, for the violation and deboost detail;
 * `get_model_list` when the listing has models, whose child-link refresh is
 * `sincronizarLinksDeVariacao` — C10's ONE implementation, shared with the
 * publisher's model leg, never a second loop here.
 *
 * ## ⚠️ It writes the STATUS and nothing else
 *
 * The patch is exactly
 * `{ item_status, estadoAnuncio, deboost, condition, violations?, violacoesLidasEm?, ultimaModificacao }`.
 * It does **not** refresh `item_name`, `category_id`, `attributes` or
 * `logistic_info` — those belong to the import and to the publisher, and the ML
 * seven-writers invariant is exactly this: a writer that merely holds a fresh
 * status writes the status and nothing else.
 *
 * ## ⚠️ A listing Shopee no longer has writes NO `item_status`
 *
 * `error_item_not_found` — or a payload with no readable row for the id we asked
 * about — is the `ausente` reading, which folds to `estadoAnuncio: 'removido'`.
 * The patch there carries `estadoAnuncio`, `violacoesLidasEm` and
 * `ultimaModificacao` and **not** `item_status`: the handler did not READ one,
 * and writing a status it invented is precisely the legacy defect
 * (`tasks.dart` stamped `SELLER_DELETE` from a 404). The narrowing is
 * byte-identical to `produtos/lerAnuncio.ts`'s, and everything else rethrows
 * (root `CLAUDE.md` rule 6).
 *
 * ## ⚠️ The violation read is BEST-EFFORT, and only for the class that is ours
 *
 * A `ShopeeApiError` of kind `other` — including the documented
 * `error_param: item_status does not match latest violation` — and a per-ROW
 * `fail_error` are both "no violation detail this time": `violacoesLidas: false`,
 * the STORED `violations` are left exactly as they are, and one `console.warn`
 * carries the CODE and never a body. Everything else — a rate limit, a network
 * failure, a schema mismatch — RETHROWS: it is not a property of this listing.
 * ⚠️ A per-row `fail_error` is the THIRD partial-failure encoding in Shopee's
 * Product module (`unlist_item` uses `success_list`/`failure_list`, this page puts
 * the failure on the row). There is deliberately no generic batch parser.
 *
 * ## ⚠️ An identical reading writes NOTHING
 *
 * The patch is compared FIELD BY FIELD against the stored values over a named key
 * list — no shared deep-equality or null-stripping helper is reachable from here
 * (the `pagamentoTx` rule, and both are banned under this folder by a raw-text
 * grep). An empty patch answers `ignorado-sem-mudanca` and issues no write at
 * all.
 *
 * ## ⚠️ It enqueues nothing, republishes nothing, and CANNOT un-ban
 *
 * `unlist_item` is refused in both directions on a BANNED item, and the only
 * documented loop is BANNED → the seller edits via `update_item` → REVIEWING →
 * Shopee decides (`announcement 769`). Any UI promising "unban" would be lying.
 *
 * Clock-free and Next-free: `deps.nowMs` is the ONE clock read and arrives as a
 * parameter, every Firestore access goes through a
 * `@delfrance/data/admin/collections` handle, and nothing here opens a
 * multi-document atomic write.
 *
 * **Cost**: 2 Shopee calls (3 with models), 1 + 1 + N Firestore reads, ≤ 1 + N
 * writes.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  type ShopeeClient,
  type ShopeeItemViolationRow,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  SHOPEE_ITEM_STATUS,
  shopeeViolacaoSchema,
  type EstadoAnuncioShopee,
  type ShopeeViolacao,
} from '@delfrance/schemas';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';

import { loadShopeeContext } from '../core/shopee';
import { itemStatusDe, montarItemLido, temModelosDe, type ItemLido } from '../produtos/itemLido';
import { itemStatusDeLink } from '../produtos/mapeamento';
import { MOTIVO_RESOLUCAO_ANUNCIO, resolverAvisoDeAnuncio } from './avisoAnuncio';
import {
  resolverLinkPorProduto,
  sincronizarLinksDeVariacao,
  type LinkDeAnuncio,
} from './linkAnuncio';
import { agendadoParaMsDe, estadoDoAnuncio } from './statusAnuncio';
import { detalhesDeDeboost, detalhesDeStatus, violacoesDeDetalhes } from './violacoesAnuncio';

/* -------------------------------------------------------------------------- */
/*                                the contract                                 */
/* -------------------------------------------------------------------------- */

export type AcaoReverificacao =
  | 'atualizado'
  | 'ignorado-sem-mudanca'
  | 'removido'
  | 'ignorado-sem-item-id';

/** ONE spelling per action, so a route and a test never write the slug twice. */
export const ACAO_REVERIFICACAO = {
  atualizado: 'atualizado',
  ignoradoSemMudanca: 'ignorado-sem-mudanca',
  removido: 'removido',
  ignoradoSemItemId: 'ignorado-sem-item-id',
} as const satisfies Record<string, AcaoReverificacao>;

export interface ContagemDeModelos {
  /** Rows the fresh `get_model_list` carried, including any this ERP binds nothing to. */
  readonly total: number;
  /** Child links whose stored reading was REFRESHED. A WRITE count. */
  readonly atualizados: number;
  /**
   * Child links this run MARKED `MODEL_UNAVAILABLE`. ⚠️ Also a WRITE count: a
   * second re-verify over an unchanged reading answers `0` while the link still
   * carries the mark (`linkAnuncio.ts`'s own deviation).
   */
  readonly ausentes: number;
}

export interface ResultadoReverificacao {
  readonly acao: AcaoReverificacao;
  readonly produtoId: string;
  readonly linkDocId: string;
  readonly itemId: number | null;
  readonly estadoAnuncio: EstadoAnuncioShopee;
  /** The RAW wire string, or `null` on the `removido` arm — nothing was read. */
  readonly itemStatus: string | null;
  readonly deboost: boolean;
  /** What is STORED after this run: the fresh rows, or the stored ones when the pull refused. */
  readonly violacoes: readonly ShopeeViolacao[];
  /** `false` when the violation pull refused — the stored rows were kept. */
  readonly violacoesLidas: boolean;
  /** `null` when the listing has no models. */
  readonly modelos: ContagemDeModelos | null;
  /** A TRANSITION: `true` only when a row was OPEN and this call closed it. */
  readonly avisoResolvido: boolean;
  /** The budget signal — the ML `chamadasMl` precedent. */
  readonly chamadasShopee: number;
}

export interface ReverificarAnuncioDeps {
  /** The client seam. Default: `loadShopeeContext(db, id).createShopClient()`. */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /**
   * The avisos counter seam. ⚠️ Unused today and deliberately required: the aviso
   * RESOLVER takes only a clock, and the day this path raises one the dep is
   * already on every call site.
   */
  readonly increment: (by: number) => unknown;
  /** The ONE clock read of this request, in MILLISECONDS. */
  readonly nowMs: number;
}

export interface AlvoDeReverificacao {
  readonly integracaoId: string;
  readonly produtoId: string;
  /** Narrows to ONE link document. A link of another conta resolves `null` (404). */
  readonly linkDocId?: string | null;
}

/** Shopee's own code for "no such item", on the batch envelope. */
const CODIGO_ITEM_NAO_ENCONTRADO = 'error_item_not_found';

/** The patch's complete key list — what a test compares against, and nothing more. */
export const CAMPOS_DO_PATCH_DE_REVERIFICACAO = [
  'item_status',
  'estadoAnuncio',
  'deboost',
  'condition',
  'violations',
  'violacoesLidasEm',
  'ultimaModificacao',
] as const;

/* -------------------------------------------------------------------------- */
/*                          reading what is stored                             */
/* -------------------------------------------------------------------------- */

function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' ? bruto : null;
}

function booleanoOuNull(bruto: unknown): boolean | null {
  return typeof bruto === 'boolean' ? bruto : null;
}

/**
 * The stored `violations`, parsed row by row — or `null` when the stored value is
 * unreadable, which counts as DIFFERENT so a garbage array is replaced rather
 * than compared against.
 *
 * An absent or `null` field is the EMPTY list: `violations` is written even when
 * there is nothing wrong (the legacy `errors`-style field), so "no rows" and
 * "never written" are the same fact here.
 */
function violacoesArmazenadas(raw: Record<string, unknown>): readonly ShopeeViolacao[] | null {
  const bruto: unknown = raw.violations;
  if (bruto === null || bruto === undefined) return [];
  if (!Array.isArray(bruto)) return null;
  const linhas = bruto as readonly unknown[];
  const saida: ShopeeViolacao[] = [];
  for (const linha of linhas) {
    const lido = shopeeViolacaoSchema.safeParse(linha);
    if (!lido.success) return null;
    saida.push(lido.data);
  }
  return saida;
}

/**
 * `violations[]` equality — the ONE fold in this module, and it drives the diff
 * that decides whether anything is written at all, so it owes a pair AND a
 * near-miss.
 *
 * **PAIR:** two readings with the same eight fields in the same order are EQUAL —
 * nothing is written and the run answers `ignorado-sem-mudanca`.
 * **NEAR-MISS:** a `fix_deadline_time` one millisecond apart, a `violation_type`
 * differing in case, a `suggested_category` whose `category_name` changed, and the
 * SAME two rows in a different ORDER are all DISTINCT. Order is part of the value
 * because `violacoesDeDetalhes` emits every status row before every deboost row,
 * so a swap means the two sides came from different arrays.
 *
 * ⚠️ Hand-rolled on purpose: the repo's shared deep-equality helper is an
 * INVENTORIED fold helper, banned under this folder by a raw-text grep, and a
 * named per-field comparison is what the property actually is.
 */
export function mesmasViolacoes(
  a: readonly ShopeeViolacao[],
  b: readonly ShopeeViolacao[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((esquerda, i) => {
    const direita = b[i];
    if (direita === undefined) return false;
    return (
      esquerda.violation_type === direita.violation_type &&
      esquerda.violation_reason === direita.violation_reason &&
      esquerda.suggestion === direita.suggestion &&
      esquerda.fix_deadline_time === direita.fix_deadline_time &&
      esquerda.update_time === direita.update_time &&
      esquerda.kind === direita.kind &&
      esquerda.days_to_fix === direita.days_to_fix &&
      mesmaCategoriaSugerida(esquerda.suggested_category, direita.suggested_category)
    );
  });
}

type CategoriaSugerida = ShopeeViolacao['suggested_category'];

/** `null` and `[]` are DIFFERENT — one is "no deboost row", the other "no suggestion". */
function mesmaCategoriaSugerida(a: CategoriaSugerida, b: CategoriaSugerida): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((esquerda, i) => {
    const direita = b[i];
    return (
      direita !== undefined &&
      esquerda.category_id === direita.category_id &&
      esquerda.category_name === direita.category_name
    );
  });
}

/* -------------------------------------------------------------------------- */
/*                                  the wire                                   */
/* -------------------------------------------------------------------------- */

async function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: ReverificarAnuncioDeps,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/**
 * ⚠️ Byte-identical to `produtos/lerAnuncio.ts`'s narrowing: on a ONE-id call
 * `error_item_not_found` on the ENVELOPE is that id's verdict and nothing wider,
 * because the batch form only raises it when EVERY id of the call is unknown.
 */
function ehItemNaoEncontrado(err: unknown): boolean {
  return (
    err instanceof ShopeeApiError &&
    err.kind === SHOPEE_ERROR_KIND.other &&
    err.code === CODIGO_ITEM_NAO_ENCONTRADO
  );
}

/** The violation row for this id, or a reason it is not a reading. */
type LeituraDeViolacao =
  | { readonly kind: 'lida'; readonly linha: ShopeeItemViolationRow }
  | { readonly kind: 'recusada'; readonly codigo: string };

function linhaDeViolacao(
  linhas: readonly (ShopeeItemViolationRow | null)[],
  itemId: number,
): LeituraDeViolacao {
  // ⚠️ Reconciled BY `item_id`, never by position — the page is batched to 50 and
  // carries a per-ELEMENT `null` sentinel.
  const linha = linhas.find((l) => l !== null && l.item_id === itemId);
  if (linha == null) return { kind: 'recusada', codigo: 'sem-linha' };
  // The THIRD partial-failure encoding: the failure rides the ROW.
  if (linha.fail_error != null && linha.fail_error !== '') {
    return { kind: 'recusada', codigo: linha.fail_error };
  }
  return { kind: 'lida', linha };
}

/* -------------------------------------------------------------------------- */
/*                                the handler                                  */
/* -------------------------------------------------------------------------- */

/**
 * Re-read one listing and store what Shopee reports NOW.
 *
 * @returns `null` when this conta holds no link for the produto — the route's
 *   **404**. `acao: 'ignorado-sem-item-id'` is the route's **409** (never
 *   published, so there is nothing to address). Everything else is a 200 whose
 *   `acao` says what happened.
 */
export async function reverificarAnuncioShopee(
  db: Firestore,
  alvo: AlvoDeReverificacao,
  deps: ReverificarAnuncioDeps,
): Promise<ResultadoReverificacao | null> {
  const link = await resolverLinkPorProduto(
    db,
    alvo.integracaoId,
    alvo.produtoId,
    alvo.linkDocId ?? null,
  );
  if (link === null) return null;

  const armazenadas = violacoesArmazenadas(link.raw);
  const violacoesAntes = armazenadas ?? [];

  if (link.itemId === null) {
    return {
      acao: ACAO_REVERIFICACAO.ignoradoSemItemId,
      produtoId: link.produtoId,
      linkDocId: link.linkDocId,
      itemId: null,
      // NOT `removido`: never published is not deleted. A stored reading wins;
      // an absent one is `desconhecido`, which is the fold's own "never folded".
      estadoAnuncio: link.estadoAnuncio ?? ESTADO_ANUNCIO_SHOPEE.desconhecido,
      itemStatus: textoOuNull(link.raw.item_status),
      deboost: booleanoOuNull(link.raw.deboost) ?? false,
      violacoes: violacoesAntes,
      violacoesLidas: false,
      modelos: null,
      avisoResolvido: false,
      chamadasShopee: 0,
    };
  }

  const itemId = link.itemId;
  const client = await clienteShopee(db, alvo.integracaoId, deps);

  /* ---- (2) the authoritative status read. */
  let chamadasShopee = 1;
  let item: ItemLido | null = null;
  try {
    const payload = await client.getItemBaseInfo({ itemIds: [itemId] });
    const legiveis = payload.item_list.filter((linha) => linha !== null);
    if (legiveis.some((linha) => linha.item_id === itemId)) {
      item = montarItemLido({ itemId, payload });
    }
  } catch (err) {
    if (!ehItemNaoEncontrado(err)) throw err;
  }

  if (item === null) {
    return await arquivarRemovido(db, alvo, link, violacoesAntes, chamadasShopee, deps);
  }

  /* ---- (3) the model leg. */
  let modelos: ContagemDeModelos | null = null;
  if (temModelosDe(item)) {
    const lista = await client.getModelList({ itemId });
    chamadasShopee += 1;
    // C10: ONE implementation of the child-link refresh, shared with the
    // publisher's model leg. A vanished model is MARKED, never deleted — a delete
    // would throw away the member's sku and attributes a republish would have to
    // rebuild from nothing.
    const sincronia = await sincronizarLinksDeVariacao(
      db,
      alvo.integracaoId,
      link.produtoId,
      lista.model,
      deps.nowMs,
    );
    modelos = {
      total: lista.model.length,
      atualizados: sincronia.atualizados,
      ausentes: sincronia.marcados,
    };
  }

  /* ---- (4) the violation detail, best-effort. */
  let violacoes = violacoesAntes;
  let violacoesLidas = false;
  let descartadas = 0;
  try {
    const info = await client.getItemViolationInfo({ itemIds: [itemId] });
    chamadasShopee += 1;
    const leitura = linhaDeViolacao(info.item_list, itemId);
    if (leitura.kind === 'recusada') {
      console.warn('[shopee/anuncios] detalhe de violação não lido; violações mantidas', {
        integracaoId: alvo.integracaoId,
        produtoId: link.produtoId,
        itemId,
        codigo: leitura.codigo,
      });
    } else {
      // O9's ONE builder, called exactly as the push handler calls it: argument 1
      // becomes kind `status`, argument 2 kind `deboost`.
      const corpo = leitura.linha as unknown as Record<string, unknown>;
      const resultado = violacoesDeDetalhes(detalhesDeStatus(corpo), detalhesDeDeboost(corpo));
      violacoes = resultado.violacoes;
      descartadas = resultado.descartadas;
      violacoesLidas = true;
    }
  } catch (err) {
    // ⚠️ ONLY our class, and only its `other` kind. A rate limit, a network
    // failure or a schema mismatch is not a property of this listing (rule 6).
    if (!(err instanceof ShopeeApiError) || err.kind !== SHOPEE_ERROR_KIND.other) throw err;
    chamadasShopee += 1;
    console.warn('[shopee/anuncios] get_item_violation_info recusou; violações mantidas', {
      integracaoId: alvo.integracaoId,
      produtoId: link.produtoId,
      itemId,
      codigo: err.code,
    });
  }

  /* ---- (5) the fold and the field-by-field diff. */
  const bruto = itemStatusDe(item);
  const { estado, deboost } = estadoDoAnuncio(
    {
      kind: 'lido',
      itemStatus: bruto,
      deboost: item.base.deboost,
      agendadoParaMs: agendadoParaMsDe(item.base.scheduled_publish_time),
    },
    deps.nowMs,
  );
  const itemStatusParaGravar = itemStatusDeLink(item);
  const condicao = item.base.condition;

  const patch: Record<string, unknown> = {};
  if (textoOuNull(link.raw.item_status) !== itemStatusParaGravar) {
    patch.item_status = itemStatusParaGravar;
  }
  if (link.estadoAnuncio !== estado) patch.estadoAnuncio = estado;
  if (booleanoOuNull(link.raw.deboost) !== deboost) patch.deboost = deboost;
  if (textoOuNull(link.raw.condition) !== condicao) patch.condition = condicao;
  // ⚠️ `violacoesLidasEm` rides ONLY with a CHANGED list. Stamping it on every
  // healthy re-verify would make `ignorado-sem-mudanca` unreachable and turn a
  // read-only diagnostic into a write per button press — so the field means
  // "when the stored violation reading last MOVED". The `removido` arm below
  // stamps it unconditionally, where the design is explicit.
  if (violacoesLidas && (armazenadas === null || !mesmasViolacoes(armazenadas, violacoes))) {
    patch.violations = violacoes;
    patch.violacoesLidasEm = deps.nowMs;
  }

  const mudou = Object.keys(patch).length > 0;
  if (mudou) {
    patch.ultimaModificacao = deps.nowMs;
    await escreverLink(db, link, patch, itemId);
  }

  /* ---- (6) the aviso resolver. */
  const normalizado = bruto === SHOPEE_ITEM_STATUS.normal && !deboost && violacoes.length === 0;
  const avisoResolvido = normalizado
    ? await resolverAvisoDeAnuncio(
        db,
        { integracaoId: alvo.integracaoId, produtoId: link.produtoId },
        MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
        { nowMs: deps.nowMs },
      )
    : false;

  // ONE line per run. Ids, counts, enum tokens and booleans only — never a
  // violation reason, a suggestion or a `fail_message` (all three are in
  // `redact.ts`'s denylist).
  // eslint-disable-next-line no-console -- expected on every healthy run; a warn nobody can act on is what hides the real ones
  console.info('[shopee/anuncios] reverificação de anúncio', {
    integracaoId: alvo.integracaoId,
    produtoId: link.produtoId,
    itemId,
    acao: mudou ? ACAO_REVERIFICACAO.atualizado : ACAO_REVERIFICACAO.ignoradoSemMudanca,
    estadoAnuncio: estado,
    deboost,
    violacoes: violacoes.length,
    violacoesLidas,
    descartadas,
    modelos,
    avisoResolvido,
    chamadasShopee,
    campos: Object.keys(patch),
  });

  return {
    acao: mudou ? ACAO_REVERIFICACAO.atualizado : ACAO_REVERIFICACAO.ignoradoSemMudanca,
    produtoId: link.produtoId,
    linkDocId: link.linkDocId,
    itemId,
    estadoAnuncio: estado,
    itemStatus: bruto,
    deboost,
    violacoes,
    violacoesLidas,
    modelos,
    avisoResolvido,
    chamadasShopee,
  };
}

/**
 * The `ausente` arm: Shopee no longer has this listing.
 *
 * ⚠️ `item_status` is NOT in the patch. Nothing was read, and the legacy defect
 * was stamping a status invented from a 404. The aviso is resolved with
 * `anuncio-removido` rather than `anuncio-normalizado`: a deleted listing is not
 * "normalized", but its violation aviso is moot and nothing else would ever close
 * it — and an unresolved aviso stands until retention sweeps it, on a collection
 * with no dismiss button.
 */
async function arquivarRemovido(
  db: Firestore,
  alvo: AlvoDeReverificacao,
  link: LinkDeAnuncio,
  violacoes: readonly ShopeeViolacao[],
  chamadasShopee: number,
  deps: ReverificarAnuncioDeps,
): Promise<ResultadoReverificacao> {
  await escreverLink(
    db,
    link,
    {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      violacoesLidasEm: deps.nowMs,
      ultimaModificacao: deps.nowMs,
    },
    link.itemId,
  );
  const avisoResolvido = await resolverAvisoDeAnuncio(
    db,
    { integracaoId: alvo.integracaoId, produtoId: link.produtoId },
    MOTIVO_RESOLUCAO_ANUNCIO.removido,
    { nowMs: deps.nowMs },
  );

  // eslint-disable-next-line no-console -- the one line of this arm; an operator needs to know the listing is gone
  console.info('[shopee/anuncios] reverificação de anúncio', {
    integracaoId: alvo.integracaoId,
    produtoId: link.produtoId,
    itemId: link.itemId,
    acao: ACAO_REVERIFICACAO.removido,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    avisoResolvido,
    chamadasShopee,
  });

  return {
    acao: ACAO_REVERIFICACAO.removido,
    produtoId: link.produtoId,
    linkDocId: link.linkDocId,
    itemId: link.itemId,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    // ⚠️ `null`, because nothing was read. See the docblock.
    itemStatus: null,
    deboost: false,
    violacoes,
    violacoesLidas: false,
    modelos: null,
    avisoResolvido,
    chamadasShopee,
  };
}

/**
 * `mergeIfExists` with a FLAT patch, never `merge`: the link may have been
 * deleted between the resolve and here, and an admin `merge` is an UPSERT that
 * would resurrect it as a ghost carrying only the patch keys. A nested object
 * here is a runtime `TypeError`, which is what keeps `ultimaPublicacao` /
 * `falhaPublicacao` off this path (C15).
 */
async function escreverLink(
  db: Firestore,
  link: LinkDeAnuncio,
  patch: Record<string, unknown>,
  itemId: number | null,
): Promise<void> {
  const escrito = await produtoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: link.produtoId },
    link.linkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/anuncios] vínculo de listagem desapareceu antes da escrita', {
      produtoId: link.produtoId,
      linkDocId: link.linkDocId,
      itemId,
    });
  }
}
