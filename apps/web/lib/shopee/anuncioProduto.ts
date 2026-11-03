/**
 * Pure helpers for the produto editor's **Shopee** tab (step 21, #1529,
 * `apps/web/app/(app)/produtos/_components/shopee/`): how a stored listing link
 * is LABELLED, ADDRESSED on the storefront and ORDERED on screen.
 *
 * ⚠️ Display only — no rule a server surface decides with lives here (#1369).
 * Whether a listing is still alive is `anuncioShopeeVivo`, whether it was
 * superseded is `ehVinculoSubstituido`, when a stored refusal is still worth
 * showing is `shopeeLinkLeitura.ts` — all from `@delfrance/schemas`, the
 * modules `apps/shopee` decides with. A browser copy of any of them is the
 * drift shape root `CLAUDE.md` names: both read correct while disagreeing.
 *
 * Total over `unknown`: a soft-read hands the tab the RAW link document when it
 * does not parse (a migrated row, a half-written one), so nothing here assumes
 * a field is typed.
 *
 * The second half (PR 7) is the COPY of the tab's actions: what a refused
 * publish's machine-readable next step reads as ({@link TEXTO_ACAO_SUGERIDA},
 * {@link textoDoProblemaShopee}) and what a re-verify says it found
 * ({@link resumoDaReverificacaoShopee}). ⚠️ None of it is ever a command line:
 * the server's refusal sentences are written for the CLI (`--link`,
 * `--recriar`, `importar:anuncio`), and the operator here has buttons.
 *
 * The third part (PR 8) is the NATIVE KIT: the copy of a kit refusal's motivo
 * ({@link TEXTO_MOTIVO_KIT}) and of a kit run's avisos ({@link textoDoAvisoKit}),
 * which failures leave a kit create UNCERTAIN ({@link criacaoDeKitIncerta}), and
 * the per-tab store that keeps that uncertainty across a reload
 * ({@link lerIncerto} / {@link gravarIncerto}).
 *
 * The fourth part (#1911, P10) is the listing DRAFT's copy: the refusal motivos
 * of an ordinary listing's draft ({@link TEXTO_MOTIVO_ANUNCIO_SHOPEE}), the
 * draft block's notices and pendências, and what each answer of the three
 * draft routes reads as. The DECISIONS behind them (what is dirty, what a body
 * carries, which answer is which) live in `./rascunho.ts`; this half only words
 * them.
 *
 * The fifth part (#1911, P11) is the draft's PUBLICAR: the motivos of an
 * ordinary listing's first create ({@link MOTIVO_ANUNCIO_SHOPEE}, their rows in
 * {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE}), the confirmation, and what each answer
 * of a draft's publish reads as — the 202, the lock's 409s, an answer that
 * never came. Again `./rascunho.ts` decides; this words.
 */
import { z } from 'zod';
import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  ESTADO_ANUNCIO_SHOPEE,
  FUSO_FISCAL,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  anuncioShopeeVivo,
  descreverFaixaShopee,
  ehVinculoSubstituido,
  estadoAnuncioShopeeSchema,
  type AcaoSugeridaPublicacaoShopee,
  type CampoRascunhoShopee,
  type EstadoAnuncioShopee,
  type EstadoPublicacaoRascunhoShopee,
  type FaixaDto,
  type PendenciaRascunhoShopee,
  type TipoAcaoSugeridaPublicacaoShopee,
  type VinculoConflitanteShopee,
} from '@delfrance/schemas';

import {
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  ShopeeClientHttpError,
  type PublicarShopeeInput,
} from './client';
import type {
  ItemPublicadoShopee,
  ProblemaShopee,
  RespostaItemIncertoShopee,
  RespostaReverificarShopee,
} from './wire';

/**
 * The Brazilian storefront's product page. The legacy app built the same URL
 * (`.old/…/shopee/pages/produtoCadastro.dart:170-171`); no Shopee route
 * answers it, so it costs nothing to show.
 */
const PAGINA_DO_PRODUTO_SHOPEE = 'https://shopee.com.br/product';

/** A Shopee numeric id that can address something: a positive SAFE integer. */
function idEnderecavel(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/**
 * The listing's Shopee `item_id` as the tab prints it, or `null` for a link that
 * names no listing — a draft never published (`item_id: null`), or a stored
 * value that is not a positive safe integer.
 *
 * ⚠️ Also the tab's ADDRESSING gate: no button that sends a link id is offered
 * for a link this answers `null` for (`AcoesAnuncioShopee`, the kit arms'
 * `recriavel` / `convertivel`, and — through `AcoesShopee.enderecavel` — the
 * refusal rows' and kit avisos' buttons and the pause and kit confirmations).
 * The one deliberate exception is "Repetir", which re-sends a body that already
 * passed it (`IncertoDoKit`). It is STRICTER than the schemas'
 * `podeMoverAnuncioShopee` and `anuncioShopeeVivo`, which test `isFinite` — a
 * fraction (`1.5`) or an id past 2^53 passes them, and no such number can
 * address a Shopee listing. Those two stay as they are (they are apps/shopee's
 * batch filters) and decide, among ADDRESSABLE links, which ones may move, be
 * republished or be converted.
 */
export function itemIdDoAnuncioShopee(itemId: unknown): number | null {
  return idEnderecavel(itemId) ? itemId : null;
}

/**
 * The listing's public page — `https://shopee.com.br/product/<shop_id>/<item_id>`
 * — or `null` unless BOTH ids are positive safe integers. A draft link
 * (`item_id: null`) and a conta not yet connected (`shop_id: null`) get no link,
 * never a `/product/null/…` that opens Shopee's 404.
 */
export function urlDoAnuncioShopee(shopId: unknown, itemId: unknown): string | null {
  if (!idEnderecavel(shopId) || !idEnderecavel(itemId)) return null;
  return `${PAGINA_DO_PRODUTO_SHOPEE}/${String(shopId)}/${String(itemId)}`;
}

/** What the operator reads for each folded `estadoAnuncio`. Exhaustive by type. */
export const ROTULO_ESTADO_ANUNCIO_SHOPEE = {
  ativo: 'Ativo',
  pausado: 'Pausado',
  agendado: 'Agendado',
  banido: 'Banido',
  em_revisao: 'Em revisão',
  removido: 'Removido',
  desconhecido: 'Status desconhecido',
} as const satisfies Record<EstadoAnuncioShopee, string>;

/** The badge colour for each folded `estadoAnuncio`. Exhaustive by type. */
export const COR_ESTADO_ANUNCIO_SHOPEE = {
  ativo: 'green',
  pausado: 'yellow',
  agendado: 'blue',
  banido: 'red',
  em_revisao: 'orange',
  removido: 'gray',
  desconhecido: 'gray',
} as const satisfies Record<EstadoAnuncioShopee, string>;

/**
 * The stored `estadoAnuncio`, or `null` when there is none this build can name.
 *
 * `null` is a reading of its own — NEVER FOLDED (every link step 9 imported) —
 * and the tab says "não verificado" for it, never a dead state. A string outside
 * the vocabulary (a newer backend's member, a corrupted row) reads the same
 * way: it is not evidence the listing is gone.
 */
export function estadoAnuncioShopeeLido(estado: unknown): EstadoAnuncioShopee | null {
  const lido = estadoAnuncioShopeeSchema.safeParse(estado);
  return lido.success ? lido.data : null;
}

/**
 * Date and time of a stored MILLISECONDS stamp, in São Paulo — or `null` when the
 * value is not a finite number, or is one no `Date` can hold.
 *
 * ⚠️ An EXPLICIT zone: the same stamp reads the same on every operator's
 * machine — the rule `falhaDoEnvio.ts` follows for the quota pause's end.
 */
const FORMATO_INSTANTE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_FISCAL,
  dateStyle: 'short',
  timeStyle: 'short',
});
/**
 * The largest |ms| an ECMAScript time value may hold (±100,000,000 days from
 * the epoch, ECMA-262 § 21.4.1.1). Finite is NOT enough: past it
 * `Intl.DateTimeFormat#format` THROWS a `RangeError` — and this helper runs
 * while rendering the status, refusal, violation and model rows, so one such
 * stored stamp would take the whole tab down instead of reading as "no date".
 */
const MAIOR_INSTANTE_MS = 8.64e15;
export function formatarInstanteShopee(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (Math.abs(ms) > MAIOR_INSTANTE_MS) return null;
  return FORMATO_INSTANTE.format(ms);
}

/**
 * Which group a link sorts into: live, then superseded, then everything else.
 *
 *  - **0 — live**: `anuncioShopeeVivo` and not superseded. The listing the
 *    operator most likely came to look at.
 *  - **1 — superseded**: still `anuncioShopeeVivo`, but replaced by another link
 *    (a converted ordinary listing, a recriar's old kit whose delete did not
 *    take). It may still be SELLING, so it stays above the dead ones.
 *  - **2 — not live**: `removido`, and a link never published (`item_id: null`
 *    is not alive for `anuncioShopeeVivo` either).
 *
 * Both predicates are the schemas' own — the one the denorm trigger scans
 * survivors with and the one publish skips a superseded link by.
 */
function faixaDoVinculo(dados: Record<string, unknown>): 0 | 1 | 2 {
  if (!anuncioShopeeVivo(dados)) return 2;
  return ehVinculoSubstituido(dados) ? 1 : 0;
}

/** `publicadoEm` when it is a finite number; a link never published sorts last in its group. */
function publicadoEmDe(dados: Record<string, unknown>): number | null {
  const v = dados.publicadoEm;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The order the tab lists one conta's links in: {@link faixaDoVinculo}, then the
 * most recently FIRST-published first (`publicadoEm` desc, absent last), then
 * the doc id — so two renders of the same snapshot never swap two blocks.
 * Returns a new array.
 */
export function ordenarVinculosShopee<
  T extends { readonly id: string; readonly data: Record<string, unknown> },
>(vinculos: readonly T[]): T[] {
  return [...vinculos].sort((a, b) => {
    const faixa = faixaDoVinculo(a.data) - faixaDoVinculo(b.data);
    if (faixa !== 0) return faixa;
    const pa = publicadoEmDe(a.data);
    const pb = publicadoEmDe(b.data);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/*                      PR 7 — the copy of the tab's actions                   */
/* -------------------------------------------------------------------------- */

/**
 * What a link whose stored `item_id` is present but addresses no listing (`0`, a
 * negative, a fraction, past 2^53, a quoted number — a malformed or migrated
 * row) shows where its buttons would be — and so does a `kitNativo: true` link
 * with NO `item_id` (#1911 P10): a native kit's link always names its kit, so
 * that row is corrupt, not a draft. ⚠️ Neither gets the draft editor: the
 * schemas' `ehRascunhoShopee` decides what a draft is, and both are outside it.
 */
export const FRASE_ITEM_ID_INVALIDO_SHOPEE =
  'O código do anúncio guardado neste vínculo é inválido — nenhuma ação disponível.';

/**
 * The menu path to the mass import, as the app's navigation spells it
 * (`SidebarNav`: the «Canais de venda» group, its «Shopee» entry — the page
 * whose «Importar todos os anúncios» is the one door) — in EVERY copy of this
 * file, so the operator reads one path, never two (review R8-copy#16; the
 * brand picker's «Canais de venda › Shopee › {conta} › Marcas» is the same
 * path, one level deeper). Declared before its first reader: a `const` read
 * earlier in the module would throw on load.
 */
export const PORTA_DA_IMPORTACAO_SHOPEE = 'Canais de venda › Shopee';

/** The `importar` row's first half: what was found. */
const FRASE_KIT_JA_EXISTE_SHOPEE =
  'Já existe na Shopee um kit com o SKU deste produto — não crie outro.';

/** The `importar` row's second half: the one door for a hit NO link holds (see below). */
const FRASE_IMPORTACAO_EM_MASSA_SHOPEE =
  `A importação em massa (${PORTA_DA_IMPORTACAO_SHOPEE}) o vincula a este produto se ele ainda ` +
  'não estiver vinculado a nenhum produto, se nenhum outro produto tiver o mesmo SKU e se os ' +
  'componentes do kit já estiverem vinculados no ERP; um kit já vinculado a outro produto ' +
  'continua onde está.';

/**
 * What the operator READS for each machine-readable next step of a refused
 * publish (`problemas[].acao`, `@delfrance/schemas`' `shopeeAcaoSugerida.ts`).
 * Exhaustive by type: a `tipo` added to that vocabulary breaks the build here
 * until it has a sentence. {@link textoDoProblemaShopee} appends the ids the
 * `acao` carries.
 *
 * ⚠️ `importar` is worded as a CONDITION, never a promise. The mass import
 * (`apps/shopee/lib/shopee/produtos/importacaoMassa.ts`) imports only the
 * listings NO link names — a kit already bound to another produto is skipped —
 * and its parent cascade (`resolveProduto.ts`) binds a kit to the ONE root
 * produto whose `sku` equals the kit's: two such produtos decline that rung and
 * the import CREATES a new produto instead. A kit whose components the ERP
 * cannot resolve yet is refused (`kit-componente-nao-vinculado`) until a later
 * run. The web has no single-listing import (no `ShopeeClient` method calls
 * `…/importar`), so the mass import is the only door the sentence can name.
 */
export const TEXTO_ACAO_SUGERIDA = {
  [TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar]:
    'Este kit nativo precisa ser recriado na Shopee: o anúncio atual não pode mais ser publicado.',
  [TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar]:
    'Republique o anúncio que responde por este produto, sem as opções de kit.',
  [TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit]:
    'Republique sem as opções de kit nativo — elas não se aplicam a este anúncio agora.',
  [TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal]:
    'Informe qual componente é o principal do kit nativo.',
  [TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar]: `${FRASE_KIT_JA_EXISTE_SHOPEE} ${FRASE_IMPORTACAO_EM_MASSA_SHOPEE}`,
  [TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.escolherVinculo]:
    'Mais de um vínculo ativo responde por este produto nesta conta — escolha em qual agir: ' +
    'cada um tem o seu próprio bloco nesta aba.',
} as const satisfies Record<TipoAcaoSugeridaPublicacaoShopee, string>;

/**
 * A `republicar` that names no link: the refusal knew no successor. Never a
 * button — a publish naming no link can reach a FIRST create, which this step
 * does not offer.
 */
const FRASE_REPUBLICAR_SEM_VINCULO =
  'O vínculo não foi indicado: use "Republicar" no bloco do anúncio ativo desta conta.';

/**
 * The SUPERSEDED link a `vinculo-substituido` row is about, when it is NOT the
 * block the row is shown in — or `null` (the row is about the block itself, or
 * a server older than `substituidoLinkDocId` did not say).
 *
 * The dispatcher raises the refusal about the link that was sent; a kit
 * create's duplicate scan raises it about K's OLD kit, superseded but still
 * live, while the outcome is filed under the link that was SENT. Wording that
 * row as "este anúncio foi substituído" would call the live current kit
 * superseded. ONE predicate, so the copy ({@link textoDoProblemaShopee}) and
 * the row's button cannot disagree about which link the row names.
 */
export function vinculoSubstituidoAlheio(
  acao: AcaoSugeridaPublicacaoShopee | null,
  linkDoBloco: string | undefined,
): string | null {
  if (acao?.tipo !== TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar) return null;
  const sobre = acao.substituidoLinkDocId ?? null;
  return sobre === null || linkDoBloco === undefined || sobre === linkDoBloco ? null : sobre;
}

/** A `vinculo-substituido` row about ANOTHER link ({@link vinculoSubstituidoAlheio}). */
function textoDoSubstituidoAlheio(antigo: string, novo: string | null): string {
  return (
    `O kit nativo antigo do vínculo ${antigo}` +
    (novo === null ? ' foi substituído' : ` foi substituído pelo vínculo ${novo}`) +
    ', mas ainda está na Shopee com o mesmo SKU e bloqueia esta ação — exclua-o no Seller ' +
    'Centre, ou use "Recriar kit" nele para tentar excluí-lo de novo.'
  );
}

/**
 * A sentence written for a TERMINAL: a `--flag`, a `<verbo>:anuncio` script
 * name, or the word "comando".
 *
 * ⚠️ Nothing guarantees such a refusal also carries an `acao`. The server-side
 * pin that asks for one (`exigirAcaoSeHaComando`) runs in the KIT suites only,
 * and the ordinary listing's publish answers CLI-worded refusals with NO
 * `acao`: `instabilidade-shopee` (re-run "o mesmo comando"), and three from
 * #1911's uncertain first create — `criacao-incerta-sem-sku`
 * (`--confirmar-criacao-incerta`), the SKU-moved `criacao-incerta-ambigua` and
 * `busca-de-anuncio-incompleta` (both `importar:anuncio`). Each of those has
 * the tab's own row ({@link TEXTO_MOTIVO_KIT}, {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE},
 * {@link TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE}), read BEFORE this test; this
 * is the browser's backstop for any other — it hides the sentence behind
 * {@link FRASE_RECUSA_SEM_PASSO_SHOPEE}, which is generic and never the
 * right next step, so a new CLI-worded motivo owes a row.
 */
const FRASE_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio\b|\bcomandos?\b/i;

/** Whether `texto` is CLI copy the tab must not show (see {@link FRASE_DE_TERMINAL}). */
export function ehFraseDeTerminal(texto: string): boolean {
  return FRASE_DE_TERMINAL.test(texto);
}

/** What stands in for a refusal sentence written for the terminal — on a LIVE listing's row. */
export const FRASE_RECUSA_SEM_PASSO_SHOPEE =
  'Esta recusa não traz um próximo passo que a aba ofereça. Use "Reverificar" para ler o ' +
  'anúncio na Shopee antes de publicar de novo.';

/**
 * {@link FRASE_RECUSA_SEM_PASSO_SHOPEE} on a DRAFT's row: a draft block has no
 * «Reverificar» (review R8-copy#2), so it names no button.
 */
export const FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE =
  'Esta recusa não traz um próximo passo que a aba ofereça. Confira o estado do rascunho antes ' +
  'de publicar de novo.';

/**
 * The operator copy of ONE refusal row of a 422.
 *
 *  - A `motivo` the tab words itself ({@link TEXTO_MOTIVO_KIT}, then
 *    {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE} — disjoint keys, pinned) reads that copy
 *    first — with or without an `acao`; the `acao`'s ids still follow it. A row
 *    with NO `acao` reads {@link TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE} before
 *    either (one motivo, two refusals: `criacao-incerta-ambigua`).
 *  - WITH an `acao`: {@link TEXTO_ACAO_SUGERIDA} plus the ids the `acao` names.
 *    ⚠️ The server's `mensagem` is NEVER shown for such a row — it is the CLI's
 *    sentence, and the next step it describes is a button here.
 *  - Without one (the step-11 refusals, mechanism sentences): the `mensagem` —
 *    unless it reads as a terminal instruction, which becomes
 *    {@link FRASE_RECUSA_SEM_PASSO_SHOPEE}. A worded motivo whose sentence
 *    carries a fact the copy cannot (`busca-de-anuncio-existente-incompleta`:
 *    WHICH listings Shopee left out) shows it beside the copy, when it is not
 *    terminal text.
 *  - `importar` (#1911 P11): an ordinary-listing motivo of
 *    {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE} reads ITS copy and then every id with
 *    its state — «(sem vínculo)», «(deste produto)», «(do produto X)»
 *    ({@link idsDoImportarItem}); a kit motivo (or none) keeps the kit
 *    wording ({@link textoDoImportar}). Never the kit sentence on a listing,
 *    and never the mass-import door on a MIXED `criacao-incerta-ja-vinculada`
 *    row (its free id is ADOPTED by the row's exit, not imported).
 *
 * `motivo` is optional only so a caller holding a bare `{ mensagem, acao }`
 * still compiles; every 422 row carries one. `linkDoBloco` is the link the row
 * is SHOWN under: a `vinculo-substituido` row about another link is worded as
 * such ({@link vinculoSubstituidoAlheio}). `produtoDoBloco` is the block's
 * produto: an `importar` id linked to IT reads «(deste produto)» — without it,
 * every linked id names its produto.
 *
 * `rascunho` (#1911 P11 review) — the row is a DRAFT's Publicar's, and these
 * are the block's facts NOW ({@link ContextoDoRascunhoNoProblemaShopee});
 * absent or `null` ⇔ a LIVE listing's row. ⚠️ A draft row MUST pass it: it
 * picks the #11 exit by the CURRENT reading (§I2), names the SKU the SKU-moved
 * row asks to restore (R8-copy#5), says when an attested publish was refused
 * because the situation changed (§I1), and keeps «Reverificar» off a draft
 * (R8-copy#2). Without it each row reads its `livre`, SKU-unknown, unattested,
 * live-block wording.
 */
export function textoDoProblemaShopee(
  p: Pick<ProblemaShopee, 'mensagem' | 'acao'> & { readonly motivo?: string },
  linkDoBloco?: string,
  produtoDoBloco?: string,
  rascunho?: ContextoDoRascunhoNoProblemaShopee | null,
): string {
  const texto = textoDaLinhaShopee(p, linkDoBloco, produtoDoBloco, rascunho ?? null);
  const { motivo, acao } = p;
  // The acao-less `ja-vinculada` row exists ONLY as that refusal and says so itself.
  const seExplica = motivo === MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada && acao === null;
  return rascunho?.respondeAtestacao === true &&
    motivo !== undefined &&
    MOTIVOS_DA_BUSCA_DA_CRIACAO_INCERTA.has(motivo) &&
    !seExplica
    ? `${FRASE_ATESTACAO_SUPERADA_SHOPEE} ${texto}`
    : texto;
}

/**
 * What a refusal row of a DRAFT's Publicar is worded with beyond the row
 * itself (#1911 P11 review) — every field the editor's, read in the SAME
 * render as the block decision.
 */
export interface ContextoDoRascunhoNoProblemaShopee {
  /**
   * THE block's publish reading now (`bloco.publicacao`): the #11 row's exit
   * follows it (§I2 — `livre` check-first, `incerta` the last attempt's
   * listing first, never "crie").
   */
  readonly publicacao: EstadoPublicacaoRascunhoShopee;
  /**
   * The SKU the uncertain attempt SENT — `janelaDaCriacaoIncertaShopee(link)?.sku
   * ?? null` (`@delfrance/schemas`; never `criacaoIncertaSku` read raw): `''`
   * ⇔ it went out with none, `null` ⇔ unknown. The SKU-moved row names it
   * (R8-copy#5); unknown, it never asks to restore a value nobody can see.
   */
  readonly skuEnviado: string | null;
  /**
   * The refused request carried `confirmarCriacaoIncerta` — an attestation
   * exit's publish. A row of the uncertain-create look-up then answers it
   * ONLY because what the look-up sees now differs from what the operator
   * attested (§I1 — the server refuses with a fresh row, nothing sent), and
   * the row says so ({@link FRASE_ATESTACAO_SUPERADA_SHOPEE}).
   */
  readonly respondeAtestacao: boolean;
}

/**
 * The opening of a look-up row that answers an ATTESTED publish (§I1): the
 * server honours an attestation only when its fresh verdict is the one the
 * exit promised, so this row is the situation having changed — and the
 * look-up refuses before any write.
 */
export const FRASE_ATESTACAO_SUPERADA_SHOPEE =
  'A situação mudou desde a recusa que você conferiu — esta publicação não enviou nada à ' +
  'Shopee. Veja o que a busca encontrou agora:';

/** {@link textoDoProblemaShopee} without the attestation's opening. */
function textoDaLinhaShopee(
  p: Pick<ProblemaShopee, 'mensagem' | 'acao'> & { readonly motivo?: string },
  linkDoBloco: string | undefined,
  produtoDoBloco: string | undefined,
  rascunho: ContextoDoRascunhoNoProblemaShopee | null,
): string {
  const { acao, motivo } = p;
  if (acao === null) {
    const doMotivo = motivo === undefined ? null : textoDoMotivoSemAcaoShopee(motivo, rascunho);
    if (doMotivo === null) {
      if (!ehFraseDeTerminal(p.mensagem)) return p.mensagem;
      return rascunho === null
        ? FRASE_RECUSA_SEM_PASSO_SHOPEE
        : FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE;
    }
    return motivo !== undefined &&
      MOTIVOS_COM_A_FRASE_DO_SERVIDOR.has(motivo) &&
      !ehFraseDeTerminal(p.mensagem)
      ? `${doMotivo} ${comoDetalhe(p.mensagem)}`
      : doMotivo;
  }
  const doMotivo = motivo === undefined ? null : textoDoMotivoShopee(motivo);
  const base = doMotivo ?? TEXTO_ACAO_SUGERIDA[acao.tipo];
  switch (acao.tipo) {
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar:
      return `${base} Vínculo: ${acao.linkDocId}.`;
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar: {
      const antigo = vinculoSubstituidoAlheio(acao, linkDoBloco);
      if (antigo !== null) return textoDoSubstituidoAlheio(antigo, acao.linkDocId);
      return acao.linkDocId === null
        ? `${base} ${FRASE_REPUBLICAR_SEM_VINCULO}`
        : `${base} Vínculo: ${acao.linkDocId}.`;
    }
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar: {
      // `criacao-incerta-ja-vinculada` whose candidates are ALL unlinked is the
      // §I1 refusal of an attestation that expected a create while a free
      // listing turned up: never «já vinculado» about it.
      const doAnuncio =
        motivo === M.criacaoIncertaJaVinculada &&
        acao.vinculados != null &&
        acao.itemIds.length > 0 &&
        acao.vinculados.length === 0
          ? FRASE_JA_VINCULADA_SO_SEM_VINCULO_SHOPEE
          : motivo === undefined
            ? null
            : textoProprio(TEXTO_MOTIVO_ANUNCIO_SHOPEE, motivo);
      if (doAnuncio === null) return textoDoImportar(acao.itemIds, acao.vinculados);
      // ⚠️ A MIXED `criacao-incerta-ja-vinculada` row (a LINKED candidate
      // beside the free one) never points the free one at the mass import
      // (review round 2): the shared SKU is what made the other link, so the
      // import's SKU rung declines it and MINTS a new produto holding the
      // listing — and the draft's adoption exit then creates. Adopting is that
      // row's path (`./rascunho.ts`'s exit), so only the ids are named.
      const mista =
        motivo === M.criacaoIncertaJaVinculada &&
        acao.vinculados != null &&
        acao.vinculados.some((v) => acao.itemIds.includes(v.itemId));
      const ids = idsDoImportarItem(acao.itemIds, acao.vinculados, produtoDoBloco, doAnuncio, {
        apontaImportacao: !mista,
      });
      return ids === '' ? doAnuncio : `${doAnuncio} ${ids}`;
    }
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.escolherVinculo:
      return `${base} Vínculos: ${acao.linkDocIds.join(', ')}.`;
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit:
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal:
      return base;
  }
}

/**
 * The `importar` row. A hit a link ALREADY holds is skipped by the mass import
 * (it imports only the listings no link names), so pointing it there sends the
 * operator to a whole-conta job that changes nothing: such a hit names its
 * produto instead, and when every hit is held the mass-import sentence goes.
 * `vinculados` absent or `null` (a server older than the field) words every id
 * alike, as before.
 */
function textoDoImportar(
  itemIds: readonly number[],
  vinculados: readonly { readonly itemId: number; readonly produtoId: string }[] | null | undefined,
): string {
  const ids = (lista: readonly number[]) => lista.map(String).join(', ');
  if (vinculados == null) {
    return `${TEXTO_ACAO_SUGERIDA[TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar]} Anúncio(s) na Shopee: ${ids(itemIds)}.`;
  }
  const donoDe = new Map(vinculados.map((v) => [v.itemId, v.produtoId]));
  const livres = itemIds.filter((id) => !donoDe.has(id));
  const partes = [FRASE_KIT_JA_EXISTE_SHOPEE];
  if (livres.length > 0) {
    partes.push(
      FRASE_IMPORTACAO_EM_MASSA_SHOPEE,
      `Anúncio(s) na Shopee sem vínculo: ${ids(livres)}.`,
    );
  }
  for (const id of itemIds) {
    const produtoId = donoDe.get(id);
    if (produtoId === undefined) continue;
    partes.push(
      `O anúncio ${String(id)} já está vinculado ao produto ${produtoId} — a importação não o ` +
        'muda; confira o SKU desse produto.',
    );
  }
  return partes.join(' ');
}

/** An unlinked listing's one door into the ERP (the web has no single-listing import). */
const FRASE_IMPORTAR_ANUNCIO_SEM_VINCULO_SHOPEE = `Um anúncio sem vínculo entra no ERP pela importação em massa (${PORTA_DA_IMPORTACAO_SHOPEE}).`;

/**
 * The ids of an ORDINARY listing's `importar` row (#1911 P11, §C rule 3),
 * after its own copy (`copia`): every id with its state — «(sem vínculo)» when
 * no link holds it, «(deste produto)» when the block's produto does,
 * «(do produto X)» otherwise (also when the block's produto is not known). A
 * row with a free id and a copy that does not already name the mass import
 * gets {@link FRASE_IMPORTAR_ANUNCIO_SEM_VINCULO_SHOPEE} — unless the caller
 * says the import is not that free id's door (`apontaImportacao: false`, the
 * mixed `criacao-incerta-ja-vinculada` row); a linked id never does (the
 * import skips linked listings). `vinculados` absent or `null` (an older
 * server) names the ids alone.
 */
function idsDoImportarItem(
  itemIds: readonly number[],
  vinculados: readonly { readonly itemId: number; readonly produtoId: string }[] | null | undefined,
  produtoDoBloco: string | undefined,
  copia: string,
  opcoes: { readonly apontaImportacao: boolean },
): string {
  if (itemIds.length === 0) return '';
  if (vinculados == null) return `Anúncio(s) na Shopee: ${itemIds.map(String).join(', ')}.`;
  const donoDe = new Map(vinculados.map((v) => [v.itemId, v.produtoId]));
  let livre = false;
  const nomeados = itemIds.map((id) => {
    const dono = donoDe.get(id);
    if (dono === undefined) {
      livre = true;
      return `${String(id)} (sem vínculo)`;
    }
    return dono === produtoDoBloco
      ? `${String(id)} (deste produto)`
      : `${String(id)} (do produto ${dono})`;
  });
  const partes = [`Anúncio(s) na Shopee: ${nomeados.join(', ')}.`];
  if (livre && opcoes.apontaImportacao && !copia.includes(PORTA_DA_IMPORTACAO_SHOPEE)) {
    partes.push(FRASE_IMPORTAR_ANUNCIO_SEM_VINCULO_SHOPEE);
  }
  return partes.join(' ');
}

/** A server sentence shown BESIDE the tab's copy: labelled, and closed by a full stop. */
function comoDetalhe(mensagem: string): string {
  const texto = mensagem.trim();
  return `Detalhe: ${texto}${/[.!?…]$/.test(texto) ? '' : '.'}`;
}

/**
 * Where in the publish sequence a mid-publish refusal LANDED, in the operator's
 * words — `detalhes.etapa` of a 422 `SHOPEE_PUBLISH_REJECTED`, which is
 * apps/shopee's closed `EtapaPublicacao` (`errosPublicacao.ts`).
 *
 * ⚠️ A PLACE, never a channel STATE: what exists on Shopee after a refusal
 * depends on the ARM as well (a recriar creates the new kit before it deletes
 * the old one, so a refused `add_kit_item` leaves the old kit live), and only
 * the server knows the arm. So the label claims nothing beyond what the step
 * alone settles.
 */
const ROTULO_ETAPA_PUBLICACAO_SHOPEE: Readonly<Record<string, string>> = {
  fotos: 'envio das fotos',
  add_item: 'criação do anúncio — a Shopee não criou o anúncio',
  update_item: 'atualização do anúncio',
  init_tier_variation: 'criação das variações',
  update_tier_variation: 'atualização das variações',
  add_model: 'criação dos modelos',
  update_model: 'atualização dos modelos',
  get_model_list: 'leitura dos modelos',
  relistagem: 'reativação do anúncio',
  'leitura-de-volta': 'conferência do anúncio depois da publicação',
  add_kit_item: 'criação do kit — a Shopee não criou o kit',
  update_kit_item: 'atualização do kit',
  delete_item: 'exclusão do kit antigo',
};

/** An etapa this build does not know — the raw code is never printed. */
const ROTULO_ETAPA_DESCONHECIDA_SHOPEE = 'uma etapa que esta tela ainda não descreve';

/**
 * The two etapas whose refusal leaves a DRAFT a draft: the photos go up and
 * `add_item` is sent before any write-back names a listing, so a 422 at
 * either is a definite "not created" (an UNCERTAIN `add_item` is the 202,
 * never a 422).
 */
const ETAPAS_QUE_DEIXAM_O_RASCUNHO: ReadonlySet<string> = new Set(['fotos', 'add_item']);

/**
 * The sentence a mid-publish refusal opens with: where it landed
 * ({@link ROTULO_ETAPA_PUBLICACAO_SHOPEE}, an own-property lookup with a neutral
 * fallback), and what to do before repeating.
 *
 * - A LIVE listing (`ehRascunho: false`): the caution the CLI gives for the
 *   same case — earlier writes may have landed, so the listing is read back
 *   («Reverificar», which its block offers) before anything is repeated.
 * - A DRAFT (`ehRascunho: true`, the block renders `RascunhoShopee`, which has
 *   NO «Reverificar» — review R8-copy#2): at `fotos` / `add_item` this attempt
 *   created no listing, so the fix and «Publicar» again; at any later etapa
 *   (reachable only while the snapshot still shows the draft a create just
 *   turned live) the caution without a button — once the listing's
 *   `item_id` arrives the block is a live one and reads the first case.
 *
 * ⚠️ Never «nada foi criado na Shopee» bare: an `incerta` draft's EARLIER
 * attempt may have created the listing; only THIS attempt is spoken for.
 */
export function textoDaEtapaShopee(
  etapa: string,
  contexto: { readonly ehRascunho: boolean },
): string {
  const rotulo =
    (Object.hasOwn(ROTULO_ETAPA_PUBLICACAO_SHOPEE, etapa)
      ? ROTULO_ETAPA_PUBLICACAO_SHOPEE[etapa]
      : undefined) ?? ROTULO_ETAPA_DESCONHECIDA_SHOPEE;
  const abertura = `Recusada na etapa: ${rotulo}.`;
  if (!contexto.ehRascunho) {
    return (
      `${abertura} Escritas anteriores podem já ter chegado à Shopee — use "Reverificar" antes ` +
      'de repetir.'
    );
  }
  if (ETAPAS_QUE_DEIXAM_O_RASCUNHO.has(etapa)) {
    return (
      `${abertura} Esta tentativa não criou o anúncio — corrija o que a recusa indica e use ` +
      '"Publicar" de novo.'
    );
  }
  return (
    `${abertura} Escritas anteriores podem já ter chegado à Shopee — confira o estado deste ` +
    'bloco antes de repetir.'
  );
}

/** The toast a re-verify answers with: what the ERP did with Shopee's reading. */
export interface ResumoDaReverificacaoShopee {
  readonly cor: string;
  readonly titulo: string;
  readonly mensagem: string;
}

/**
 * The re-verify's toast, keyed on the route's `acao` — a FREE string on the
 * wire, so a value this build does not know gets the neutral sentence, never a
 * crash. The title names the state the ERP now holds.
 */
export function resumoDaReverificacaoShopee(
  r: RespostaReverificarShopee,
): ResumoDaReverificacaoShopee {
  const titulo = `Anúncio reverificado — ${ROTULO_ESTADO_ANUNCIO_SHOPEE[r.estadoAnuncio]}`;
  let cor: string;
  let frase: string;
  switch (r.acao) {
    case 'atualizado':
      cor = 'green';
      frase = 'O ERP atualizou o anúncio com o que a Shopee informa agora.';
      break;
    case 'ignorado-sem-mudanca':
      cor = 'blue';
      frase = 'Nada mudou desde a última leitura.';
      break;
    case 'removido':
      cor = 'orange';
      frase = 'A Shopee não tem mais este anúncio — o vínculo foi marcado como removido.';
      break;
    default:
      cor = 'blue';
      frase = 'A Shopee respondeu à reverificação.';
  }
  const extras = [
    r.deboost ? 'Ele está rebaixado na busca.' : null,
    r.violacoesLidas
      ? null
      : 'As violações não puderam ser lidas agora — as mostradas são as guardadas.',
    r.modelos !== null && r.modelos.ausentes > 0
      ? `${String(r.modelos.ausentes)} variação(ões) não estão mais na Shopee.`
      : null,
    r.avisoReceitaKit === 'resolvido'
      ? 'O aviso de composição do kit foi resolvido.'
      : r.avisoReceitaKit === 'aberto'
        ? 'O aviso de composição do kit continua aberto.'
        : null,
  ].filter((t): t is string => t !== null);
  return { cor, titulo, mensagem: [frase, ...extras].join(' ') };
}

/* -------------------------------------------------------------------------- */
/*                         PR 8 — the native kit                               */
/* -------------------------------------------------------------------------- */

/** `mapa[chave]` only when `chave` is the map's OWN key — `'constructor'` never reaches the prototype. */
function textoProprio(mapa: Readonly<Record<string, string>>, chave: string): string | null {
  return Object.hasOwn(mapa, chave) ? (mapa[chave] ?? null) : null;
}

/** The wait before a kit create the server could not confirm is repeated, in whole minutes. */
const MINUTOS_DE_ESPERA_DO_KIT = Math.ceil(AGUARDAR_KIT_INCERTO_SHOPEE_MS / 60_000);

/**
 * The tab's OWN copy for the refusal motivos of the native-kit arms and of the
 * publish dispatcher — read FIRST by {@link textoDoProblemaShopee}, before the
 * generic {@link TEXTO_ACAO_SUGERIDA}, because one `acao` serves several
 * motivos that ask for different things (`informar-principal` is both "this
 * principal is not usable" and "this kit needs one").
 *
 * Keyed by the 422 row's `motivo`, a FREE string on the wire: the vocabulary is
 * apps/shopee's (`anuncios/errosPublicacao.ts`), which the browser cannot import,
 * and it is deliberately not a schemas enum in this step (reconcile fact 5). A
 * motivo this map lacks falls back to the `acao` copy, then to the sentence.
 *
 * ⚠️ Only motivos the kit arms or the dispatcher produce. A motivo the ordinary
 * listing's publish shares (`listagem-removida`, `preco-fora-da-faixa`) keeps
 * the server's mechanism sentence there, so it is not in this map. The
 * dispatcher's two DRAFT motivos (#1911) are about an ordinary listing's draft,
 * so they live in {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE} instead — the keys of the
 * two maps never overlap (pinned), so which one answers never depends on order.
 *
 * ⚠️ `instabilidade-shopee` is the one row here with NO `acao`: its server
 * sentence tells the CLI to re-run "o mesmo comando" (reconcile fact 14), and
 * the operator here re-reads the listing instead. Its minutes are the schemas'
 * `AGUARDAR_KIT_INCERTO_SHOPEE_MS` — the one copy both server sentences read.
 */
export const TEXTO_MOTIVO_KIT: Readonly<Record<string, string>> = {
  'instabilidade-shopee':
    'A Shopee respondeu com instabilidade, e a operação pode ter sido feita mesmo assim. ' +
    `Aguarde ${String(MINUTOS_DE_ESPERA_DO_KIT)} minutos e use "Reverificar" antes de publicar ` +
    'de novo.',
  'vinculo-substituido':
    'Este anúncio foi substituído por outro vínculo e o ERP não publica mais nele — republique ' +
    'o vínculo que o substituiu. Se ele ainda estiver vendendo na Shopee, exclua-o no Seller ' +
    'Centre.',
  'ja-e-kit-nativo':
    'Este produto já é kit nativo nesta conta e não tem anúncio comum para converter — ' +
    'republique o kit.',
  'opcao-de-kit-em-anuncio-comum':
    'Recriar, converter e o componente principal só valem para um kit nativo — republique este ' +
    'anúncio sem essas opções.',
  'recriacao-sem-diferenca':
    'Recriar não mudaria nada: o kit na Shopee já tem a composição e o componente principal do ' +
    'ERP. Para trocar o principal, recrie escolhendo outro.',
  'principal-invalido':
    'O componente escolhido como principal não serve para este kit: ele não faz parte da ' +
    'composição ou não tem anúncio utilizável nesta conta da Shopee — escolha outro.',
  'principal-obrigatorio':
    'Os componentes deste kit estão em mais de um anúncio da Shopee — escolha o componente ' +
    'principal: a Shopee copia dele a categoria, os atributos e a marca, e não deixa trocá-lo ' +
    'depois.',
};

/**
 * What the operator reads for each warning a native-kit run lists in its 200
 * (`avisos[].codigo`) — the twelve codes of apps/shopee's
 * `kits/resultadoKit.ts` `CodigoAvisoKit`. The 200 carries `{ codigo,
 * produtoId }` only, never the server's sentence (which is CLI text), so each
 * entry says the mechanism and the next step in the tab's own terms.
 *
 * ⚠️ A FREE string on the wire: a code a newer backend adds reads
 * {@link textoDoAvisoKit}'s neutral fallback, never `undefined` (reconcile §9
 * K6; moving the vocabulary to schemas rides the DTO follow-up, #1913).
 */
export const TEXTO_AVISO_KIT: Readonly<Record<string, string>> = {
  'receita-divergente':
    'A composição de uma variação mudou no ERP, mas a Shopee não deixa alterar a de um kit: ele ' +
    'continua com a receita antiga. Para levar a nova, use "Recriar kit".',
  'receita-nao-publicavel':
    'A composição de uma variação no ERP não pode ir para a Shopee — o kit continua com a ' +
    'receita atual. Corrija o componente ou a composição no ERP.',
  'principal-diferente':
    'O componente principal escolhido não é o do kit na Shopee, que não deixa trocá-lo: o atual ' +
    'foi mantido. Para trocar o principal, use "Recriar kit" escolhendo o novo.',
  'componente-nao-limita-estoque':
    'Um componente está com «Limita estoque» desligado: a Shopee conta todos os componentes, ' +
    'então pode mostrar MENOS kits do que o ERP (nunca mais).',
  'receita-espelho-divergente':
    'A composição do kit difere da composição da sua variação única; foi usada a da variação.',
  'modelo-sem-filho':
    'Um modelo do kit na Shopee não corresponde a nenhuma variação do ERP — nenhum vínculo foi ' +
    'gravado para ele.',
  'variacao-nao-anexada':
    'Uma variação do ERP não foi anexada ao kit na Shopee. Confira a composição dela e publique ' +
    'de novo.',
  'kit-antigo-nao-excluido':
    'O kit novo foi criado, mas o antigo não foi excluído na Shopee: enquanto existir, ele ' +
    'continua vendendo com a composição antiga. Exclua-o no Seller Centre e use "Reverificar" ' +
    'no vínculo dele — ou "Recriar kit" nele, para tentar a exclusão de novo.',
  'kit-novo-inativo':
    'O kit novo ainda não está ativo na Shopee, e o antigo só é excluído quando ele estiver. ' +
    'Quando o novo estiver ativo — reative-o se estiver pausado; banido, corrija a violação no ' +
    'Seller Centre e aguarde a revisão —, use "Recriar kit" de novo no vínculo antigo.',
  'kit-novo-divergente':
    'O kit novo não está igual à composição do ERP, e o antigo não foi excluído. Se faltar uma ' +
    'variação, republique o kit novo; se a composição mudou depois, exclua um dos dois no Seller ' +
    'Centre e use "Reverificar".',
  'kit-alvo-mais-novo':
    'O kit que seria substituído não é mais antigo que o kit novo, então nada foi excluído. ' +
    'Confira qual dos dois é o antigo e use "Recriar kit" nele.',
  'sku-do-kit-nao-enviado':
    'O SKU do kit no ERP está vazio ou tem espaços nas pontas; a publicação manteve o SKU que ' +
    'está na Shopee. Corrija o SKU no ERP.',
};

/** The copy of ONE kit aviso code — {@link TEXTO_AVISO_KIT}'s own entry, or a neutral line naming the code. */
export function textoDoAvisoKit(codigo: string): string {
  return textoProprio(TEXTO_AVISO_KIT, codigo) ?? `Aviso da Shopee (${codigo}).`;
}

/**
 * How long the tab waits before it offers to repeat an UNCERTAIN kit create:
 * the 202's own `aguardarMs`, or — when the body carried none (an older
 * backend, a network error that never produced a body) — the schemas'
 * `AGUARDAR_KIT_INCERTO_SHOPEE_MS`, never a copy of that number.
 */
export function esperaDoKitIncerto(aguardarMs: number | undefined): number {
  return aguardarMs ?? AGUARDAR_KIT_INCERTO_SHOPEE_MS;
}

/**
 * Whether a FAILED native-kit create (recriar / converter) may still have
 * created the kit on Shopee — so the tab must call it UNCERTAIN, never
 * "falhou", and wait before the identical re-send. `add_kit_item` is not
 * idempotent: an operator told "falhou" re-clicks, and the second click is a
 * second kit.
 *
 *  - a {@link ShopeeClientNetworkError} — the request may have arrived and the
 *    answer was lost (an abort is one too: its `cause` is the `DOMException`);
 *  - a {@link ShopeeClientRespostaInvalidaError} — the backend ANSWERED 2xx with
 *    a body this build cannot read: whatever it did, it did;
 *  - a 5xx — the route failed or was cut (App Hosting's 180 s ceiling answers
 *    504) after a write it may already have made; except 501, a deployment fact,
 *    and a rate-limited 502 ({@link limiteNaCriacaoDeKit}).
 *
 * Everything else — a 4xx, a 422's `problemas` — is a definite answer.
 */
export function criacaoDeKitIncerta(
  err: ShopeeClientHttpError | ShopeeClientNetworkError,
): boolean {
  if (err instanceof ShopeeClientNetworkError) return true;
  if (err instanceof ShopeeClientRespostaInvalidaError) return true;
  if (err.status === 502) return !limiteNaCriacaoDeKit(err);
  return err.status >= 500 && err.status !== 501;
}

/**
 * A 502 whose `kind` is a Shopee rate limit (`burst` / `daily`, the client's
 * own `kind` contract) — DEFINITE for a kit create, though not because nothing
 * ran: the 502 does not say WHICH call was limited, and one after a successful
 * `add_kit_item` (the read-back, a recriar's re-read) reaches the tab the same
 * way. It is definite because no wait is needed either way: the create writes
 * the new kit's link BEFORE any call that can hit the limit
 * (`aplicarKit.ts`'s `garantirKitNovo`), so the identical re-send reaches
 * `completar`, never a second `add_kit_item`. The kit may already exist, which
 * {@link FRASE_LIMITE_NA_CRIACAO_DE_KIT} says.
 */
export function limiteNaCriacaoDeKit(
  err: ShopeeClientHttpError | ShopeeClientNetworkError,
): boolean {
  return (
    err instanceof ShopeeClientHttpError &&
    !(err instanceof ShopeeClientRespostaInvalidaError) &&
    err.status === 502 &&
    (err.kind === 'burst' || err.kind === 'daily')
  );
}

/** What a rate-limited kit create reads — the kit may already exist ({@link limiteNaCriacaoDeKit}). */
export const FRASE_LIMITE_NA_CRIACAO_DE_KIT =
  'A Shopee limitou as consultas. O kit novo pode já ter sido criado — confira os anúncios desta ' +
  'conta; repetir a mesma ação em alguns minutos conclui sem criar outro kit.';

/**
 * A kit create the server could not confirm, kept for the identical re-send:
 * `ate` — the ms instant from which "Repetir" is offered — and `corpo`, the
 * EXACT input that was sent (a plain publish after a recriar or a converter
 * would reach a DIFFERENT arm, so only this body is a re-send).
 */
export interface IncertoKitShopee {
  readonly ate: number;
  readonly corpo: PublicarShopeeInput;
}

/**
 * {@link IncertoKitShopee} as stored — parsed on every read: a stored value is
 * never trusted as typed. It states THIS tab's re-send precondition (what
 * `enviarKit` would send as a kit create): a value with no link, or not exactly
 * one arm flag, reads as nothing. Nothing here restates the route's rules —
 * anything else the route refuses comes back as its own 400, a definite answer
 * that clears the store.
 */
const incertoKitShopeeSchema = z.object({
  ate: z.number().finite(),
  corpo: z
    .object({
      integracaoId: z.string().min(1),
      produtoId: z.string().min(1),
      linkDocId: z.string().min(1),
      status: z.enum(['NORMAL', 'UNLIST']).optional(),
      categoryId: z.number().int().positive().optional(),
      principal: z.string().min(1).optional(),
      recriar: z.literal(true).optional(),
      converterEmKit: z.literal(true).optional(),
    })
    // Exactly ONE arm: `enviarKit` sends nothing for a body with neither.
    .refine((c) => (c.recriar === true) !== (c.converterEmKit === true)),
});

/** The `sessionStorage` key of one produto's uncertain kit create on one conta. */
export function chaveIncerto(integracaoId: string, produtoId: string): string {
  return `delfrance:shopee:kit-incerto:${integracaoId}:${produtoId}`;
}

/**
 * This tab's `sessionStorage`, or `null` where there is none to use: no window
 * (a server render), or a store the browser blocks — reading the property
 * itself throws a `SecurityError` there.
 */
function armazenamentoDaAba(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch (err) {
    if (err instanceof DOMException) return null;
    throw err;
  }
}

/**
 * The stored uncertain create of `produtoId` on `integracaoId`, or `null` —
 * nothing stored, a blocked store, a value that is not JSON or not the shape,
 * or one stored under this key for ANOTHER conta or produto. Survives a reload
 * of the same browser tab (`sessionStorage`), never reaches another tab.
 */
export function lerIncerto(integracaoId: string, produtoId: string): IncertoKitShopee | null {
  const armazenamento = armazenamentoDaAba();
  if (armazenamento === null) return null;
  let bruto: string | null;
  try {
    bruto = armazenamento.getItem(chaveIncerto(integracaoId, produtoId));
  } catch (err) {
    if (err instanceof DOMException) return null;
    throw err;
  }
  if (bruto === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(bruto);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  const lido = incertoKitShopeeSchema.safeParse(json);
  if (!lido.success) return null;
  const { corpo } = lido.data;
  if (corpo.integracaoId !== integracaoId || corpo.produtoId !== produtoId) return null;
  return lido.data;
}

/**
 * Store (or, with `null`, forget) the uncertain create of `produtoId` on
 * `integracaoId`. `false` when the store could not take it — blocked, or full
 * (`QuotaExceededError`): the caller's in-memory wait still holds for this
 * page, only a reload loses it.
 */
export function gravarIncerto(
  integracaoId: string,
  produtoId: string,
  incerto: IncertoKitShopee | null,
): boolean {
  const armazenamento = armazenamentoDaAba();
  if (armazenamento === null) return false;
  const chave = chaveIncerto(integracaoId, produtoId);
  try {
    if (incerto === null) armazenamento.removeItem(chave);
    else armazenamento.setItem(chave, JSON.stringify(incerto));
    return true;
  } catch (err) {
    if (err instanceof DOMException) return false;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*            #1911 P10 — the listing DRAFT (edited here, no Publicar)         */
/* -------------------------------------------------------------------------- */

/**
 * The notice of a draft whose produto is a VIRTUAL kit — and the copy of the
 * dispatcher's `rascunho-em-kit-virtual` refusal (one constant for both, §C
 * #1): on Shopee a virtual kit is published as a NATIVE kit, never as the
 * ordinary listing a draft becomes, so such a draft can only be discarded.
 *
 * ⚠️ It never tells the operator to publish the kit: this tab has no first
 * native-kit publish (its kit arms need a listed link, «Novo anúncio» is hidden
 * for a virtual kit, and every publish it sends names a link) — that first
 * publish is the terminal's. The server's own sentence ("descarte o rascunho e
 * publique o kit") is right for the CLI only. Amends §C row 1 (review
 * R8-copy#11; `design-DC-web.md`'s original wording).
 */
export const FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE =
  'Este produto é kit virtual: na Shopee ele é publicado como kit nativo, e um rascunho de ' +
  'anúncio comum não se aplica — descarte este rascunho. A primeira publicação de um kit ' +
  'nativo não é feita por esta tela (é feita pelo terminal).';

/**
 * The draft's "brand still to choose" — the pendência AND the copy of the
 * publish's `marca-nao-escolhida` refusal (one constant for both, §C #3).
 * "Sem marca" is a choice; nothing chosen is not.
 */
export const FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE =
  'Escolha a marca deste rascunho (ou «Sem marca») antes de publicar.';

/**
 * The ordinary listing's refusal motivos the tab words or BRANCHES on (#1911)
 * — apps/shopee's vocabulary (`anuncios/errosPublicacao.ts`'s
 * `MOTIVO_PUBLICACAO_BLOQUEADA` and the wire-only `anuncio-semelhante-existente`),
 * which the browser cannot import, so spelled ONCE, here. Every reader — the
 * copy maps below, the Seller-Centre attestation exits and the SKU routing
 * allow-list (`./rascunho.ts`) — keys on these.
 *
 * ⚠️ A server rename fails closed only for BUTTONS and ROUTES (K2-14): the
 * row loses its exit and its field route. The COPY does not fail safe — the
 * four `importar` rows fall back to `textoDoImportar`, which opens with the KIT
 * sentence, and a renamed `marca-nao-escolhida` ADDS the «a marca pode não
 * valer» aviso (`superficieDoCampoShopee` is a deny-list). So a rename is
 * caught by apps/shopee's cross-app pin (`anuncios/errosPublicacao.test.ts`
 * reads this block as text — keep its header line byte-identical). Never a
 * prefix match.
 */
export const MOTIVO_ANUNCIO_SHOPEE = {
  rascunhoEmKitVirtual: 'rascunho-em-kit-virtual',
  rascunhoNaoNomeado: 'rascunho-nao-nomeado',
  marcaNaoEscolhida: 'marca-nao-escolhida',
  criacaoIncertaAmbigua: 'criacao-incerta-ambigua',
  buscaDeAnuncioIncompleta: 'busca-de-anuncio-incompleta',
  criacaoIncertaSemSku: 'criacao-incerta-sem-sku',
  criacaoIncertaJaVinculada: 'criacao-incerta-ja-vinculada',
  anuncioExistenteSemVinculo: 'anuncio-existente-sem-vinculo',
  anuncioExistenteDeOutroProduto: 'anuncio-existente-de-outro-produto',
  buscaDeAnuncioExistenteIncompleta: 'busca-de-anuncio-existente-incompleta',
  anuncioSemelhanteExistente: 'anuncio-semelhante-existente',
} as const satisfies Record<string, string>;
export type MotivoAnuncioShopee =
  (typeof MOTIVO_ANUNCIO_SHOPEE)[keyof typeof MOTIVO_ANUNCIO_SHOPEE];

const M = MOTIVO_ANUNCIO_SHOPEE;

/**
 * The motivos of the uncertain create's look-up (ENSURE) — every one a refusal
 * BEFORE any Shopee write. A row of one answering an ATTESTED publish means
 * the situation moved since the refusal the operator checked (§I1,
 * {@link FRASE_ATESTACAO_SUPERADA_SHOPEE}).
 */
const MOTIVOS_DA_BUSCA_DA_CRIACAO_INCERTA: ReadonlySet<string> = new Set([
  M.criacaoIncertaAmbigua,
  M.buscaDeAnuncioIncompleta,
  M.criacaoIncertaSemSku,
  M.criacaoIncertaJaVinculada,
]);

/**
 * The exit when the ERP could not check the conta's listings (§H Q2 — Lucas:
 * the largest conta holds 2 000–10 000 listings), CHECK FIRST (§I2, Lucas
 * 2026-10-29), chosen at render from the block's CURRENT reading (review
 * R8-copy#0) — never "create it in Seller Centre" in the one state where the
 * ERP has just said it could not look:
 *
 * - `livre` — no attempt is on record: look for the SKU first; import what
 *   exists, create only what does not.
 * - `incerta` — the LAST attempt may have created the listing: that listing
 *   first, never another. «A importação adota este rascunho» only while the
 *   draft records a readable attempt window (`desdeMs` — the import adopts a
 *   draft only through it, review R7-roundtrip#5); without one, the import
 *   binds the listing and the draft is discarded after it.
 * - `em-andamento` — a publish of this draft holds the lock (another tab, or
 *   this answer's own lock not yet gone from the snapshot): wait, then the
 *   reading this re-renders with says which exit.
 *
 * `afirmaNadaCriado` — open the `incerta` exit with «Esta tentativa não criou
 * nada.»: only where the ANSWER proves it (a 409 `publicacaoExpirada` stops
 * before any send). A coded 502 does not (a create that landed may not be in
 * the snapshot yet), so it reads the exit without that claim.
 */
function saidaPeloSellerCentreShopee(
  publicacao: EstadoPublicacaoRascunhoShopee,
  afirmaNadaCriado: boolean,
): string {
  switch (publicacao.tipo) {
    case 'livre':
      return (
        'Procure o SKU deste produto no Seller Centre: se já existe um anúncio com ele, ' +
        `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) e descarte este rascunho; se não existe, ` +
        'crie-o lá com esse SKU e importe-o.'
      );
    case 'incerta': {
      const importe =
        publicacao.desdeMs === null
          ? `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}, com o mesmo SKU do produto) e depois ` +
            'descarte este rascunho'
          : `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) — a importação adota este rascunho`;
      return (
        (afirmaNadaCriado ? 'Esta tentativa não criou nada. ' : '') +
        `Confira no Seller Centre: se o anúncio da última tentativa existe, ${importe}; se não ` +
        'existe, descarte este rascunho. Não crie outro antes de conferir.'
      );
    }
    case 'em-andamento':
      return (
        'O rascunho ainda aparece em publicação: aguarde a aba atualizar e confira o estado ' +
        'dele antes de qualquer outra ação.'
      );
  }
}

/**
 * Row #11 (`busca-de-anuncio-existente-incompleta`): the first create's
 * same-SKU look-up did not finish — Shopee left a listed row out (its sentence
 * names the ids), the walk stopped short, or Shopee's own cap. The copy
 * assumes none of them; the exit is {@link saidaPeloSellerCentreShopee} over
 * the CURRENT reading (the refusal itself is a `livre` draft's: the look-up
 * runs only there).
 */
function textoDaBuscaDoAnuncioExistenteIncompletaShopee(
  publicacao: EstadoPublicacaoRascunhoShopee,
): string {
  return (
    'A conferência de anúncios com o SKU deste produto nesta conta não terminou — esta ' +
    'tentativa não criou nada. Tente de novo uma vez (pode ter sido uma falha momentânea da ' +
    'Shopee). Se a recusa voltar, o ERP não consegue conferir se já existe um anúncio com este ' +
    `SKU. ${saidaPeloSellerCentreShopee(publicacao, false)}`
  );
}

/**
 * The SKU-moved row (`criacao-incerta-ambigua` with NO `acao`): the produto's
 * SKU changed since the uncertain attempt, and the ERP looks the listing up
 * only by the SKU that attempt SENT (review R8-copy#5):
 *
 * - a SKU (`'SKU-A'`) — named: «volte o SKU do produto a «SKU-A»»;
 * - `''` — the attempt went out with NO SKU: restoring means clearing the
 *   produto's (then the re-send is the SKU-less create, which asks for the
 *   operator's check) — never an empty «»;
 * - `null` (unknown — no record, or the snapshot not read) — it never asks to
 *   restore a value the screen does not show: the only exit left when the
 *   listing does not exist is the discard.
 *
 * The produto's CURRENT SKU is not printed: the trim fold that compares the
 * two lives in apps/shopee (#1369), and «Abrir no produto» shows it.
 */
function textoDoSkuMudouShopee(skuEnviado: string | null): string {
  const enviado =
    skuEnviado === null
      ? ''
      : skuEnviado === ''
        ? ' A tentativa foi enviada sem SKU.'
        : ` A tentativa foi enviada com o SKU «${skuEnviado}».`;
  const seNaoExiste =
    skuEnviado === null
      ? 'descarte este rascunho (Descartar, confirmando) e crie outro'
      : skuEnviado === ''
        ? 'tire o SKU do produto e publique de novo — ou descarte este rascunho (Descartar, ' +
          'confirmando)'
        : `volte o SKU do produto a «${skuEnviado}» e publique de novo — ou descarte este ` +
          'rascunho (Descartar, confirmando)';
  return (
    'O SKU do produto mudou desde a tentativa incerta, e o ERP só procura o anúncio pelo SKU ' +
    `que foi enviado.${enviado} Confira no Seller Centre: se o anúncio existe, deixe o mesmo ` +
    `SKU nele e no produto e importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}), que o vincula e adota ` +
    `este rascunho; se não existe, ${seNaoExiste}.`
  );
}

/**
 * The tab's OWN copy for the refusal motivos of an ORDINARY listing's draft
 * (#1911) — read by {@link textoDoProblemaShopee} right after
 * {@link TEXTO_MOTIVO_KIT}. The two maps' keys never overlap (pinned), so the
 * order of the two lookups decides nothing.
 *
 * Keyed by the 422 row's `motivo`, a FREE string on the wire
 * ({@link MOTIVO_ANUNCIO_SHOPEE}): a renamed slug falls back to the row's
 * `acao` copy, then to the server sentence — never to a wrong row. Every
 * server sentence of these rows is CLI copy or English prose, never shown.
 *
 * P10 — the dispatcher's and the assembly's draft refusals:
 * - `rascunho-em-kit-virtual` — {@link FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE};
 * - `rascunho-nao-nomeado` — its server sentence names the CLI's `--link`.
 *   Unreachable from this tab, whose every publish names its link; kept as a
 *   cheap guard, and its `acao` gets no button (a draft is not addressable);
 * - `marca-nao-escolhida` — {@link FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE}.
 *
 * P11 — the uncertain first create (§C #4–#8), the first create's same-SKU
 * look-up (#9–#11) and Shopee's duplicate refusal (#12):
 * - `criacao-incerta-ambigua` WITH its `importar` — more than one candidate.
 *   The same slug WITHOUT an `acao` is another refusal (the SKU moved), worded
 *   by {@link TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE};
 * - `busca-de-anuncio-incompleta` — ENSURE's walk stopped short: shop
 *   ACTIVITY inside the attempt window, never the catalogue's size. Its
 *   draft is `incerta` by construction (ENSURE runs only over a recorded
 *   attempt), so the copy says THIS attempt created nothing — never a bare
 *   «nada foi criado» (review R8-copy#0's NIT): the earlier one may have;
 * - `criacao-incerta-sem-sku` — the SKU-first remedy (never "importe-o"
 *   alone: a SKU-less import makes ANOTHER produto); the attestation exit is
 *   `./rascunho.ts`'s;
 * - `criacao-incerta-ja-vinculada` — the ids (with their produto) follow; its
 *   two exits are `./rascunho.ts`'s;
 * - `anuncio-existente-sem-vinculo` / `anuncio-existente-de-outro-produto` —
 *   one 422 may hold both, as two rows. Not attestable;
 * - `busca-de-anuncio-existente-incompleta` — the look-up did not finish:
 *   Shopee left a listed row out (its sentence names the ids), the walk
 *   stopped short, or Shopee's own cap. The copy assumes none of them, and the
 *   server's sentence follows it ({@link MOTIVOS_COM_A_FRASE_DO_SERVIDOR}).
 *   This map holds its `livre` wording (the state the look-up runs in);
 *   {@link textoDoProblemaShopee} words a draft row's exit by the block's
 *   CURRENT reading (§I2);
 * - `anuncio-semelhante-existente` — Shopee's `error_repeated_mtsku`, a WIRE
 *   refusal (its sentence is Shopee's English); also stamped on the link, so
 *   the stored row reads it too ({@link textoDaRecusaGuardadaShopee}).
 */
export const TEXTO_MOTIVO_ANUNCIO_SHOPEE: Readonly<Record<string, string>> = {
  [M.rascunhoEmKitVirtual]: FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
  [M.rascunhoNaoNomeado]:
    'Este produto só tem rascunho(s) nesta conta: publique pelo botão Publicar do bloco do ' +
    'rascunho.',
  [M.marcaNaoEscolhida]: FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE,
  [M.criacaoIncertaAmbigua]:
    'A última tentativa pode ter criado o anúncio, e a busca achou mais de um candidato (ou um ' +
    'sem SKU ou data informados pela Shopee). Confira no Seller Centre qual é o desta tentativa ' +
    `e importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) — não publique de novo.`,
  [M.buscaDeAnuncioIncompleta]:
    'A busca pelo anúncio que a última tentativa pode ter criado não terminou — esta tentativa ' +
    'não criou nada. Tentar de novo só ajuda numa falha momentânea da Shopee; esperar não ajuda. ' +
    `Confira no Seller Centre: se o anúncio existe, importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}); ` +
    'se não existe, descarte este rascunho (Descartar, confirmando) e crie outro.',
  [M.criacaoIncertaSemSku]:
    'A última tentativa pode ter criado o anúncio, e ele foi enviado sem SKU: o ERP não ' +
    'consegue procurá-lo. Confira no Seller Centre. Se o anúncio existe: dê a ele, no Seller ' +
    'Centre, o MESMO SKU que você cadastrar neste produto e só então importe-o ' +
    `(${PORTA_DA_IMPORTACAO_SHOPEE}) — sem SKU a importação cria OUTRO produto. Se não existe: ` +
    'confirme pelo botão abaixo que você conferiu.',
  [M.criacaoIncertaJaVinculada]:
    'Pode ser o anúncio da última tentativa, já vinculado no ERP por outro caminho. Confira no ' +
    'Seller Centre antes de publicar de novo.',
  [M.anuncioExistenteSemVinculo]:
    'Já existe nesta conta da Shopee um anúncio com o SKU deste produto, sem vínculo no ERP — ' +
    `não crie outro. Importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}): ele é ligado a ESTE produto só ` +
    'quando o SKU daqui é exatamente o do anúncio (sem espaços nas pontas) e nenhum outro ' +
    'produto o usa; senão a importação cria um produto novo. Depois descarte este rascunho. ' +
    'Nada foi enviado.',
  [M.anuncioExistenteDeOutroProduto]:
    'O SKU deste produto já está num anúncio desta conta vinculado a outro produto do ERP — ' +
    'dois produtos com o mesmo SKU. Dê a este produto (ou ao outro) um SKU próprio antes de ' +
    'publicar. Importar não resolve: o anúncio já tem vínculo. Nada foi enviado.',
  [M.buscaDeAnuncioExistenteIncompleta]: textoDaBuscaDoAnuncioExistenteIncompletaShopee({
    tipo: 'livre',
  }),
  [M.anuncioSemelhanteExistente]:
    'A Shopee considera este anúncio parecido demais com outro já publicado nesta loja. Ela ' +
    'pode tratá-lo como duplicata: confira no Seller Centre antes de tentar de novo.',
};

/**
 * The copy of a motivo whose row carries NO `acao` when that is a DIFFERENT
 * refusal from the same slug with one — read first, for an acao-less row only.
 * Its keys are a subset of {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE}'s (pinned).
 *
 * - `criacao-incerta-ambigua` with no `acao` — the produto's SKU MOVED since
 *   the uncertain attempt, so the ERP (which looks the listing up only by the
 *   SKU that attempt SENT) cannot decide. Its server sentence names
 *   `importar:anuncio`, which would read as {@link FRASE_RECUSA_SEM_PASSO_SHOPEE}.
 *   This map holds the wording for an UNKNOWN sent SKU; a draft row that knows
 *   it names it ({@link textoDoSkuMudouShopee}, R8-copy#5).
 * - `criacao-incerta-ja-vinculada` with no `acao` — never the first refusal
 *   (that one always lists its linked candidates): the §I1 refusal of an
 *   attestation whose fresh look-up found NO candidate at all (it expected to
 *   adopt one). «Pode ser o anúncio da última tentativa, já vinculado» would
 *   name a listing the look-up did not find. ⚠️ The SAME acao-less row also
 *   answers an attestation that reached a draft no longer recording the
 *   uncertain attempt (§I1 completion, apps/shopee's
 *   `problemaDaAtestacaoSemCriacaoIncerta`): NO look-up ran there, so a draft
 *   row whose block reads no uncertain attempt now is worded by
 *   {@link FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE} instead
 *   ({@link textoDoMotivoSemAcaoShopee}); this map's wording is the one for a
 *   draft that still records it.
 */
export const TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE: Readonly<Record<string, string>> = {
  [M.criacaoIncertaAmbigua]: textoDoSkuMudouShopee(null),
  [M.criacaoIncertaJaVinculada]:
    'A busca de agora não acha nenhum anúncio com o SKU enviado, criado na janela da última ' +
    'tentativa — esta publicação não enviou nada nem vinculou anúncio. Confira no Seller Centre ' +
    'o anúncio que a recusa anterior mostrou: se ele existe, confira o SKU dele (o ERP só o acha ' +
    'pelo SKU que a última tentativa enviou) e publique de novo; se não existe mais, publicar de ' +
    'novo cria um anúncio novo.',
};

/**
 * The `criacao-incerta-ja-vinculada` row whose candidates are ALL unlinked
 * (`vinculados: []`) — the §I1 refusal of an attestation that expected a
 * deliberate create while a free listing turned up: the listing may be the
 * attempt's, and it is NOT linked (the row's ids and its exits follow).
 */
const FRASE_JA_VINCULADA_SO_SEM_VINCULO_SHOPEE =
  'Pode ser o anúncio da última tentativa, ainda sem vínculo no ERP. Confira no Seller Centre ' +
  'antes de publicar de novo.';

/**
 * The acao-less `criacao-incerta-ja-vinculada` row on a draft that records NO
 * uncertain attempt now (§I1 completion): the server refuses an attested
 * publish whose draft does not read `incerta` BEFORE any look-up or write, so
 * this never says what a search found — and it is true of round 1's
 * no-candidate mismatch too, once the record is gone. Names no API and
 * promises no look-up (a SKU-less produto is never looked up).
 */
export const FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE =
  'Este rascunho já não registra a tentativa que podia ter criado o anúncio — a confirmação ' +
  'que você deu valia só para aquela recusa, e esta publicação não enviou nada à Shopee nem ' +
  'vinculou anúncio. Confira no Seller Centre e, se for o caso, publique de novo pelo Publicar ' +
  'do rascunho, sem confirmação.';

/**
 * Does the block's reading NOW record an earlier create whose outcome is
 * unknown — `incerta`, or a run in flight over one (`aposIncerteza`)?
 */
function registraCriacaoIncerta(publicacao: EstadoPublicacaoRascunhoShopee): boolean {
  return (
    publicacao.tipo === 'incerta' ||
    (publicacao.tipo === 'em-andamento' && publicacao.aposIncerteza)
  );
}

/**
 * An acao-less row's own copy, read BEFORE the motivo maps: the SKU-moved
 * row with the sent SKU, #11 with the CURRENT reading's exit, and the §I1
 * ja-vinculada refusal by whether the draft still records the uncertain
 * attempt — each only when the draft context gives them; else the maps'
 * wording.
 */
function textoDoMotivoSemAcaoShopee(
  motivo: string,
  rascunho: ContextoDoRascunhoNoProblemaShopee | null,
): string | null {
  if (motivo === M.criacaoIncertaAmbigua) {
    return textoDoSkuMudouShopee(rascunho?.skuEnviado ?? null);
  }
  if (motivo === M.buscaDeAnuncioExistenteIncompleta && rascunho !== null) {
    return textoDaBuscaDoAnuncioExistenteIncompletaShopee(rascunho.publicacao);
  }
  if (
    motivo === M.criacaoIncertaJaVinculada &&
    rascunho !== null &&
    !registraCriacaoIncerta(rascunho.publicacao)
  ) {
    return FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE;
  }
  return textoProprio(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE, motivo) ?? textoDoMotivoShopee(motivo);
}

/**
 * Worded motivos whose server sentence ALSO shows, after the copy (when it is
 * not terminal text): it carries a fact the copy cannot — which listings
 * Shopee left out of the look-up, or how far the walk got (§H).
 */
const MOTIVOS_COM_A_FRASE_DO_SERVIDOR: ReadonlySet<string> = new Set([
  M.buscaDeAnuncioExistenteIncompleta,
]);

/**
 * The copy of ONE refusal row STORED on the link (`falhaPublicacao.problemas[]`,
 * read raw): {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE}'s row for its `motivo` when it
 * has one — a draft's refused `add_item` is stamped, and Shopee's English
 * duplicate prose (`anuncio-semelhante-existente`) must not be what stays on
 * screen — else the stored sentence as it is (`null` when blank or absent).
 */
export function textoDaRecusaGuardadaShopee(motivo: unknown, mensagem: unknown): string | null {
  const doMotivo =
    typeof motivo === 'string' ? textoProprio(TEXTO_MOTIVO_ANUNCIO_SHOPEE, motivo) : null;
  if (doMotivo !== null) return doMotivo;
  return typeof mensagem === 'string' && mensagem.trim() !== '' ? mensagem : null;
}

/** The tab's own copy of a refusal `motivo` — {@link TEXTO_MOTIVO_KIT}, then {@link TEXTO_MOTIVO_ANUNCIO_SHOPEE}. */
function textoDoMotivoShopee(motivo: string): string | null {
  return (
    textoProprio(TEXTO_MOTIVO_KIT, motivo) ?? textoProprio(TEXTO_MOTIVO_ANUNCIO_SHOPEE, motivo)
  );
}

/** What each draft field is called on screen — the conflict modal's rows. Exhaustive by type. */
export const ROTULO_CAMPO_RASCUNHO_SHOPEE = {
  item_name: 'Título',
  description: 'Descrição',
  category_id: 'Categoria',
  marca: 'Marca',
  attributes: 'Atributos',
  logistic_info: 'Logística',
} as const satisfies Record<CampoRascunhoShopee, string>;

/* ---- The block's notices ------------------------------------------------- */

/** A draft created on this screen and not saved yet: nothing exists on the server. */
export const FRASE_RASCUNHO_NOVO_SHOPEE = 'Novo rascunho (ainda não salvo).';

/**
 * The server-truth gate (DC §2.2): a stored draft is not editable until the
 * links listener has answered FROM THE SERVER — a cached pre-write copy must
 * never become what the operator says they saw.
 */
export const FRASE_RASCUNHO_CARREGANDO_SHOPEE = 'Carregando a versão do servidor…';

/**
 * Right after a save: what was saved is shown, read-only, until the listener
 * brings the stored draft back — the next edit starts from THAT, never from a
 * copy of what was sent.
 */
export const FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE =
  'Salvo. Aguardando a versão do servidor para editar de novo…';

/** Logistics are not authored on a draft yet (DC §2.6, #1911 P15/P16). */
export const FRASE_LOGISTICA_RASCUNHO_SHOPEE =
  'Logística: escolhida automaticamente na publicação, entre os canais ativos da loja.';

/** A category change on a draft that stores attributes: the change clears them (K1-12). */
export const FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE =
  'Trocar a categoria remove os atributos já gravados neste rascunho.';

/**
 * How the search for a create that may have happened works — the advice the
 * operator needs while one is pending (§C.2): the ERP looks the listing up by
 * the SKU that was SENT, or by the produto's CURRENT SKU when the sent one was
 * not recorded; "do not change the SKU" holds in both cases.
 */
const FRASE_SKU_DA_CRIACAO_INCERTA_SHOPEE =
  'Antes de criar outro, o ERP procura o anúncio pelo SKU enviado (ou, se ele não ficou ' +
  'registrado, pelo SKU atual do produto): não mude o SKU do produto.';

/**
 * The notice of a draft whose publish lock reads `em-andamento`
 * (`estadoPublicacaoRascunhoShopee`, `@delfrance/schemas`) at `nowMs`. "Até"
 * is `nowMs + aguardarMs` — the instant the reading itself changes, so the
 * minutes are the schemas' and never a second copy of the lock's timeline.
 * ⚠️ It never promises the draft comes back "free" then: a run that reached
 * the send leaves an UNCERTAIN create behind, which only the reading knows.
 */
export function fraseDoRascunhoEmAndamentoShopee(
  estado: Extract<EstadoPublicacaoRascunhoShopee, { tipo: 'em-andamento' }>,
  nowMs: number,
): string {
  const ate = formatarInstanteShopee(nowMs + estado.aguardarMs);
  const desde = formatarInstanteShopee(estado.desdeMs);
  const espera = ate === null ? 'aguarde' : `aguarde até ${ate}`;
  const abertura = estado.posExpiracao
    ? `A publicação anterior deste rascunho expirou, mas ainda pode estar terminando na Shopee — ${espera} e confira.`
    : `Este rascunho está sendo publicado${desde === null ? '' : ` desde ${desde}`} — ${espera} e confira o resultado.`;
  const partes = [abertura, 'Enquanto isso, ele não pode ser editado nem descartado.'];
  if (estado.aposIncerteza) {
    partes.push(
      `Uma tentativa anterior pode ter criado o anúncio. ${FRASE_SKU_DA_CRIACAO_INCERTA_SHOPEE}`,
    );
  }
  return partes.join(' ');
}

/**
 * The notice of a draft whose reading is `incerta`: its last create may have
 * reached Shopee. The draft stays editable — but not its category, which the
 * uncertain attempt may already have used (409 `rascunhoCategoriaTravada`).
 */
export const FRASE_RASCUNHO_INCERTO_SHOPEE =
  'A última tentativa de publicar este rascunho não terminou com certeza — o anúncio pode já ' +
  `existir na Shopee. ${FRASE_SKU_DA_CRIACAO_INCERTA_SHOPEE} A categoria fica travada ` +
  'enquanto isso não se resolve.';

/* ---- Pendências ----------------------------------------------------------- */

/** The draft names no category (a LEAF of the conta's Shopee tree). */
export const FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE =
  'Escolha a categoria (uma categoria final da árvore da Shopee).';

/** Neither the draft nor the stored produto has a usable title. */
export const FRASE_PENDENCIA_SEM_NOME_SHOPEE =
  'O anúncio não tem título: escreva o título do anúncio.';

/** Neither the draft nor the stored produto (aba Descrição) has a usable description. */
export const FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE =
  'O anúncio não tem descrição: escreva uma aqui ou preencha a Descrição do produto (aba ' +
  'Descrição).';

/**
 * A title or description outside the category's band: its length (the TRIMMED
 * text's, the publisher's measure) and the band as the schemas describe it.
 */
export function fraseDoTextoForaDaFaixaShopee(
  qual: 'titulo' | 'descricao',
  comprimento: number,
  banda: FaixaDto | null | undefined,
): string {
  const oQue = qual === 'titulo' ? 'O título' : 'A descrição';
  return (
    `${oQue} tem ${String(comprimento)} caracteres; esta categoria aceita ` +
    `${descreverFaixaShopee(banda)}.`
  );
}

/** Mandatory attributes left empty (P13 renders them; the sentence is ready). */
export function fraseDosAtributosObrigatoriosShopee(nomes: readonly string[]): string {
  return `Preencha os atributos obrigatórios: ${nomes.join(', ')}.`;
}

/**
 * The sentence of ONE pendência (`pendenciasDoRascunhoShopee`,
 * `@delfrance/schemas` — the listing assembly's own predicates). Exhaustive by
 * type: a kind added there breaks the build here until it has a sentence.
 */
export function textoDaPendenciaRascunhoShopee(p: PendenciaRascunhoShopee): string {
  switch (p.tipo) {
    case 'sem-nome':
      return FRASE_PENDENCIA_SEM_NOME_SHOPEE;
    case 'titulo-fora-da-faixa':
      return fraseDoTextoForaDaFaixaShopee('titulo', p.comprimento, p.faixa);
    case 'sem-descricao':
      return FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE;
    case 'descricao-fora-da-faixa':
      return fraseDoTextoForaDaFaixaShopee('descricao', p.comprimento, p.faixa);
    case 'categoria-ausente':
      return FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE;
    case 'atributo-obrigatorio':
      return fraseDosAtributosObrigatoriosShopee(p.nomes);
    case 'marca-nao-escolhida':
      return FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE;
  }
}

/* ---- The second listing (D15) --------------------------------------------- */

/** The confirmation's title, before a SECOND listing of the produto on one conta. */
export const TITULO_SEGUNDO_ANUNCIO_SHOPEE = 'Criar outro anúncio nesta conta?';

/** The confirmation's button. */
export const ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE = 'Criar rascunho mesmo assim';

/**
 * The second-listing confirmation (D15, DC §2.4): how many of the produto's
 * listings and drafts the conta already holds, and the duplicate risk — ONLY
 * that Shopee may treat it as a duplicate (spam): no penalty claim, since the
 * BR policy is unconfirmed (§I3, Lucas 2026-10-29).
 */
export function textoDoSegundoAnuncioShopee(existentes: {
  readonly quantidade: number;
  readonly comRascunho: boolean;
}): string {
  const partes = [
    // A 409 whose `vinculos` could not be read counts 0: never "já tem 0".
    `Esta conta já tem ${existentes.quantidade > 0 ? `${String(existentes.quantidade)} ` : ''}` +
      `anúncio(s) deste produto${existentes.comRascunho ? ', incluindo um rascunho' : ''}.`,
    'Um segundo anúncio do mesmo produto (com o mesmo SKU) na mesma loja pode ser tratado pela ' +
      'Shopee como anúncio duplicado (spam). Crie outro apenas se ele for realmente diferente ' +
      'do que já existe.',
  ];
  if (existentes.comRascunho) {
    partes.push('Se a ideia é continuar o rascunho existente, edite-o em vez de criar outro.');
  }
  return partes.join(' ');
}

/* ---- Discard -------------------------------------------------------------- */

/** The discard confirmation of a SAVED draft whose reading is `livre`. */
export const FRASE_CONFIRMAR_DESCARTE_SHOPEE =
  'O rascunho será excluído. Nada foi publicado na Shopee.';

/** The discard confirmation of a LOCAL draft — nothing was ever saved. */
export const FRASE_CONFIRMAR_DESCARTE_LOCAL_SHOPEE =
  'Este rascunho ainda não foi salvo: descartá-lo apaga só o que está nesta tela.';

/**
 * The three-case dialog of a discard refused 409 `rascunhoCriacaoIncerta`
 * (§C.2, R-K6). Cases (a) and (b) re-send the SAME discard with
 * `confirmarCriacaoIncerta: true`; case (c) is TEXT ONLY — discarding there
 * would lose the one record that lets the import adopt the listing.
 */
export const DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE = {
  titulo: 'A última publicação pode ter criado o anúncio',
  texto:
    'A última tentativa de publicar este rascunho não terminou com certeza: o anúncio pode ' +
    'existir na Shopee. Confira no Seller Centre antes de descartar.',
  naoExiste: 'Conferi no Seller Centre: o anúncio não existe — descartar',
  existeVinculado:
    'O anúncio existe e já está vinculado no ERP (é o da tentativa) — descartar este rascunho',
  existeSemVinculo:
    'O anúncio existe e não está vinculado: não descarte — dê a ele o mesmo SKU do produto e ' +
    `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}); a importação adota este rascunho.`,
} as const;

/* ---- The conflict modal (409 rascunhoConflito with a field list) ---------- */

/** The modal's title. */
export const TITULO_CONFLITO_RASCUNHO_SHOPEE = 'Rascunho alterado';

/** The modal's alert after an EDIT: someone else saved the draft meanwhile. */
export const FRASE_CONFLITO_RASCUNHO_SHOPEE =
  'Este rascunho foi alterado (em outra aba ou por outra pessoa) depois que você começou a ' +
  'editar. Salvar vai sobrescrever os campos abaixo.';

/**
 * The modal's alert after a CREATE retry: the draft at this id was saved with
 * other content — possibly fields the operator never touched, since the route
 * compares every projected field of the create.
 */
export const FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE =
  'Este rascunho já foi salvo com outro conteúdo (numa tentativa anterior ou em outra aba). ' +
  'Salvar vai sobrescrever os campos abaixo.';

/* ---- The answers of the three draft routes (§C.2) ------------------------- */

/** Toasts of the three 2xx. */
export const FRASE_RASCUNHO_CRIADO_SHOPEE = 'Rascunho criado.';
export const FRASE_RASCUNHO_SALVO_SHOPEE = 'Rascunho salvo.';
/** An edit answered `gravados: []` — the stored draft already held every value. */
export const FRASE_RASCUNHO_SEM_MUDANCA_SHOPEE =
  'Nada a salvar: o rascunho já tinha esses valores.';
export const FRASE_RASCUNHO_DESCARTADO_SHOPEE = 'Rascunho descartado.';
/** A discard of an `incerta` draft, attested by the operator (`criacaoIncerta: true`). */
export const FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE =
  'Rascunho descartado. Se um anúncio aparecer na Shopee depois, importe-o — não crie outro.';

/** Which draft route answered — two codes mean different things per route. */
export type OperacaoRascunhoShopee = 'criar' | 'atualizar' | 'descartar';

/** "Nothing was saved / discarded" — the closing words of a refusal, per route. */
function nadaFeito(operacao: OperacaoRascunhoShopee): string {
  return operacao === 'descartar' ? 'Nada foi descartado.' : 'Nada foi gravado.';
}

/**
 * 409 `publicacaoEmAndamento` from a draft route: the draft's OWN lock (the
 * draft routes never answer a sibling's). `aguardarMs` absent ⇒ no seconds,
 * never "0 s".
 */
export function fraseDaPublicacaoEmAndamentoShopee(
  aguardarMs: number | null,
  operacao: OperacaoRascunhoShopee,
): string {
  const espera =
    aguardarMs === null || aguardarMs <= 0
      ? 'aguarde e confira'
      : `aguarde ${String(Math.ceil(aguardarMs / 1000))} s e confira`;
  return (
    'O rascunho está sendo publicado agora (ou a publicação anterior ainda pode estar ' +
    `terminando na Shopee) — ${espera}. ${nadaFeito(operacao)}`
  );
}

/** 409 `rascunhoJaPublicado`: the draft became a listing meanwhile. */
export const FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE =
  'Este rascunho já virou anúncio na Shopee — recarregue a aba; o conteúdo de um anúncio ' +
  'publicado não é editado aqui.';

/** 409 `rascunhoConflito` with `conflitos: []`: the write lost every attempt to concurrent writes. */
export function fraseDoConflitoDeConcorrenciaShopee(operacao: OperacaoRascunhoShopee): string {
  return (
    `Não foi possível ${operacao === 'descartar' ? 'descartar' : 'gravar'}: outras gravações ` +
    `venceram todas as tentativas. ${nadaFeito(operacao)} Tente de novo.`
  );
}

/**
 * 409 `rascunhoConflito` whose `conflitos` could not be read (`null` — an item
 * names a field this build does not know: a newer backend). Nothing written,
 * never a success, never an empty field modal (§C.2, §G #16).
 */
export function fraseDoConflitoIlegivelShopee(operacao: OperacaoRascunhoShopee): string {
  return (
    `Não foi possível ${operacao === 'descartar' ? 'descartar' : 'gravar'}: o rascunho mudou ` +
    `em outra gravação. ${nadaFeito(operacao)} Recarregue a aba e tente de novo.`
  );
}

/**
 * 409 `rascunhoConflito` on a DISCARD: the stored draft is not what the
 * operator saw (K1-13). A discard compares what the block HOLDS — for unsaved
 * edits, the version the operator loaded — so every retry from such a block
 * answers the same 409 (deliberately: it never deletes a version nobody saw)
 * until «Desfazer alterações» drops the edits and shows the current version.
 * The sentence names that exit CONDITIONALLY: a block with no unsaved edits
 * already shows the current version, and «Desfazer» is disabled there.
 */
export const FRASE_DESCARTE_EM_CONFLITO_SHOPEE =
  'O rascunho mudou desde que você o abriu (em outra aba ou por outra pessoa) — nada foi ' +
  'descartado. Confira a versão atual e, se ainda quiser, descarte de novo; se este ' +
  'rascunho tem alterações não salvas, use antes «Desfazer alterações» — só assim a versão ' +
  'atual aparece.';

/**
 * A category change while the reading is `incerta` — the block's own
 * `categoria-travada` and the route's 409 `rascunhoCategoriaTravada` (one
 * sentence: in both the block holds an unsaved category change, so «Desfazer
 * alterações» is offered). The way to save the OTHER edits is named: the
 * category change blocks every save until it is gone.
 */
export const FRASE_CATEGORIA_TRAVADA_SHOPEE =
  'A categoria não muda enquanto a última tentativa de publicar estiver incerta: ela pode ter ' +
  'criado o anúncio na categoria gravada. Confira no Seller Centre: se o anúncio existe, dê a ' +
  'ele o mesmo SKU do produto e importe-o; se não, descarte este rascunho confirmando. Nada ' +
  'é salvo enquanto a troca de categoria estiver pendente: para salvar o resto, use ' +
  '«Desfazer alterações» (desfaz todas as alterações não salvas) e refaça as outras sem ' +
  'trocar a categoria.';

/** The button that puts the HELD category back in `incerta` (`bloco.podeVoltarCategoria`). */
export const ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE = 'Voltar à categoria gravada';

/**
 * Beside {@link FRASE_CATEGORIA_TRAVADA_SHOPEE} ONLY while the block offers
 * {@link ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE} (the local impediment of an
 * editable `incerta` block) — never with the route's 409, whose block may not
 * offer it yet: the way to keep the other edits. True with or without them
 * (it never says there are any).
 */
export const FRASE_VOLTAR_CATEGORIA_GRAVADA_SHOPEE =
  `Ou use «${ROTULO_VOLTAR_CATEGORIA_GRAVADA_SHOPEE}» (em Categoria): desfaz só a troca ` +
  'de categoria e mantém as outras alterações.';

/** 409 `rascunhoIdEmUso` (create only): never retried at the same id (C-19). */
export const FRASE_RASCUNHO_ID_EM_USO_SHOPEE =
  'Este id de rascunho já é usado por outro vínculo — abra «Novo anúncio» de novo.';

/** 422 `rascunhoProdutoInvalido`, `motivo: 'filho'`. */
export const FRASE_RASCUNHO_DE_VARIACAO_SHOPEE =
  'Este produto é uma variação: o anúncio é do produto pai.';

/**
 * 422 `rascunhoProdutoInvalido`, `motivo: 'kit-virtual'`. Never "publique o
 * kit": this tab has no first native-kit publish (see
 * {@link FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE}).
 */
export const FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE =
  'Este produto é kit virtual: na Shopee ele é publicado como kit nativo, cuja primeira ' +
  'publicação não é feita por esta tela (é feita pelo terminal) — um rascunho de anúncio ' +
  'comum não se aplica.';

/** 404 `rascunhoInexistente` on a CREATE: it is the PRODUTO that is gone. */
export const FRASE_PRODUTO_INEXISTENTE_SHOPEE = 'O produto não existe mais.';

/** 404 `rascunhoInexistente` on an edit or a discard: the DRAFT is gone (or is another conta's). */
export const FRASE_RASCUNHO_INEXISTENTE_SHOPEE =
  'O rascunho não existe mais (ou é de outra conta) — recarregue a aba.';

/** The CODELESS 404 of the draft routes: the conta is gone or is not Shopee's. */
export const FRASE_CONTA_NAO_ENCONTRADA_SHOPEE =
  'A conta não foi encontrada ou não é da Shopee — recarregue a aba.';

/** The create's CODELESS 400 with a `linkDocId`: no title, and the produto has no name either. */
export const FRASE_RASCUNHO_SEM_TITULO_SHOPEE =
  'O produto não tem nome: escreva o título do anúncio.';

/**
 * A draft route answered 2xx in a shape this build cannot read
 * (`ShopeeClientRespostaInvalidaError` — e.g. a newer backend naming a field
 * in `gravados` this build does not know, a CLOSED enum on purpose). The write
 * MAY have happened: never a success toast, never "nada foi salvo".
 */
export function fraseDaRespostaIlegivelDoRascunhoShopee(operacao: OperacaoRascunhoShopee): string {
  const oQue =
    operacao === 'criar'
      ? 'o rascunho PODE ter sido criado'
      : operacao === 'atualizar'
        ? 'as alterações PODEM ter sido salvas'
        : 'o rascunho PODE ter sido descartado';
  return `A resposta do servidor não pôde ser lida: ${oQue}. Recarregue a aba antes de editar de novo.`;
}

/**
 * No answer the tab can trust — a network failure, or a 5xx after which the
 * route may already have written. The create may be re-sent as is (the SAME id
 * is never created twice); an edit or a discard is checked against the list
 * the listener brings back first.
 */
export function fraseDaRespostaIncertaDoRascunhoShopee(operacao: OperacaoRascunhoShopee): string {
  if (operacao === 'criar') {
    return (
      'Sem resposta confirmada do servidor: o rascunho pode ter sido criado ou não. Salve de ' +
      'novo — o mesmo rascunho nunca é criado duas vezes.'
    );
  }
  return operacao === 'atualizar'
    ? 'Sem resposta confirmada do servidor: as alterações podem ter sido salvas ou não. ' +
        'Aguarde a aba atualizar e confira antes de salvar de novo.'
    : 'Sem resposta confirmada do servidor: o rascunho pode ter sido descartado ou não. ' +
        'Aguarde a aba atualizar e confira.';
}

/**
 * The notices of a dirty draft the snapshot overtook (DC §2.2) — never a silent
 * drop of what the operator typed.
 */
export const FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE =
  'Este anúncio foi publicado enquanto você editava o rascunho: as alterações não salvas não ' +
  'foram aplicadas.';
export const FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE =
  'O rascunho que você editava foi descartado — em outra aba ou por outra pessoa.';

/* -------------------------------------------------------------------------- */
/*                #1911 P11 — Publicar on a listing DRAFT                      */
/* -------------------------------------------------------------------------- */

/* ---- What keeps Publicar disabled (`publicacaoDoRascunhoShopee`, ./rascunho.ts) */

/** A local draft: nothing exists on the server to publish. */
export const FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE = 'Salve o rascunho antes de publicar.';

/** The draft has unsaved changes: the publish reads the STORED draft. */
export const FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE = 'Salve as alterações antes de publicar.';

/** The produto form has unsaved changes: the publish reads the STORED produto (K2-7). */
export const FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE =
  'Salve o produto antes de publicar: a publicação usa o produto salvo (peso, medidas, fotos, ' +
  'SKU, GTIN, preço e estoque).';

/**
 * The title/description bands are not known yet (loading, or the read
 * failed): until they are, a band pendência the publish would refuse cannot be
 * seen here, so Publicar waits for them.
 */
export const FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE =
  'Publicar fica disponível quando os limites de título e descrição da categoria forem lidos ' +
  'da Shopee.';

/* ---- The confirmation (DC §2.6) ------------------------------------------- */

export const TITULO_PUBLICAR_RASCUNHO_SHOPEE = 'Publicar na Shopee';
export const ROTULO_PUBLICAR_RASCUNHO_SHOPEE = 'Publicar';
export const ROTULO_CRIAR_PAUSADO_SHOPEE =
  'Criar pausado (o anúncio só aparece na loja depois de reativado)';

/**
 * The attestation a refusal row's exit carries into the Publicar confirmation
 * (`SaidaDoProblemaShopee`'s `publicar-atestando`, `./rascunho.ts`): `adota` =
 * the UNLINKED listing(s) the publish promises to adopt, `[]` = a deliberate
 * CREATE (§C #7's SKU-less attempt, §C #8's every-candidate-linked «segundo
 * anúncio»). `null` = the block's own «Publicar», no attestation.
 *
 * ⚠️ The promise is the SERVER's to keep (§I1, Lucas 2026-10-29): the publish
 * sends `adota` as `criacaoIncertaAdota`, and the look-up honours the
 * attestation only when its FRESH verdict is that one — else it refuses with
 * a fresh row and sends nothing ({@link FRASE_ATESTACAO_SUPERADA_SHOPEE}).
 *
 * ⚠️ But that verdict is a SCAN only where there is a SKU to scan for
 * (`varre`, #1911 P11 review round 2 — KNOWN #12): the copy promises «se algo
 * mudou, nada é enviado» ONLY when the look-up walks the conta again.
 */
export interface AtestacaoDaPublicacaoShopee {
  readonly adota: readonly number[];
  /**
   * Does the attested publish's look-up SCAN the conta again before it acts?
   * `true` — `criacao-incerta-ja-vinculada`'s two exits: ENSURE re-walks the
   * attempt window, and anything other than the promised verdict (a listing
   * linked or freed since the refusal, one appearing) refuses with nothing
   * sent. `false` — `criacao-incerta-sem-sku`: an attempt sent without a SKU
   * cannot be looked up (a blank fold would "hit" every SKU-less listing), so
   * the server proceeds WITHOUT a scan (`apps/shopee`'s
   * `localizarAnuncioIncerto`, `varreu: false`) and nothing re-checks what
   * the operator saw in Seller Centre.
   */
  readonly varre: boolean;
}

/**
 * A creating attestation whose look-up SCANS again (`varre`, the «segundo
 * anúncio» exit): the fresh verdict must be a create, or nothing is sent.
 */
export const FRASE_ATESTACAO_QUE_VARRE_SHOPEE =
  'Se algo mudou desde a recusa que você conferiu, nada é enviado e a recusa volta atualizada.';

/**
 * A creating attestation whose look-up scans NOTHING (`varre: false`, the
 * SKU-less attempt's exit): no change-guard is promised — the ERP cannot look
 * such a listing up — and a listing that does appear is imported, its SKU
 * given first (§C rule 5: a SKU-less import makes ANOTHER produto), never
 * published over.
 */
export const FRASE_ATESTACAO_SEM_BUSCA_SHOPEE =
  'O ERP não consegue procurar na Shopee um anúncio enviado sem SKU, então esta publicação não ' +
  'confere de novo o que você viu: se o anúncio da última tentativa aparecer no Seller Centre, ' +
  'não publique — dê a ele, no Seller Centre, o MESMO SKU que você cadastrar neste produto e só ' +
  `então importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}).`;

/**
 * The Publicar confirmation, by what the publish will DO:
 *
 * - an attestation that ADOPTS (`adota` non-empty, §C #8's mixed
 *   `criacao-incerta-ja-vinculada`): it creates NOTHING — it links the listing
 *   to this draft and updates it (`retomandoCriacao`) — so the text never
 *   opens with «O anúncio será criado», which would contradict the exit's own
 *   label; and if that listing was linked elsewhere (or another appeared)
 *   since the refusal, nothing is sent (§I1) — said only when the look-up
 *   scans (`varre`; every adopting exit does).
 * - an attestation that CREATES (`adota: []`): a new listing, never a
 *   look-up promise — a SKU-less attempt cannot be looked up, and the
 *   «segundo anúncio» publish never adopts (the server refuses instead of
 *   adopting what it did not promise) — so NOT the `incerta` clause below
 *   (KNOWN #12); «Criar pausado» applies (a create). What it says about a
 *   change since the refusal follows `varre` (review round 2): the «segundo
 *   anúncio» publish re-scans, so a change sends nothing; the SKU-less one
 *   scans NOTHING — it says so, and that a listing appearing in Seller Centre
 *   is imported (SKU first, §C rule 5), never published over.
 * - no attestation: a create; on an `incerta` draft the publish may ADOPT the
 *   listing the last attempt created instead — an update, which never sends
 *   a status — so it says that «Criar pausado» then does not apply.
 */
export function textoDaConfirmacaoDePublicacaoShopee(args: {
  readonly contaNome: string;
  readonly publicacao: EstadoPublicacaoRascunhoShopee;
  readonly atestacao: AtestacaoDaPublicacaoShopee | null;
}): string {
  const { atestacao } = args;
  if (atestacao !== null && atestacao.adota.length > 0) {
    const ids = atestacao.adota.map(String).join(', ');
    return (
      `O ERP vai adotar o anúncio sem vínculo ${ids} da conta «${args.contaNome}» como o desta ` +
      'tentativa — nenhum anúncio novo é criado: ele é vinculado a este rascunho e atualizado ' +
      'com o título, a categoria e a marca dele. Peso, medidas, fotos, SKU, GTIN, preço e ' +
      'estoque vêm do produto. Uma atualização não muda o status do anúncio, então «Criar ' +
      'pausado» não se aplica. ' +
      (atestacao.varre
        ? 'Se desde a recusa esse anúncio foi vinculado a outro produto (ou outro anúncio ' +
          'apareceu), nada é enviado e a recusa volta com o que a busca encontrar. '
        : '') +
      'Depois de publicado, este editor fica somente leitura.'
    );
  }
  const partes = [
    `O anúncio será criado na conta «${args.contaNome}» com o título, a categoria e a marca ` +
      'deste rascunho. Peso, medidas, fotos, SKU, GTIN, preço e estoque vêm do produto. Depois ' +
      'de publicado, este editor fica somente leitura.',
  ];
  if (atestacao !== null) {
    partes.push(
      'Você confirmou o que conferiu no Seller Centre: esta publicação cria um anúncio novo, sem ' +
        'adotar nenhum existente.',
      atestacao.varre ? FRASE_ATESTACAO_QUE_VARRE_SHOPEE : FRASE_ATESTACAO_SEM_BUSCA_SHOPEE,
    );
  } else if (args.publicacao.tipo === 'incerta') {
    partes.push(
      'A última tentativa pode ter criado o anúncio: antes de criar outro, o ERP o procura pelo ' +
        'SKU enviado e, se o achar, vincula-o a este rascunho em vez de criar — e então «Criar ' +
        'pausado» não se aplica.',
    );
  }
  return partes.join(' ');
}

/**
 * The second-listing warning's title when the confirmation is a PUBLISH (D15)
 * that CREATES next to a listing already on Shopee (or counts it cannot
 * split). ⚠️ Not for every D15: read {@link tituloDoSegundoAnuncioNaPublicacaoShopee}.
 */
export const TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE = 'Publicar outro anúncio nesta conta?';

/** Its confirm button. */
export const ROTULO_PUBLICAR_SEGUNDO_ANUNCIO_SHOPEE = 'Publicar mesmo assim';

/**
 * The D15 numbers the publish-side copy reads: `quantidade` / `comRascunho`
 * (P10's), and — when the counter split them (`./rascunho.ts` always does) —
 * `naShopee` (links naming a listing) and `rascunhos` (stored drafts plus this
 * screen's local ones). Either split count absent ⇒ the split is UNKNOWN, and
 * unknown never reads as "only drafts" (the generic, louder copy).
 *
 * `rascunhosIncertos` (review round 2, R8-copy#3's sibling): how many of the
 * counted STORED drafts record a create whose outcome is unknown — their last
 * attempt may have created a listing of this produto on Shopee, still
 * unlinked. Present only when > 0 (the counters in `./rascunho.ts` spread it
 * or nothing), so absent = none.
 */
export interface ContagemDoSegundoAnuncioShopee {
  readonly quantidade: number;
  readonly comRascunho: boolean;
  readonly naShopee?: number;
  readonly rascunhos?: number;
  readonly rascunhosIncertos?: number;
}

/**
 * What the D15 copy reads of an attestation: only WHAT it promises (adopt or
 * create). Whether its look-up scans is the confirmation's question
 * ({@link textoDaConfirmacaoDePublicacaoShopee}), not the warning's.
 */
type AtestacaoDoSegundoAnuncioShopee = Pick<AtestacaoDaPublicacaoShopee, 'adota'>;

/** What the publish under a D15 warning does (review R8-copy#3, KNOWN #11). */
type AtoDaPublicacaoShopee = 'adota' | 'cria-ao-lado-de-rascunhos' | 'cria';

function atoDaPublicacaoShopee(
  existentes: ContagemDoSegundoAnuncioShopee,
  atestacao: AtestacaoDoSegundoAnuncioShopee | null,
): AtoDaPublicacaoShopee {
  if (atestacao !== null && atestacao.adota.length > 0) return 'adota';
  const { naShopee, rascunhos } = existentes;
  return naShopee === 0 && rascunhos !== undefined && rascunhos > 0
    ? 'cria-ao-lado-de-rascunhos'
    : 'cria';
}

/**
 * The D15 title for THIS publish — {@link TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE}
 * only when it creates next to a listing on Shopee; an adopting attestation
 * links a listing that already exists, and with only drafts on the conta this
 * one becomes the FIRST listing.
 */
export function tituloDoSegundoAnuncioNaPublicacaoShopee(
  existentes: ContagemDoSegundoAnuncioShopee,
  atestacao: AtestacaoDoSegundoAnuncioShopee | null,
): string {
  switch (atoDaPublicacaoShopee(existentes, atestacao)) {
    case 'adota':
      return 'Vincular um anúncio que já existe a este produto?';
    case 'cria-ao-lado-de-rascunhos':
      return 'Publicar com outro rascunho nesta conta?';
    case 'cria':
      return TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE;
  }
}

/**
 * D15 beside drafts only, when a counted draft's last attempt is uncertain
 * (`rascunhosIncertos`): it may have created an unlinked listing of the
 * produto — and the server refuses this publish while it stays so (its
 * sibling scan), so the operator checks first.
 */
export const FRASE_RASCUNHO_IRMAO_INCERTO_SHOPEE =
  'A última tentativa de publicar outro rascunho dele ficou incerta e pode ter criado um ' +
  'anúncio na Shopee, ainda sem vínculo — confira no Seller Centre antes de publicar este.';

/**
 * What the conta already holds, in words — never "já tem 0" (an unreadable 409
 * counts 0). With only drafts beside it, «nenhum anúncio dele na Shopee» only
 * when `semCriacaoIncerta` (no counted draft, nor this one, may have created
 * one); else what the links prove: none LINKED in the ERP.
 */
function contagemNaContaShopee(
  existentes: ContagemDoSegundoAnuncioShopee,
  semCriacaoIncerta: boolean,
): string {
  const { naShopee, rascunhos } = existentes;
  if (naShopee !== undefined && rascunhos !== undefined && naShopee + rascunhos > 0) {
    if (naShopee === 0) {
      return (
        `Há ${String(rascunhos)} outro(s) rascunho(s) deste produto nesta conta, e nenhum ` +
        `anúncio dele ${semCriacaoIncerta ? 'na Shopee' : 'vinculado no ERP'}.`
      );
    }
    return (
      `Esta conta já tem ${String(naShopee)} anúncio(s) deste produto na Shopee` +
      (rascunhos > 0 ? ` e ${String(rascunhos)} outro(s) rascunho(s).` : '.')
    );
  }
  return (
    `Esta conta já tem ${existentes.quantidade > 0 ? `${String(existentes.quantidade)} ` : ''}` +
    `anúncio(s)${existentes.comRascunho ? ' ou rascunho(s)' : ''} deste produto.`
  );
}

/**
 * The second-listing warning inside the Publicar confirmation (D15, K1-4) —
 * the numbers are `segundoAnuncioNaContaShopee` (`./rascunho.ts`) over the
 * conta's links WITHOUT the draft being published, or a 409
 * `rascunhoContaJaTemAnuncio`'s `vinculos`. The duplicate risk is ONLY that
 * Shopee may treat the new listing as a duplicate (spam) — no penalty claim
 * (§I3, Lucas 2026-10-29: the BR policy is unconfirmed).
 *
 * Worded by what the publish DOES ({@link tituloDoSegundoAnuncioNaPublicacaoShopee}
 * the same way):
 * - an attestation that ADOPTS creates no listing (KNOWN #11): it links one
 *   that already exists, so the produto holds one more listing on the conta;
 * - every counted vínculo a DRAFT (review R8-copy#3): this publish makes the
 *   conta's FIRST listing of the produto — the duplicate is the OTHER draft's
 *   later publish. ⚠️ «nenhum anúncio dele na Shopee» and a flat «Este será o
 *   primeiro» only when nothing on record says otherwise (review round 2): a
 *   counted draft whose last attempt is uncertain (`rascunhosIncertos`) may
 *   have created an unlinked listing — said, with «confira» — and this draft
 *   being uncertain itself keeps the adoption caveat the `cria` branch has;
 *   either way the links prove only «nenhum anúncio dele vinculado no ERP»;
 * - otherwise it creates ANOTHER listing — and on a plain `incerta` publish,
 *   unless the look-up finds the last attempt's listing and adopts it.
 */
export function textoDoSegundoAnuncioNaPublicacaoShopee(
  existentes: ContagemDoSegundoAnuncioShopee,
  contexto: {
    readonly publicacao: EstadoPublicacaoRascunhoShopee;
    readonly atestacao: AtestacaoDoSegundoAnuncioShopee | null;
  },
): string {
  const { atestacao, publicacao } = contexto;
  const irmaosIncertos = existentes.rascunhosIncertos ?? 0;
  // `livre` ⇔ nothing on record for THIS draft either (its reading in the SAME render).
  const semCriacaoIncerta = irmaosIncertos === 0 && publicacao.tipo === 'livre';
  const conta = contagemNaContaShopee(existentes, semCriacaoIncerta);
  switch (atoDaPublicacaoShopee(existentes, atestacao)) {
    case 'adota': {
      // "One more listing" only when one is KNOWN to be on Shopee; with only
      // drafts beside it the adopted listing is the produto's first here.
      const { naShopee, rascunhos } = existentes;
      const mais =
        naShopee === undefined || rascunhos === undefined || naShopee + rascunhos === 0
          ? ' — e o produto pode passar a ter mais de um anúncio nesta conta'
          : naShopee > 0
            ? ' — e o produto passa a ter mais de um anúncio nesta conta'
            : '';
      return (
        `${conta} Esta publicação não cria anúncio: ela vincula a este produto o anúncio ` +
        `${(atestacao?.adota ?? []).map(String).join(', ')}, que já existe na Shopee${mais}. ` +
        'Confirme apenas se esse anúncio é mesmo deste produto.'
      );
    }
    case 'cria-ao-lado-de-rascunhos': {
      const depois =
        'publicar um outro rascunho depois criaria um segundo anúncio com o mesmo SKU, que a ' +
        'Shopee pode tratar como duplicado (spam).';
      if (semCriacaoIncerta) return `${conta} Este será o primeiro anúncio dele na loja; ${depois}`;
      const salvo =
        atestacao === null && publicacao.tipo === 'incerta'
          ? ' — a menos que o ERP ache o anúncio da última tentativa deste rascunho e o adote —'
          : '';
      return irmaosIncertos > 0
        ? `${conta} ${FRASE_RASCUNHO_IRMAO_INCERTO_SHOPEE} Se nenhum foi criado, publicar este ` +
            `rascunho cria o primeiro anúncio dele na loja${salvo}; ${depois}`
        : `${conta} Publicar este rascunho cria o primeiro anúncio dele na loja${salvo}; ${depois}`;
    }
    case 'cria': {
      const salvo =
        atestacao === null && publicacao.tipo === 'incerta'
          ? ' — a menos que o ERP ache o anúncio da última tentativa e o adote —'
          : '';
      return (
        `${conta} Publicar este rascunho cria OUTRO anúncio do mesmo produto (com o mesmo SKU) ` +
        `na mesma loja${salvo}, que a Shopee pode tratar como duplicado (spam). Publique apenas ` +
        'se ele for realmente diferente do que já existe.'
      );
    }
  }
}

/* ---- The answers of a draft's Publicar (§C.2) ------------------------------ */

/** Whole seconds of a wait the server named — rounded UP, never "0 s". */
function segundosDaEspera(ms: number): string {
  return String(Math.ceil(ms / 1000));
}

/** A link a 409 names, as the operator recognises it. */
function nomeDoVinculoShopee(v: VinculoConflitanteShopee): string {
  if (v.rascunho) return `rascunho ${v.linkDocId}`;
  return v.itemId === null ? `vínculo ${v.linkDocId}` : `anúncio ${String(v.itemId)}`;
}

/**
 * 409 `publicacaoEmAndamento` on a draft's Publicar — keyed on `vinculos`
 * FIRST (§G #10): a SIBLING holds it when the list is there, and only then
 * does `aguardarMs` tell "being published" (a number) from "uncertain" (absent
 * — waiting does not help). No `vinculos` ⇒ the draft's OWN lock. Never
 * "aguarde 0 s".
 */
export function fraseDaPublicacaoDoRascunhoEmAndamentoShopee(detalhes: {
  readonly aguardarMs: number | null;
  readonly vinculos: readonly VinculoConflitanteShopee[] | null;
}): string {
  const { aguardarMs, vinculos } = detalhes;
  const espera =
    aguardarMs !== null && aguardarMs > 0 ? `aguarde ${segundosDaEspera(aguardarMs)} s` : null;
  if (vinculos !== null && vinculos.length > 0) {
    const lista = vinculos.map(nomeDoVinculoShopee).join(', ');
    return espera === null
      ? `Outro vínculo deste produto nesta conta tem criação incerta (${lista}) — confira no ` +
          'Seller Centre antes de publicar este rascunho.'
      : `Outro vínculo deste produto nesta conta está sendo publicado agora (${lista}) — ` +
          `${espera} e confira antes de publicar este rascunho.`;
  }
  return (
    'O rascunho está sendo publicado agora (ou a publicação anterior ainda pode estar ' +
    `terminando na Shopee) — ${espera === null ? 'aguarde' : espera} e confira. Esta tentativa ` +
    'não enviou nada.'
  );
}

/**
 * A server sentence that would contradict the tab's own copy beside it:
 * «nada foi enviado» (false on the fiscal retry's second leg, which follows a
 * refused first one), a retry promise («tente de novo», beside our «não
 * insista»), the API's own name (`add_item`) and «nenhum anúncio foi criado»
 * (which, on an `incerta` draft, reads as "the last attempt created nothing").
 */
const CONTRADIZ_A_COPIA_DA_PUBLICACAO =
  /nada foi enviado|tente de novo|\badd_item\b|nenhum anúncio foi criado/i;

/**
 * The causes a 409 `publicacaoExpirada` names (apps/shopee's
 * `reservaRascunho.ts`: the send gate, the look-ups under its deadline, a lock
 * no longer the run's), each in the tab's words (review R8-copy#6). Matched on
 * the CAUSE clause only, so the server sentence around it may change shape;
 * a cause this build does not know falls to the guarded sentence
 * ({@link detalheDaPublicacaoShopee}) — the SAFE direction, like a renamed
 * motivo. ⚠️ The request-deadline look-up cause also names the CLI there
 * (KNOWN #10): its pt-BR wording here drops that.
 */
const CAUSAS_DA_PUBLICACAO_EXPIRADA: readonly (readonly [RegExp, string])[] = [
  [
    /a busca não coube no tempo desta requisição/i,
    'a busca por anúncios com o SKU deste produto não coube no tempo desta requisição',
  ],
  [
    /a busca não coube no tempo da trava/i,
    'a busca por anúncios com o SKU deste produto não coube no tempo reservado para a publicação',
  ],
  [
    /o tempo desta requisição acabaria durante o envio/i,
    'o tempo desta requisição acabaria durante o envio à Shopee',
  ],
  [
    /o tempo da trava acabaria durante o envio/i,
    'o tempo reservado para a publicação acabaria durante o envio à Shopee',
  ],
  [
    /trava da publicação já não é desta execução|trava fora desta execução/i,
    'outra execução assumiu a publicação deste rascunho',
  ],
];

/**
 * What of a draft publish's server sentence the tab may print beside its own
 * copy, or `null`: a KNOWN cause in the tab's words («Causa: …»), else the
 * sentence itself as «Detalhe: …» unless it is terminal text or says
 * something the copy beside it contradicts
 * ({@link CONTRADIZ_A_COPIA_DA_PUBLICACAO}).
 */
function detalheDaPublicacaoShopee(
  mensagemDoServidor: string,
  causas: readonly (readonly [RegExp, string])[],
): string | null {
  for (const [padrao, causa] of causas) {
    if (padrao.test(mensagemDoServidor)) return `Causa: ${causa}.`;
  }
  const texto = mensagemDoServidor.trim();
  if (texto === '' || ehFraseDeTerminal(texto) || CONTRADIZ_A_COPIA_DA_PUBLICACAO.test(texto)) {
    return null;
  }
  return comoDetalhe(texto);
}

/**
 * 409 `publicacaoExpirada` on a draft's Publicar: the run stopped BEFORE any
 * send of this attempt that could create — the send gate saw the time running
 * out, a look-up before it (ENSURE, the first create's same-SKU check) did not
 * fit, or the lock was no longer the run's. Keyed on the CODE; worded at
 * RENDER over the block's CURRENT reading (`publicacao`, review R8-copy#0):
 *
 * - `livre`: nothing was created; a retry helps only a passing delay — then
 *   §I2's CHECK-FIRST exit (never "create it" where the ERP could not look);
 * - `incerta`: the last attempt may have created the listing — «Esta
 *   tentativa não criou nada» (never a bare «nenhum anúncio foi criado») and
 *   §I2's incerta exit;
 * - `em-andamento`: wait for the reading (this answer's own lock may still be
 *   in the snapshot).
 *
 * The server's cause follows the opening ({@link detalheDaPublicacaoShopee},
 * R8-copy#6). ⚠️ Never "the send timed out" (no send was made), never "nada
 * foi enviado" (a fiscal second leg follows a refused first one), never a
 * promise that a retry helps: when the conta's look-up is what does not fit,
 * every retry re-walks it.
 */
export function fraseDaPublicacaoExpiradaShopee(
  mensagemDoServidor: string,
  publicacao: EstadoPublicacaoRascunhoShopee,
): string {
  const detalhe = detalheDaPublicacaoShopee(mensagemDoServidor, CAUSAS_DA_PUBLICACAO_EXPIRADA);
  const partes: string[] = [];
  switch (publicacao.tipo) {
    case 'livre':
      partes.push('A publicação parou antes de criar o anúncio — nenhum anúncio foi criado.');
      if (detalhe !== null) partes.push(detalhe);
      partes.push(
        'Tentar de novo só ajuda se a demora foi passageira; se esta mensagem voltar, não insista.',
        saidaPeloSellerCentreShopee(publicacao, true),
      );
      break;
    case 'incerta':
      partes.push('A publicação parou antes de terminar.');
      if (detalhe !== null) partes.push(detalhe);
      partes.push(saidaPeloSellerCentreShopee(publicacao, true));
      break;
    case 'em-andamento':
      partes.push('A publicação parou antes de terminar — esta tentativa não criou nada.');
      if (detalhe !== null) partes.push(detalhe);
      partes.push(saidaPeloSellerCentreShopee(publicacao, true));
      break;
  }
  return partes.join(' ');
}

/** 409 `rascunhoContencao` (publish only): the lock was lost to concurrent writes on every attempt. */
export const FRASE_PUBLICACAO_CONTENCAO_SHOPEE =
  'Não foi possível reservar o rascunho para publicar (gravações concorrentes) — nada foi ' +
  'enviado à Shopee; tente de novo.';

/** 409 `rascunhoCriacaoIncerta` on a publish: an uncertain create with NO readable window. */
export const FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE =
  'A última tentativa pode ter criado o anúncio e o ERP não sabe quando. Confira no Seller ' +
  `Centre: se existir, importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}), com o mesmo SKU do produto; ` +
  'se não, descarte este rascunho confirmando.';

/**
 * 404 `anuncioNaoEncontrado` on a DRAFT's Publicar: the draft was discarded
 * meanwhile (in another tab) — never "this link is not this conta's", which is
 * the copy of a live link's 404.
 */
export const FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE =
  'O rascunho não existe mais (descartado em outra aba) — recarregue a aba.';

/** A rate-limited 502 on a draft's Publicar. What exists now is the snapshot's to say. */
export const FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE =
  'A Shopee limitou as consultas durante a publicação. Confira o estado do rascunho e publique ' +
  'de novo em alguns minutos.';

/**
 * Any other 502 with a code on a draft's Publicar — Shopee refused a call the
 * publish needed; for a first create, typically the same-SKU look-up past
 * Shopee's own listing cap (§H Q2, register 311). It claims nothing about
 * what exists — the block shows that (a create that landed may not be in the
 * snapshot yet, so not even «esta tentativa não criou nada») — and names
 * §I2's exit for the CURRENT reading (`publicacao`, review R8-copy#0): `livre`
 * check-first, `incerta` the last attempt's listing first and never another,
 * `em-andamento` wait. The server's sentence follows when it is neither
 * terminal text nor a contradiction of this copy.
 */
export function fraseDaPublicacaoInterrompidaShopee(
  mensagemDoServidor: string,
  publicacao: EstadoPublicacaoRascunhoShopee,
): string {
  const partes = ['A publicação não terminou: a Shopee recusou uma consulta.'];
  const detalhe = detalheDaPublicacaoShopee(mensagemDoServidor, []);
  if (detalhe !== null) partes.push(detalhe);
  switch (publicacao.tipo) {
    case 'livre':
      partes.push(
        'Confira o estado do rascunho; se ele continua rascunho e isto se repetir, não insista.',
        saidaPeloSellerCentreShopee(publicacao, false),
      );
      break;
    case 'incerta':
      // Check-first, so true under a lagging snapshot too: a listing this
      // attempt created IS "the last attempt's" — found, and imported.
      partes.push(saidaPeloSellerCentreShopee(publicacao, false));
      break;
    case 'em-andamento':
      partes.push(saidaPeloSellerCentreShopee(publicacao, false));
      break;
  }
  return partes.join(' ');
}

/**
 * No answer the tab can trust after a draft's Publicar (§C.2, D-P11 #15) — a
 * network failure, a 2xx it cannot read, a 5xx without a code (App Hosting's
 * 504 at the route ceiling is one, and its lock may outlive it). NEVER
 * "falhou": the publish may still be running, or may have created the
 * listing. The wait is the SNAPSHOT's reading at `nowMs`
 * (`estadoPublicacaoRascunhoShopee`), printed as an instant — the tab re-reads
 * the clock only when the reading changes.
 */
export function fraseDaPublicacaoSemRespostaShopee(
  publicacao: EstadoPublicacaoRascunhoShopee,
  nowMs: number,
): string {
  if (publicacao.tipo === 'em-andamento') {
    const ate = formatarInstanteShopee(nowMs + publicacao.aguardarMs);
    return (
      `A publicação pode não ter terminado — aguarde${ate === null ? '' : ` até ${ate}`} e ` +
      'confira o estado do rascunho antes de publicar de novo.'
    );
  }
  return 'A publicação pode não ter terminado — confira o estado do rascunho antes de publicar de novo.';
}

/** The 202's title: never "falhou". */
export const TITULO_ANUNCIO_INCERTO_SHOPEE = 'A Shopee pode ter criado o anúncio';

/**
 * The ordinary listing's **202** (`tipo: 'item-incerto'`): the first create's
 * outcome is unknown. The wait is the SNAPSHOT's reading (`publicacao`, at
 * `nowMs`) — never the 202's own `aguardarMs` nor the schemas' constant: the
 * route answers it even when re-arming the lock did not land (D-P11 #7).
 * `reenvioVerificaSku: false` ⇒ the SKU-first text (never "importe-o" alone).
 * Shopee's own answer (`recusa`) follows when it sent one.
 */
export function fraseDoAnuncioIncertoShopee(
  resposta: Pick<RespostaItemIncertoShopee, 'reenvioVerificaSku' | 'recusa'>,
  publicacao: EstadoPublicacaoRascunhoShopee,
  nowMs: number,
): string {
  let aguarde: string | null = null;
  if (publicacao.tipo === 'em-andamento') {
    const ate = formatarInstanteShopee(nowMs + publicacao.aguardarMs);
    aguarde = ate === null ? 'Aguarde' : `Aguarde até ${ate}`;
  }
  const partes: string[] = [];
  if (resposta.reenvioVerificaSku) {
    partes.push(
      'A Shopee pode ter criado o anúncio. ' +
        (aguarde === null ? 'Publique' : `${aguarde} e publique`) +
        ' de novo o mesmo rascunho: antes de criar, o ERP procura o anúncio pelo SKU enviado e ' +
        'o vincula se existir. Não mude o SKU do produto até lá.',
    );
  } else {
    partes.push(
      'A Shopee pode ter criado o anúncio, e ele foi enviado sem SKU: o ERP não consegue ' +
        `procurá-lo. ${aguarde === null ? 'Confira' : `${aguarde} e confira`} no Seller Centre. ` +
        'Se o anúncio existe: dê a ele, no Seller Centre, o MESMO SKU que você cadastrar neste ' +
        `produto e só então importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) — sem SKU a importação ` +
        'cria OUTRO produto. Se não existe: publique de novo, confirmando que você conferiu.',
    );
  }
  if (resposta.recusa !== null) {
    const { codigo, fraseShopee } = resposta.recusa;
    const frase = fraseShopee === null || fraseShopee.trim() === '' ? '' : ` — ${fraseShopee}`;
    partes.push(`A Shopee respondeu: ${codigo}${frase}.`);
  }
  return partes.join(' ');
}

/** A draft's Publicar answered 200. Never "criado": the 200 does not say whether it created. */
export const TITULO_RASCUNHO_PUBLICADO_SHOPEE = 'Rascunho publicado na Shopee';

/**
 * The 200 of a draft's Publicar (D-P11 #14). ⚠️ NOT proof of a create: a draft
 * that turned live meanwhile (another tab, the CLI) is republished — an
 * `update_item`, which sends no status — and an `incerta` draft may ADOPT the
 * listing its last attempt created. So it reports what Shopee READS, never
 * "criado", and never implies «Criar pausado» applied (`pausadoPedido`) unless
 * Shopee reads the listing as paused.
 */
export function fraseDoRascunhoPublicadoShopee(
  item: Pick<ItemPublicadoShopee, 'itemId' | 'estadoAnuncio'>,
  opcoes: { readonly pausadoPedido: boolean },
): string {
  const rotulo =
    item.estadoAnuncio === null ? null : ROTULO_ESTADO_ANUNCIO_SHOPEE[item.estadoAnuncio];
  const partes = [
    `Publicado na Shopee: anúncio ${String(item.itemId)}.`,
    rotulo === null
      ? 'O status na Shopee não pôde ser lido agora.'
      : `Status na Shopee: ${rotulo}.`,
  ];
  if (opcoes.pausadoPedido && item.estadoAnuncio !== ESTADO_ANUNCIO_SHOPEE.pausado) {
    partes.push(
      (rotulo === null
        ? '«Criar pausado» pode não ter se aplicado'
        : '«Criar pausado» não se aplicou') +
        ': se o anúncio já existia (publicado em outra aba, ou adotado de uma tentativa ' +
        'anterior), a publicação o atualizou sem mudar o status — confira e pause-o, se for o ' +
        'caso.',
    );
  }
  return partes.join(' ');
}

/* ---- The Seller-Centre attestation exits (`saidasDoProblemaShopee`) -------- */

/** `criacao-incerta-sem-sku`: the operator checked — nothing was created. */
export const ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE =
  'Conferi no Seller Centre: o anúncio não existe — publicar mesmo assim';

/** `criacao-incerta-ja-vinculada` (1): the linked listing IS the attempt's — this draft is the redundant half. */
export const ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE =
  'É o anúncio da tentativa — descartar este rascunho';

/** `criacao-incerta-ja-vinculada` (2), every candidate linked: the attested publish is a NEW create. */
export const ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE =
  'É um segundo anúncio, de propósito — publicar mesmo assim';

/**
 * `criacao-incerta-ja-vinculada` (2) with an UNLINKED candidate: the attested
 * publish ADOPTS it (it sends nothing) — never worded as "o anúncio não existe".
 */
export function rotuloDaPublicacaoQueAdotaShopee(itemIds: readonly number[]): string {
  return (
    `Publicar confirmando: o ERP adota o anúncio sem vínculo ${itemIds.map(String).join(', ')} ` +
    'como o desta tentativa — não cria outro'
  );
}

/** The discard exit's warning when an UNLINKED candidate stays on Shopee. */
export function avisoDoDescarteComAnuncioSemVinculoShopee(itemIds: readonly number[]): string {
  return (
    `O anúncio sem vínculo ${itemIds.map(String).join(', ')} continua na Shopee: se ele for ` +
    `deste produto, importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}).`
  );
}

/* ---- campo → surface buttons (`superficieDoCampoShopee`, DC §2.9) ---------- */

/** A Shopee BRAND refusal on a draft — never `marca-nao-escolhida`, whose copy already asks for one. */
export const FRASE_MARCA_PODE_NAO_VALER_SHOPEE =
  'A marca pode não valer para esta categoria: escolha outra ou «Sem marca».';

export const ROTULO_ABRIR_VARIACOES_SHOPEE = 'Abrir Variações';
export const ROTULO_ABRIR_TABELA_DE_MEDIDAS_SHOPEE = 'Abrir a tabela de medidas';
/** A published listing's own content: fixed in Seller Centre (text, no link — D8). */
export const FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE = 'Corrigir no Seller Centre';
