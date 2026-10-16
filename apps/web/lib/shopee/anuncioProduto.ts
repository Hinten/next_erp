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
 */
import { z } from 'zod';
import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  FUSO_FISCAL,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  anuncioShopeeVivo,
  ehVinculoSubstituido,
  estadoAnuncioShopeeSchema,
  type AcaoSugeridaPublicacaoShopee,
  type EstadoAnuncioShopee,
  type TipoAcaoSugeridaPublicacaoShopee,
} from '@delfrance/schemas';

import {
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  ShopeeClientHttpError,
  type PublicarShopeeInput,
} from './client';
import type { ProblemaShopee, RespostaReverificarShopee } from './wire';

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
 * for a link this answers `null` for (`AcoesAnuncioShopee`, the refusal rows'
 * buttons, the pause confirmation — through `AcoesShopee.enderecavel`). It is
 * STRICTER than the schemas' `podeMoverAnuncioShopee` and `anuncioShopeeVivo`,
 * which test `isFinite` — a fraction (`1.5`) or an id past 2^53 passes them, and
 * no such number can address a Shopee listing. Those two stay as they are (they
 * are apps/shopee's batch filters) and decide, among ADDRESSABLE links, which
 * ones may move or be republished.
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
 * What a DRAFT link (`item_id: null`) shows where "Publicar" would be. A first
 * publish is NOT offered in step 21: the item arm has no duplicate guard (its
 * first write-back lands only after `add_item` answers), so a network error on
 * one would invite a second listing — and the draft link itself belongs to the
 * listing-authoring step that follows (#1911).
 */
export const FRASE_PRIMEIRA_PUBLICACAO_SHOPEE =
  'Primeira publicação: chega na etapa de autoria do anúncio.';

/**
 * What a link whose stored `item_id` is present but addresses no listing (`0`, a
 * negative, a fraction, past 2^53, a quoted number — a malformed or migrated
 * row) shows where its buttons would be. ⚠️ Never
 * {@link FRASE_PRIMEIRA_PUBLICACAO_SHOPEE}: the link is not a draft, so a first
 * publish is not what it is waiting for.
 */
export const FRASE_ITEM_ID_INVALIDO_SHOPEE =
  'O código do anúncio guardado neste vínculo é inválido — nenhuma ação disponível.';

/** The `importar` row's first half: what was found. */
const FRASE_KIT_JA_EXISTE_SHOPEE =
  'Já existe na Shopee um kit com o SKU deste produto — não crie outro.';

/** The `importar` row's second half: the one door for a hit NO link holds (see below). */
const FRASE_IMPORTACAO_EM_MASSA_SHOPEE =
  'A importação em massa (Canais › Shopee) o vincula a este produto se ele ainda não estiver ' +
  'vinculado a nenhum produto, se nenhum outro produto tiver o mesmo SKU e se os componentes do ' +
  'kit já estiverem vinculados no ERP; um kit já vinculado a outro produto continua onde está.';

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
 * name, or the word "comando". The server-side pin (`exigirAcaoSeHaComando` in
 * the kit suites) guarantees such a refusal also carries an `acao`; this is the
 * browser's own backstop for one that does not (the `instabilidade-shopee`
 * refusal tells the CLI to run "o mesmo comando" again).
 */
const FRASE_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio\b|\bcomandos?\b/i;

/** Whether `texto` is CLI copy the tab must not show (see {@link FRASE_DE_TERMINAL}). */
export function ehFraseDeTerminal(texto: string): boolean {
  return FRASE_DE_TERMINAL.test(texto);
}

/** What stands in for a refusal sentence written for the terminal. */
export const FRASE_RECUSA_SEM_PASSO_SHOPEE =
  'Esta recusa não traz um próximo passo que a aba ofereça. Use "Reverificar" para ler o ' +
  'anúncio na Shopee antes de publicar de novo.';

/**
 * The operator copy of ONE refusal row of a 422.
 *
 *  - A `motivo` the tab words itself ({@link TEXTO_MOTIVO_KIT}) reads that copy
 *    first — with or without an `acao`; the `acao`'s ids still follow it.
 *  - WITH an `acao`: {@link TEXTO_ACAO_SUGERIDA} plus the ids the `acao` names.
 *    ⚠️ The server's `mensagem` is NEVER shown for such a row — it is the CLI's
 *    sentence, and the next step it describes is a button here.
 *  - Without one (the step-11 refusals, mechanism sentences): the `mensagem` —
 *    unless it reads as a terminal instruction, which becomes
 *    {@link FRASE_RECUSA_SEM_PASSO_SHOPEE}.
 *
 * `motivo` is optional only so a caller holding a bare `{ mensagem, acao }`
 * still compiles; every 422 row carries one. `linkDoBloco` is the link the row
 * is SHOWN under: a `vinculo-substituido` row about another link is worded as
 * such ({@link vinculoSubstituidoAlheio}).
 */
export function textoDoProblemaShopee(
  p: Pick<ProblemaShopee, 'mensagem' | 'acao'> & { readonly motivo?: string },
  linkDoBloco?: string,
): string {
  const { acao } = p;
  const doMotivo = p.motivo === undefined ? null : textoProprio(TEXTO_MOTIVO_KIT, p.motivo);
  if (acao === null) {
    if (doMotivo !== null) return doMotivo;
    return ehFraseDeTerminal(p.mensagem) ? FRASE_RECUSA_SEM_PASSO_SHOPEE : p.mensagem;
  }
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
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar:
      return textoDoImportar(acao.itemIds, acao.vinculados);
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
 * The sentence a mid-publish refusal opens with: where it landed
 * ({@link ROTULO_ETAPA_PUBLICACAO_SHOPEE}, an own-property lookup with a neutral
 * fallback), and the caution the CLI gives for the same case — earlier writes
 * may have landed, so the listing is read back before anything is repeated.
 */
export function textoDaEtapaShopee(etapa: string): string {
  const rotulo =
    (Object.hasOwn(ROTULO_ETAPA_PUBLICACAO_SHOPEE, etapa)
      ? ROTULO_ETAPA_PUBLICACAO_SHOPEE[etapa]
      : undefined) ?? ROTULO_ETAPA_DESCONHECIDA_SHOPEE;
  return (
    `Recusada na etapa: ${rotulo}. Escritas anteriores podem já ter chegado à Shopee — use ` +
    '"Reverificar" antes de repetir.'
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
 * the server's mechanism sentence there, so it is not in this map.
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
