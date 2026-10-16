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
 */
import {
  FUSO_FISCAL,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  anuncioShopeeVivo,
  ehVinculoSubstituido,
  estadoAnuncioShopeeSchema,
  type EstadoAnuncioShopee,
  type TipoAcaoSugeridaPublicacaoShopee,
} from '@delfrance/schemas';

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
 * value that is not a positive safe integer. Display only: which links the
 * actions may address is the schemas' `podeMoverAnuncioShopee`.
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
 *  - WITH an `acao`: {@link TEXTO_ACAO_SUGERIDA} plus the ids the `acao` names.
 *    ⚠️ The server's `mensagem` is NEVER shown for such a row — it is the CLI's
 *    sentence, and the next step it describes is a button here.
 *  - Without one (the step-11 refusals, mechanism sentences): the `mensagem` —
 *    unless it reads as a terminal instruction, which becomes
 *    {@link FRASE_RECUSA_SEM_PASSO_SHOPEE}.
 */
export function textoDoProblemaShopee(p: Pick<ProblemaShopee, 'mensagem' | 'acao'>): string {
  const { acao } = p;
  if (acao === null) {
    return ehFraseDeTerminal(p.mensagem) ? FRASE_RECUSA_SEM_PASSO_SHOPEE : p.mensagem;
  }
  const base = TEXTO_ACAO_SUGERIDA[acao.tipo];
  switch (acao.tipo) {
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar:
      return `${base} Vínculo: ${acao.linkDocId}.`;
    case TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar:
      return acao.linkDocId === null
        ? `${base} ${FRASE_REPUBLICAR_SEM_VINCULO}`
        : `${base} Vínculo: ${acao.linkDocId}.`;
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
