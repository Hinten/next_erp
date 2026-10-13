/**
 * The native-kit RECRIAR and CONVERTER appliers (step 19, #1527 — reconcile
 * §2.7, §2.5.4 R0–R5 / V0–V3, Lucas L4(4), L8, L9).
 *
 * Shopee refuses a recipe change on a live kit (a quantity change answers 200
 * and is silently ignored, P2-c), so a new recipe means a NEW kit. Both arms
 * here are ENSURE sequences (L9) built from PR 5's `garantirKitNovo` +
 * `completarKit`: neither stores anything about its own progress — each step
 * reads whether its fact already holds and does only what is missing, so a
 * re-run of the SAME command converges (a recriar always names its target,
 * R-a, so the re-run is literally the same flags).
 *
 * ## recriar — "create the NEW kit FIRST, then delete the old" (L4(4))
 *
 * | step | what it does |
 * |---|---|
 * | (−) | the scan's verdict FIRST: `recusar` ⇒ refused before anything else, so an unlinked same-SKU twin is always named (V2R1-01) |
 * | 0 | the SAFETY NET (R-m): a LIVE target whose shape, recipe and main already equal the ERP's ⇒ `recriacao-sem-diferenca`, zero Shopee writes (the aviso decision still runs). Skipped on a removed or superseded target, and on a resume (another live native link of K exists, S2C-05) |
 * | 1 | ensure the new kit (`garantirKitNovo`, the target's `item_id` excluded from the scan): create, or complete the one already linked, or refuse ("importe-o" / the list). `incerto` ⇒ the 202 at once — nothing below runs (V2R2-04) |
 * | 2 | the DELETE GATE, only while the target still exists: the new kit reads `NORMAL`/`UNLIST` (`NORMAL` when the target reads `NORMAL` — a paused kit never replaces one on sale), carries the ERP composition, carries the named `--principal` (the COMPLETED kit's read-back main, never the target's — V2R3-01) and is NEWER than the target by `create_time`. Any miss ⇒ a warning and STOP: the old kit is left untouched |
 * | 3 | ensure the old kit is gone: deleted already ⇒ no call, the link written `removido`; `NORMAL`/`UNLIST` ⇒ `delete_item`, then a re-read — deleted ⇒ `removido`, anything else ⇒ SUPERSEDED by the new link + `kit-antigo-nao-excluido`; `BANNED`/`REVIEWING` is never sent a delete ⇒ superseded + warning |
 * | 4 | `reavaliarAvisoDeReceitaKit(…, 'kit-recriado')` — after every stamp |
 *
 * ⚠️ The old `variashopee` rows are LEFT AS THEY ARE: old orders still bind on
 * them (rung 1 has no `modeloAusenteEm` filter) and the per-listing model sync
 * never marks them from the new kit's reading.
 *
 * ## converter — "converter em kit nativo" (L8)
 *
 * (1) ensure the new kit (nothing excluded: the ordinary listing is not a kit
 * row); (2) `carimbarSubstituicao(ordinary → new)`; (3) the aviso decision.
 * NOTHING is sent to the old listing — no write, no read: it keeps its stock
 * and price from steps 12/13 until Lucas deletes it in Seller Centre and a
 * re-verify folds it to `removido` (R-12). No liveness gate: nothing
 * destructive happens to it.
 *
 * ## Write tiers (rule 7)
 *
 * No transaction anywhere in this folder (the inventory greps the bare word).
 * Every Firestore write is `vinculosKit.ts`'s: the old link's read-back is a
 * plain `merge` of what was just READ; the superseded pointer a flat `merge`
 * of two scalars that a re-run re-writes identically. `delete_item` is sent
 * only to an old kit that READS live, and its ack is never trusted — only a
 * re-read decides. The accepted residual is R-w (register 303).
 *
 * Next-free and clock-free: `deps.nowMs` is the one clock; the aviso's µs comes
 * from `avisos/autorizacao.ts`'s `agoraUsDe`.
 */
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  SHOPEE_ITEM_STATUS_WIRE,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  type ShopeeKitItem,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  ehVinculoSubstituido,
  mesmaReceitaKitShopee,
  mesmoEnderecoDeComponente,
  principalDoKitShopee,
  type EnderecoShopeeDoComponente,
} from '@delfrance/schemas';

import {
  ETAPA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  limitarMensagemProblema,
  type ProblemaDeBloqueio,
} from '../anuncios/errosPublicacao';
import { agoraUsDe } from '../avisos/autorizacao';
import { ehKitDe, type ItemLido } from '../produtos/itemLido';
import { itensDosComponentesDoKit } from '../produtos/temModelosDosComponentes';
import {
  garantirKitNovo,
  ligarModelosDoKit,
  linhasLidasDoModeloKit,
  type GarantiaCumprida,
} from './aplicarKit';
import { STATUS_KIT_VIVO } from './constantesKit';
import { kitVivoRemovido, vinculosNativosDoKit, type PlanoKit } from './planoKit';
import { lerKitVivo } from './prepararKit';
import { avisoPrincipalDiferente } from './republicarKit';
import {
  comandoDeRetomada,
  type AvisoKit,
  type ContextoKit,
  type KitDeps,
  type ResultadoPublicacaoKit,
} from './resultadoKit';
import { carimbarSubstituicao, escreverLeituraDoKit } from './vinculosKit';

/* -------------------------------------------------------------------------- */
/*                         The sentences (pt-BR, ids only)                     */
/* -------------------------------------------------------------------------- */

/** `recriacao-sem-diferenca` (§2.5.2) — the safety net's refusal. */
export function problemaRecriacaoSemDiferenca(itemId: number): ProblemaDeBloqueio {
  return {
    campo: 'recriar',
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.recriacaoSemDiferenca,
    mensagem: limitarMensagemProblema(
      `o kit ${String(itemId)} na Shopee já tem a composição do ERP e o mesmo componente ` +
        'principal — não há o que recriar; publique sem --recriar (para trocar o principal, ' +
        'informe --principal)',
    ),
  };
}

/**
 * `kit-novo-inativo` — the new kit is not live yet, so the old one waits. Every
 * sentence names the new kit's LINK, not only its `item_id`.
 *
 * ⚠️ `UNLIST` gets its own sentence (PR #1868 review): it reaches gate (a) only
 * beside an old kit on sale (H1), and NOTHING on a re-run relists — `--status`
 * is read by a create alone and the completion sends no status write — so
 * "publish again" by itself would answer this same warning forever. The
 * operator relists the NEW link first, BY ITS DOC ID: until step 3 runs both
 * kits are active native links, and `anuncio-status` without a `linkDocId`
 * takes the lexically-first one, which may be the old kit — and the route
 * accepts a `linkDocId` only beside exactly ONE produtoId, the kit's.
 *
 * ⚠️ `BANNED` gets its own sentence too: waiting never lifts a ban, so "publish
 * again later" would be the same loop. The operator corrects the violation in
 * Seller Centre and waits for the new review (`pausarAnuncio.ts`'s
 * `anuncio-banido` remedy) — never a relist, which Shopee refuses on a banned
 * kit. Every other status (`REVIEWING`, an unreadable one) is Shopee's to
 * change, so it keeps "the same command, later".
 */
export function avisoKitNovoInativo(a: {
  readonly produtoId: string;
  readonly itemId: number;
  readonly itemStatus: string | null;
  readonly novoLinkDocId: string;
  readonly antecessorItemId: number;
  readonly antigoLinkDocId: string;
}): AvisoKit {
  const cabeca =
    `o kit novo ${String(a.itemId)} (vínculo ${a.novoLinkDocId}) está ` +
    `${a.itemStatus ?? '—'} na Shopee; o kit antigo ${String(a.antecessorItemId)} só é ` +
    'excluído quando o novo estiver ';
  const repetir = `publique de novo com --link ${a.antigoLinkDocId} --recriar`;
  let fim = `ativo — ${repetir} depois`;
  if (a.itemStatus === SHOPEE_ITEM_STATUS_WIRE.unlist) {
    fim =
      'à venda, e publicar de novo NÃO reativa o novo — reative-o primeiro (anuncio-status ' +
      `com acao reativar, produtoIds [${a.produtoId}] e linkDocId ${a.novoLinkDocId}, ou no ` +
      `Seller Centre) e só então ${repetir}`;
  } else if (a.itemStatus === SHOPEE_ITEM_STATUS_WIRE.banned) {
    fim =
      'ativo, e um kit banido não volta sozinho — corrija a violação do novo no Seller ' +
      `Centre, aguarde a nova revisão e só então ${repetir}`;
  }
  return { codigo: 'kit-novo-inativo', produtoId: a.produtoId, mensagem: cabeca + fim };
}

/** `kit-novo-divergente` (S2C-05) — the completed kit does not carry the ERP composition. */
export function avisoKitNovoDivergente(a: {
  readonly produtoId: string;
  readonly itemId: number;
  readonly motivo: string;
  readonly antecessorItemId: number;
  readonly novoLinkDocId: string;
}): AvisoKit {
  return {
    codigo: 'kit-novo-divergente',
    produtoId: a.produtoId,
    mensagem:
      `o kit ${String(a.itemId)} não está igual à composição do ERP (${a.motivo}); o kit ` +
      `${String(a.antecessorItemId)} não foi excluído — se faltar variação, publique com ` +
      `--link ${a.novoLinkDocId} para anexá-la e rode de novo; se a composição mudou depois, ` +
      'exclua um dos dois no Seller Centre e rode reverificar:anuncio',
  };
}

/**
 * `kit-alvo-mais-novo` (V2R1-02) — the target is not OLDER than the kit that
 * would replace it, so the delete would destroy the newer one. With both
 * `create_time`s readable and the completed kit strictly older, it names that
 * kit's link as the one to pass; otherwise it cannot tell which is older.
 */
export function avisoKitAlvoMaisNovo(a: {
  readonly produtoId: string;
  readonly alvoItemId: number;
  readonly alvoLinkDocId: string;
  readonly itemId: number;
  readonly linkDocId: string;
  /** `'mais-antigo'` = the completed kit is strictly older; `'igual'`; `'ilegivel'` = a `null` stamp. */
  readonly comparacao: 'mais-antigo' | 'igual' | 'ilegivel';
}): AvisoKit {
  const cabeca =
    `o kit ${String(a.alvoItemId)} (--link ${a.alvoLinkDocId}) não é mais antigo que o kit ` +
    `${String(a.itemId)} que o substituiria — nada foi excluído; `;
  let mensagem: string;
  switch (a.comparacao) {
    case 'mais-antigo':
      mensagem =
        cabeca + `o kit antigo é o ${String(a.itemId)}: rode com --link ${a.linkDocId} --recriar`;
      break;
    case 'igual':
      mensagem = cabeca + 'confira qual é o kit antigo e rode com --link <ele> --recriar';
      break;
    case 'ilegivel':
      mensagem =
        'não foi possível comparar as datas de criação — nada foi excluído; confira qual é o ' +
        'kit antigo e rode com --link <ele> --recriar';
      break;
  }
  return { codigo: 'kit-alvo-mais-novo', produtoId: a.produtoId, mensagem };
}

/** `kit-antigo-nao-excluido` (S2C-03) — the delete did not take; the old kit is superseded. */
export function avisoKitAntigoNaoExcluido(a: {
  readonly produtoId: string;
  readonly itemId: number;
  readonly linkDocId: string;
}): AvisoKit {
  return {
    codigo: 'kit-antigo-nao-excluido',
    produtoId: a.produtoId,
    mensagem:
      `o kit novo foi criado, mas o antigo ${String(a.itemId)} não foi excluído na Shopee — ` +
      `exclua-o no Seller Centre e depois rode reverificar:anuncio --link ${a.linkDocId} (ou ` +
      `publique com --link ${a.linkDocId} --recriar para tentar de novo); enquanto existir, ` +
      'ele continua vendendo com a composição ANTIGA, então o estoque que a Shopee mostra nele ' +
      'pode ser maior do que o ERP consome — o aviso de composição fica aberto até ele sair',
  };
}

/* -------------------------------------------------------------------------- */
/*                               Small readers                                 */
/* -------------------------------------------------------------------------- */

const VIVOS: ReadonlySet<string> = new Set<string>(STATUS_KIT_VIVO);

function itemIdEnderecavel(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/** UTF-16 code-unit order — never `localeCompare`. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The ONE tier's option texts, by index; `[]` when the kit page carries none. */
function opcoesDoTier(kit: ShopeeKitItem): (string | null)[] {
  const tier = kit.tier_variation_list?.[0];
  return tier === undefined ? [] : tier.option_list.map((o) => o.option ?? null);
}

/** A kit page's main, through the schemas fold (L1: read back, never stored). */
function principalDoKit(
  kit: ShopeeKitItem | null,
  temModelos: ReadonlyMap<number, boolean>,
): EnderecoShopeeDoComponente | null {
  if (kit === null) return null;
  return principalDoKitShopee(kit.model_list.map(linhasLidasDoModeloKit), temModelos);
}

/**
 * A component address for a sentence (or for the re-run command): the
 * lexically-first ERP component that resolves to it, else its Shopee address.
 */
function rotuloDoEndereco(ctx: ContextoKit, endereco: EnderecoShopeeDoComponente): string {
  return idDoComponente(ctx, endereco) ?? enderecoEmTexto(endereco);
}

function idDoComponente(ctx: ContextoKit, endereco: EnderecoShopeeDoComponente): string | null {
  const ids = [...ctx.resolucao]
    .filter(([, r]) => r.ok && mesmoEnderecoDeComponente(r.endereco, endereco))
    .map(([id]) => id)
    .sort(compararTexto);
  return ids[0] ?? null;
}

function enderecoEmTexto(endereco: EnderecoShopeeDoComponente): string {
  return endereco.modelId === null
    ? `item ${String(endereco.itemId)}`
    : `item ${String(endereco.itemId)} modelo ${String(endereco.modelId)}`;
}

/**
 * Shopee calls one `lerAnuncioShopee` of a KIT spends, per CALL: one
 * `get_item_base_info`, then `get_kit_item_info` plus one batched
 * `get_item_base_info` per 50 distinct component items (`aplicarKit.ts`'s
 * completion counts its read-back the same way). An absent row costs the one.
 */
function chamadasDaLeituraDoKit(item: ItemLido | null): number {
  if (item === null || !ehKitDe(item.base) || item.kit === null) return 1;
  const distintos = new Set(
    itensDosComponentesDoKit(item.kit).filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  return 2 + Math.ceil(distintos.size / SHOPEE_ITEM_BASE_INFO_MAX_IDS);
}

/* -------------------------------------------------------------------------- */
/*                     Step 0 — nothing to recreate? (pure)                    */
/* -------------------------------------------------------------------------- */

/**
 * The safety net's question (R-m), PURE: does the LIVE target `vivo` already
 * carry everything a recriar would create? Binding is §2.6's (rows of the
 * target first, then option text, then SKU — never a recomputed tier
 * position). True ⇔ every live model is bound, every ERP child is bound, every
 * bound pair folds EQUAL (`mesmaReceitaKitShopee` over a COMPLETE projection,
 * main aside), and the named `--principal` is absent or IS the live main.
 *
 * ⚠️ A child whose projection is incomplete is never "equal": a recipe that
 * cannot be resolved is not proof the kit already matches.
 *
 * ⚠️ Nor is an EMPTY binding: with no live model and no ERP child every "for
 * all" above holds vacuously, so `ligacoes.length === 0` answers `false`. No
 * run reaches it today (an ERP kit always has a child, so an empty live kit
 * already fails on `filhosSemModelo`); a unit test pins it (R6-M13 / RK13).
 */
export function nadaARecriar(ctx: ContextoKit, plano: PlanoKit, vivo: ShopeeKitItem): boolean {
  const { ligacoes, filhosSemModelo } = ligarModelosDoKit({
    modelos: vivo.model_list,
    opcoes: opcoesDoTier(vivo),
    filhos: ctx.filhos,
    familiaDeUm: ctx.familiaDeUm,
    linhasDoLink: ctx.linhasDoAnuncio,
    ligacao: 'opcao',
    tierPorFilho: new Map<string, number>(),
  });
  if (filhosSemModelo.length > 0 || ligacoes.length === 0) return false;
  for (const { modelo, filhoId } of ligacoes) {
    if (filhoId === null) return false;
    const projecao = plano.modelos.find((m) => m.filhoId === filhoId);
    if (projecao === undefined || !projecao.projecaoCompleta) return false;
    if (!mesmaReceitaKitShopee(projecao.linhas, linhasLidasDoModeloKit(modelo), ctx.temModelos)) {
      return false;
    }
  }
  if (ctx.principalPedido !== null) {
    const principalVivo = principalDoKit(vivo, ctx.temModelos);
    if (principalVivo === null || !mesmoEnderecoDeComponente(ctx.principalPedido, principalVivo)) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*                          Step 2 — the delete gate                           */
/* -------------------------------------------------------------------------- */

/** The completion's warnings that say the new kit does NOT carry the ERP composition. */
const CODIGOS_DE_DIVERGENCIA: ReadonlySet<AvisoKit['codigo']> = new Set<AvisoKit['codigo']>([
  'receita-divergente',
  'variacao-nao-anexada',
  'modelo-sem-filho',
  'receita-nao-publicavel',
]);

/**
 * Why the COMPLETED new kit is not the ERP composition, as a short list for the
 * `kit-novo-divergente` sentence (`codigo (produto)`), or `null` when it is.
 * The completion already bound and folded every live model against the plan's
 * projection: a `receita-divergente`, a `variacao-nao-anexada`, a
 * `modelo-sem-filho` or a `receita-nao-publicavel` (a recipe that could not be
 * projected at all) each means "not proved equal".
 *
 * ⚠️ The second loop (an incomplete projection with no matching warning) is a
 * BACKSTOP no run reaches today: a create arm refuses an empty recipe in phase
 * A, and the plan turns every unresolved component of a resume into
 * `receita-nao-publicavel`. It stays because this answer gates a `delete_item`;
 * it is exported so its unit test can pin it directly (R6-M06).
 */
export function divergenciaDoKitNovo(
  garantia: Pick<GarantiaCumprida, 'avisos'>,
  plano: Pick<PlanoKit, 'modelos'>,
): string | null {
  const partes: string[] = [];
  for (const aviso of garantia.avisos) {
    if (!CODIGOS_DE_DIVERGENCIA.has(aviso.codigo)) continue;
    const parte = aviso.produtoId === null ? aviso.codigo : `${aviso.codigo} ${aviso.produtoId}`;
    if (!partes.includes(parte)) partes.push(parte);
  }
  for (const modelo of plano.modelos) {
    if (modelo.projecaoCompleta) continue;
    const parte = `receita-nao-publicavel ${modelo.filhoId}`;
    if (!partes.includes(parte)) partes.push(parte);
  }
  return partes.length === 0 ? null : partes.join(', ');
}

/** What the delete gate decided: proceed, or the warnings that stopped it. */
interface PortaoDeExclusao {
  readonly passa: boolean;
  readonly avisos: readonly AvisoKit[];
}

/**
 * Step 2 (R-m, V2R1-02, V2R3-01): may the OLD kit be deleted (or superseded)?
 * Only when the NEW kit reads live (`NORMAL` whenever the old one reads
 * `NORMAL`: `--recriar --status UNLIST` must never leave nothing on sale),
 * carries the ERP composition, carries the
 * named `--principal` (compared with the COMPLETED kit's read-back main, never
 * the target's) and is strictly NEWER than the target by `create_time`.
 * Every miss is a warning; ANY miss stops the run before step 3.
 */
function portaoDeExclusao(
  ctx: ContextoKit,
  plano: PlanoKit,
  garantia: GarantiaCumprida,
  alvo: { readonly itemId: number; readonly linkDocId: string },
): PortaoDeExclusao {
  const kitId = ctx.produto.id;
  const leitura = garantia.leitura;
  const itemId = garantia.itemId;
  const linkDocId = garantia.linkDocId;
  if (leitura === null || itemId === null || linkDocId === null) {
    throw new Error('[shopee/kits] portão de exclusão sem a leitura de volta do kit novo');
  }
  const avisos: AvisoKit[] = [];

  // (a) the new kit is LIVE — and never a PAUSED kit standing in for a kit on
  // sale: when the old kit reads `NORMAL` the new one must read `NORMAL` too,
  // or `--recriar --status UNLIST` would delete the only kit selling (H1).
  // An old kit that is itself `UNLIST` may be replaced by a paused one.
  const status = leitura.base.item_status ?? null;
  const antigoAVenda = ctx.vivo?.status === SHOPEE_ITEM_STATUS_WIRE.normal;
  if (
    status === null ||
    !VIVOS.has(status) ||
    (antigoAVenda && status !== SHOPEE_ITEM_STATUS_WIRE.normal)
  ) {
    avisos.push(
      avisoKitNovoInativo({
        produtoId: kitId,
        itemId,
        itemStatus: status,
        novoLinkDocId: linkDocId,
        antecessorItemId: alvo.itemId,
        antigoLinkDocId: alvo.linkDocId,
      }),
    );
  }

  // (b) the new kit carries the ERP composition (S2C-05).
  const divergencia = divergenciaDoKitNovo(garantia, plano);
  if (divergencia !== null) {
    avisos.push(
      avisoKitNovoDivergente({
        produtoId: kitId,
        itemId,
        motivo: divergencia,
        antecessorItemId: alvo.itemId,
        novoLinkDocId: linkDocId,
      }),
    );
  }

  // (c) the named main IS the completed kit's (the fold ignores the main).
  if (ctx.principalPedido !== null) {
    const principalNovo = principalDoKit(leitura.kit, ctx.temModelos);
    if (principalNovo === null || !mesmoEnderecoDeComponente(ctx.principalPedido, principalNovo)) {
      avisos.push(
        avisoPrincipalDiferente({
          produtoId: kitId,
          itemId,
          linkDocId,
          pedido: rotuloDoEndereco(ctx, ctx.principalPedido),
          vivo: principalNovo === null ? '—' : rotuloDoEndereco(ctx, principalNovo),
        }),
      );
    }
  }

  // (d) the completed kit is NEWER than the target (seconds; V2R1-02).
  const criadoNovo = leitura.base.create_time ?? null;
  const criadoAlvo = ctx.vivo?.criadoEm ?? null;
  if (criadoNovo === null || criadoAlvo === null || criadoNovo <= criadoAlvo) {
    avisos.push(
      avisoKitAlvoMaisNovo({
        produtoId: kitId,
        alvoItemId: alvo.itemId,
        alvoLinkDocId: alvo.linkDocId,
        itemId,
        linkDocId,
        comparacao:
          criadoNovo === null || criadoAlvo === null
            ? 'ilegivel'
            : criadoNovo === criadoAlvo
              ? 'igual'
              : 'mais-antigo',
      }),
    );
  }

  return { passa: avisos.length === 0, avisos };
}

/* -------------------------------------------------------------------------- */
/*                     Step 3 — ensure the old kit is gone                     */
/* -------------------------------------------------------------------------- */

/** What step 3 did to the old kit. */
interface DesfechoDoAntigo {
  readonly excluido: boolean;
  readonly substituido: boolean;
  readonly avisos: readonly AvisoKit[];
  readonly chamadasShopee: number;
}

/**
 * Step 3 (R-m): ensure the OLD kit is gone, deciding on the target's read this
 * run already holds (`ctx.vivo`):
 *
 * - it reads deleted (a `SELLER_DELETE` still served, or no row at all — a
 *   purged kit, S2C-07) ⇒ NO call; the old link is written `removido`
 *   (status-only: nothing else was read about it);
 * - `NORMAL`/`UNLIST` ⇒ `delete_item`, its ack NEVER trusted: a failure of the
 *   package's `ShopeeError` family is caught (our own config guard rethrown),
 *   and a re-read through `prepararKit`'s adapter decides. Deleted ⇒ the full
 *   read is written as #2 (`SELLER_DELETE` ⇒ `removido`; a timed-out delete
 *   Shopee executed is this success path); still there ⇒ superseded + warning;
 * - anything else (`BANNED`, `REVIEWING`) is never sent a delete ⇒ superseded
 *   + `kit-antigo-nao-excluido`: it may still be selling the OLD composition.
 */
async function garantirAntigoExcluido(
  deps: KitDeps,
  ctx: ContextoKit,
  alvo: { readonly itemId: number; readonly linkDocId: string },
  novoLinkDocId: string,
): Promise<DesfechoDoAntigo> {
  const kitId = ctx.produto.id;
  const vivo = ctx.vivo;
  if (vivo === null) {
    throw new Error('[shopee/kits] passo 3 da recriação sem a leitura do kit antigo');
  }

  if (kitVivoRemovido(vivo, deps.nowMs)) {
    await escreverLeituraDoKit(deps, {
      produtoId: kitId,
      linkDocId: alvo.linkDocId,
      leitura: { kind: 'status', itemStatus: vivo.status },
    });
    return { excluido: true, substituido: false, avisos: [], chamadasShopee: 0 };
  }

  let chamadasShopee = 0;
  if (vivo.status !== null && VIVOS.has(vivo.status)) {
    chamadasShopee += 1;
    try {
      await deps.client.deleteItem({ item_id: alvo.itemId });
    } catch (err) {
      // Rule 6: the package's family only — our own misconfiguration is not
      // Shopee's answer, and a non-Shopee throw is our bug. Whatever Shopee
      // said, the re-read below decides (a delete can land behind a timeout).
      if (!(err instanceof ShopeeError) || err instanceof ShopeeConfigError) throw err;
      const api = err instanceof ShopeeApiError ? err : null;
      console.warn('[shopee/kits] delete_item do kit antigo falhou; a releitura decide', {
        integracaoId: ctx.integracaoId,
        produtoId: kitId,
        etapa: ETAPA_PUBLICACAO.deleteItem,
        itemId: alvo.itemId,
        erro: err.name,
        codigo: api?.code ?? null,
        requestId: api?.requestId ?? null,
      });
    }
    const releitura = await lerKitVivo(deps.client, alvo.itemId);
    chamadasShopee += chamadasDaLeituraDoKit(releitura.item);
    if (kitVivoRemovido(releitura.vivo, deps.nowMs)) {
      await escreverLeituraDoKit(deps, {
        produtoId: kitId,
        linkDocId: alvo.linkDocId,
        leitura:
          releitura.item === null
            ? { kind: 'status', itemStatus: null }
            : { kind: 'item', item: releitura.item },
      });
      return { excluido: true, substituido: false, avisos: [], chamadasShopee };
    }
  }

  // The delete did not take, or the old kit is in a state that is never sent
  // one: it stays live, SUPERSEDED by the new link so publish targets the new
  // kit (L9), and the operator is told it still sells the OLD composition.
  await carimbarSubstituicao(deps.db, kitId, alvo.linkDocId, {
    substituidoPorLinkDocId: novoLinkDocId,
    substituidoEm: deps.nowMs,
  });
  return {
    excluido: false,
    substituido: true,
    avisos: [
      avisoKitAntigoNaoExcluido({
        produtoId: kitId,
        itemId: alvo.itemId,
        linkDocId: alvo.linkDocId,
      }),
    ],
    chamadasShopee,
  };
}

/* -------------------------------------------------------------------------- */
/*                         The shared tails of both arms                       */
/* -------------------------------------------------------------------------- */

/** The target link of a PR 6 arm, with its addressable `item_id` — or a defect. */
function alvoDoBraco(ctx: ContextoKit, arma: 'kit-recriar' | 'kit-converter') {
  const alvo = ctx.alvo;
  if (ctx.arma.arma !== arma || alvo === null) {
    throw new Error(`[shopee/kits] ${arma} fora do seu braço (sem vínculo-alvo)`);
  }
  return { linkDocId: alvo.linkDocId, raw: alvo.raw, itemId: itemIdEnderecavel(alvo.raw.item_id) };
}

/**
 * The `--principal` produtoId to print in the re-run command — the context
 * holds it RESOLVED, so it is mapped back to the lexically-first component
 * resolving to that one Shopee address (any of them names the same principal).
 */
function idDoPrincipalPedido(ctx: ContextoKit): string | null {
  return ctx.principalPedido === null ? null : idDoComponente(ctx, ctx.principalPedido);
}

/** The 202 shape of an `incerto` create (V2R2-04): `recusa` + `comando`, ids `null`, nothing written. */
function resultadoIncerto(
  ctx: ContextoKit,
  arma: 'kit-recriar' | 'kit-converter',
  linkDocIdDoComando: string,
  garantia: GarantiaCumprida,
): ResultadoPublicacaoKit {
  return {
    arma,
    desfecho: 'incerto',
    produtoId: ctx.produto.id,
    itemId: null,
    linkDocId: null,
    estadoAnuncio: null,
    itemStatus: null,
    kitNativo: null,
    modelos: garantia.modelos,
    antecessor: null,
    avisos: garantia.avisos,
    avisosResolvidos: 0,
    chamadasShopee: (ctx.busca?.chamadas ?? 0) + garantia.chamadasShopee,
    recusa: garantia.recusa,
    comando: comandoDeRetomada(arma, {
      integracaoId: ctx.integracaoId,
      produtoId: ctx.produto.id,
      linkDocId: linkDocIdDoComando,
      // The id the operator TYPED (OP-8) and the `--status` asked (OP-9), so
      // the re-run is literally the same command — `criarKit`'s rule.
      principal: ctx.principalSolicitado ?? idDoPrincipalPedido(ctx),
      ...(ctx.statusPedido === undefined ? {} : { status: ctx.statusPedido }),
    }),
  };
}

/** Step 4 of both arms — the ONE aviso decision, after every stamp. */
async function reavaliar(
  deps: KitDeps,
  ctx: ContextoKit,
): Promise<Awaited<ReturnType<typeof reavaliarAvisoDeReceitaKit>>> {
  return await reavaliarAvisoDeReceitaKit(
    deps.db,
    { integracaoId: ctx.integracaoId, kitProdutoId: ctx.produto.id },
    MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
    { agoraUs: agoraUsDe({ nowMs: deps.nowMs }), increment: deps.increment },
  );
}

/** ONE line per run: ids, counts and enum tokens only. */
function registrar(r: ResultadoPublicacaoKit): void {
  // eslint-disable-next-line no-console -- expected on every recriar/converter; a warn nobody can act on is what hides the real ones
  console.info('[shopee/kits] kit nativo recriado/convertido', {
    arma: r.arma,
    produtoId: r.produtoId,
    desfecho: r.desfecho,
    itemId: r.itemId,
    linkDocId: r.linkDocId,
    antecessor: r.antecessor,
    estadoAnuncio: r.estadoAnuncio,
    modelos: r.modelos,
    avisos: r.avisos.map((a) => a.codigo),
    avisosResolvidos: r.avisosResolvidos,
    chamadasShopee: r.chamadasShopee,
    recusa: r.recusa === null ? null : { codigo: r.recusa.codigo, motivo: r.recusa.motivo },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 recriarKit                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `kit-recriar` applier (§2.7) — see the module docblock's table.
 *
 * @throws ShopeePublishBlockedError on the scan's verdict, on the safety net
 *   (`recriacao-sem-diferenca`) or on any plan refusal — before any Shopee write.
 */
export async function recriarKit(
  deps: KitDeps,
  ctx: ContextoKit,
  plano: PlanoKit,
): Promise<ResultadoPublicacaoKit> {
  const alvo = alvoDoBraco(ctx, 'kit-recriar');
  const kitId = ctx.produto.id;
  if (alvo.itemId === null) {
    // `escreverVinculoDoKit` always writes the `item_id` it was handed, and the
    // scan's exclusion needs it: no writer produces a native link without one.
    throw new Error(`[shopee/kits] o vínculo-alvo ${alvo.linkDocId} não tem item_id legível`);
  }
  const alvoItem = { itemId: alvo.itemId, linkDocId: alvo.linkDocId };
  const linkRemovido = alvo.raw.estadoAnuncio === ESTADO_ANUNCIO_SHOPEE.removido;
  const vivo = ctx.vivo;
  // The target still EXISTS on Shopee: its link is not `removido` and this
  // run's read of it is not a deleted status or an absent row (S2C-07).
  const alvoExiste = !linkRemovido && vivo !== null && !kitVivoRemovido(vivo, deps.nowMs);
  const alvoVivo = alvoExiste && vivo.status !== null && VIVOS.has(vivo.status);
  if (alvoVivo && vivo.kit === null) {
    // A native link over a listing Shopee does not serve as a kit — no writer
    // produces it, and deleting an ORDINARY listing for it would be the worst
    // possible guess. Stop before creating anything.
    throw new Error(
      `[shopee/kits] o item ${String(alvo.itemId)} do vínculo ${alvo.linkDocId} não é servido como kit pela Shopee`,
    );
  }

  /* ---- (−) the scan's verdict FIRST (V2R1-01) ----------------------------- */
  if (plano.kitNovo === null) {
    throw new Error('[shopee/kits] recriação sem a busca de SKU (braço de criação sem kitNovo)');
  }
  if (plano.kitNovo.acao === 'recusar') {
    // `garantirKitNovo` throws the aggregated refusal (after the one fact a
    // create-arm run may write first, S2C-02) — the same answer `kit-criar`
    // gives, so an unlinked twin is named here and never hidden by step 0.
    await garantirKitNovo(deps, ctx, plano);
    throw new Error('[shopee/kits] garantirKitNovo não recusou um kitNovo recusar');
  }

  /* ---- 0. nothing to recreate? (the SAFETY NET, R-m) ---------------------- */
  const { nossos } = vinculosNativosDoKit(ctx.vinculos, alvo.linkDocId);
  const vivoKit = vivo?.kit ?? null;
  if (
    alvoVivo &&
    !ehVinculoSubstituido(alvo.raw) &&
    nossos.size === 0 &&
    vivoKit !== null &&
    nadaARecriar(ctx, plano, vivoKit)
  ) {
    // The aviso may be stale after a crash: the decision runs, then refuses.
    await reavaliar(deps, ctx);
    throw new ShopeePublishBlockedError({
      produtoId: kitId,
      itemId: alvo.itemId,
      problemas: [problemaRecriacaoSemDiferenca(alvo.itemId)],
    });
  }

  /* ---- 1. ensure the NEW kit exists --------------------------------------- */
  const garantia = await garantirKitNovo(deps, ctx, plano);
  if (garantia.desfecho === 'incerto') {
    const resultado = resultadoIncerto(ctx, 'kit-recriar', alvo.linkDocId, garantia);
    registrar(resultado);
    return resultado;
  }
  const novoLinkDocId = garantia.linkDocId;
  const novoItemId = garantia.itemId;
  if (novoLinkDocId === null || novoItemId === null) {
    throw new Error('[shopee/kits] garantia de kit novo sem vínculo nem item');
  }

  /* ---- 2. the delete gate — only while the target still exists ------------ */
  const avisos: AvisoKit[] = [...garantia.avisos];
  let excluido = linkRemovido;
  let substituido = false;
  let chamadasShopee = (ctx.busca?.chamadas ?? 0) + garantia.chamadasShopee;
  const portao = alvoExiste ? portaoDeExclusao(ctx, plano, garantia, alvoItem) : null;
  if (portao !== null) avisos.push(...portao.avisos);

  /* ---- 3. ensure the OLD kit is gone -------------------------------------- */
  if (!linkRemovido && (portao === null || portao.passa)) {
    const antigo = await garantirAntigoExcluido(deps, ctx, alvoItem, novoLinkDocId);
    excluido = antigo.excluido;
    substituido = antigo.substituido;
    avisos.push(...antigo.avisos);
    chamadasShopee += antigo.chamadasShopee;
  }

  /* ---- 4. the aviso decision, after every stamp --------------------------- */
  const decisao = await reavaliar(deps, ctx);

  const resultado: ResultadoPublicacaoKit = {
    arma: 'kit-recriar',
    desfecho: garantia.desfecho,
    produtoId: kitId,
    itemId: novoItemId,
    linkDocId: novoLinkDocId,
    estadoAnuncio: garantia.escrita?.estadoAnuncio ?? null,
    itemStatus: garantia.escrita?.itemStatus ?? null,
    kitNativo: garantia.escrita?.kitNativo ?? null,
    modelos: garantia.modelos,
    antecessor: { itemId: alvo.itemId, linkDocId: alvo.linkDocId, excluido, substituido },
    avisos,
    // The DECISION, not proof an open row closed — `criarKit`'s figure.
    avisosResolvidos: decisao === 'resolvido' ? 1 : 0,
    chamadasShopee,
    recusa: null,
    comando: null,
  };
  registrar(resultado);
  return resultado;
}

/* -------------------------------------------------------------------------- */
/*                               converterEmKit                                */
/* -------------------------------------------------------------------------- */

/**
 * The `kit-converter` applier (§2.7, L8): ensure the new kit, supersede the
 * ordinary antecessor, decide the aviso. Nothing is sent to — or read about —
 * the old listing.
 *
 * A named `--principal` that is not the new kit's main is a WARNING here
 * (`principal-diferente`): nothing destructive follows, and the main is frozen
 * once the kit exists (L1).
 *
 * @throws ShopeePublishBlockedError on the scan's verdict or any plan refusal —
 *   before any Shopee write.
 */
export async function converterEmKit(
  deps: KitDeps,
  ctx: ContextoKit,
  plano: PlanoKit,
): Promise<ResultadoPublicacaoKit> {
  const alvo = alvoDoBraco(ctx, 'kit-converter');
  const kitId = ctx.produto.id;

  /* ---- 1. ensure the NEW kit exists --------------------------------------- */
  const garantia = await garantirKitNovo(deps, ctx, plano);
  if (garantia.desfecho === 'incerto') {
    // The antecessor is always printed: re-running against the SAME ordinary
    // listing is what makes the re-run literally the same command (S1F-03).
    const resultado = resultadoIncerto(ctx, 'kit-converter', alvo.linkDocId, garantia);
    registrar(resultado);
    return resultado;
  }
  const novoLinkDocId = garantia.linkDocId;
  if (novoLinkDocId === null || garantia.itemId === null) {
    throw new Error('[shopee/kits] garantia de kit novo sem vínculo nem item');
  }

  const avisos: AvisoKit[] = [...garantia.avisos];
  if (ctx.principalPedido !== null && garantia.leitura !== null) {
    const principalNovo = principalDoKit(garantia.leitura.kit, ctx.temModelos);
    if (principalNovo === null || !mesmoEnderecoDeComponente(ctx.principalPedido, principalNovo)) {
      avisos.push(
        avisoPrincipalDiferente({
          produtoId: kitId,
          itemId: garantia.itemId,
          linkDocId: novoLinkDocId,
          pedido: rotuloDoEndereco(ctx, ctx.principalPedido),
          vivo: principalNovo === null ? '—' : rotuloDoEndereco(ctx, principalNovo),
        }),
      );
    }
  }

  /* ---- 2. supersede the ordinary listing — nothing is sent to it ---------- */
  await carimbarSubstituicao(deps.db, kitId, alvo.linkDocId, {
    substituidoPorLinkDocId: novoLinkDocId,
    substituidoEm: deps.nowMs,
  });

  /* ---- 3. the aviso decision ---------------------------------------------- */
  const decisao = await reavaliar(deps, ctx);

  const resultado: ResultadoPublicacaoKit = {
    arma: 'kit-converter',
    desfecho: garantia.desfecho,
    produtoId: kitId,
    itemId: garantia.itemId,
    linkDocId: novoLinkDocId,
    estadoAnuncio: garantia.escrita?.estadoAnuncio ?? null,
    itemStatus: garantia.escrita?.itemStatus ?? null,
    kitNativo: garantia.escrita?.kitNativo ?? null,
    modelos: garantia.modelos,
    antecessor:
      alvo.itemId === null
        ? null
        : { itemId: alvo.itemId, linkDocId: alvo.linkDocId, excluido: false, substituido: true },
    avisos,
    avisosResolvidos: decisao === 'resolvido' ? 1 : 0,
    chamadasShopee: (ctx.busca?.chamadas ?? 0) + garantia.chamadasShopee,
    recusa: null,
    comando: null,
  };
  registrar(resultado);
  return resultado;
}
