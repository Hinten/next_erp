/**
 * Step 19 (#1527) — the FROZEN types of the native-kit arms, and the two pure
 * texts every surface prints after an uncertain create.
 *
 * Every other `kits/` module, the dispatcher (PR 7) and the route/CLI code
 * against the names here (reconcile §2.5.1, §2.5.3). It holds no IO and no
 * clock: types, one constant sentence and one pure renderer.
 *
 * ⚠️ {@link ArmaDePublicacao} is widened ONE PR at a time. PR 5 declares the
 * three arms whose appliers exist in its tree (`item`, `kit-criar`,
 * `kit-atualizar`); PR 6 adds `kit-recriar` and `kit-converter` together with
 * their appliers, so every `switch` over it stays exhaustive with no
 * unreachable branch. {@link ArmaKit} — the RESULT's arm, a plain string — names
 * all four from the start: it is what a result SAYS, and nothing switches on it
 * to choose an applier.
 *
 * ⚠️ No raw native-kit refusal slug is spelled here (the O7 producer grep in
 * `anuncios/errosPublicacao.test.ts` reads every non-test file of this folder):
 * the refusals live in `planoKit.ts` and are spelled through
 * `MOTIVO_PUBLICACAO_BLOQUEADA`.
 */
import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  type ShopeeItemStatusWritable,
  type ShopeeKitItem,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';
import type {
  EnderecoShopeeDoComponente,
  EstadoAnuncioShopee,
  ResolucaoComponenteKit,
} from '@delfrance/schemas';

import type { PublicarAnuncioDeps } from '../anuncios/publicarAnuncio';
import type { LimitesKitLidos } from '../taxonomia/cache';
import type { localizarKitsPorSku } from './localizarKitPorSku';
import type { MotivoRecusaKit } from './recusaKit';

/* -------------------------------------------------------------------------- */
/*                         The arm (the dispatcher's answer)                   */
/* -------------------------------------------------------------------------- */

/**
 * Which applier one publish reaches (reconcile §2.5.1). PR 5's members only —
 * see the module docblock for how PR 6 widens it.
 */
export type ArmaDePublicacao =
  /** `linkDocId` is `null` ONLY when the conta has no link at all (a first ordinary publish). */
  | { readonly arma: 'item'; readonly linkDocId: string | null }
  | { readonly arma: 'kit-criar' }
  | { readonly arma: 'kit-atualizar'; readonly linkDocId: string };

/** One conta-filtered `prodshopee` document of the produto, read once by the entry point. */
export interface VinculoDaConta {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

/** The arm a native-kit RESULT reports. */
export type ArmaKit = 'kit-criar' | 'kit-atualizar' | 'kit-recriar' | 'kit-converter';

/**
 * What one kit run did.
 *
 * - `criado` — `add_kit_item` answered with an `item_id`;
 * - `retomado` — a recriar/converter whose new kit already existed (linked) and
 *   was completed instead of created;
 * - `atualizado` — a republish (`update_kit_item`);
 * - `incerto` — `add_kit_item` failed in a way that does not prove nothing was
 *   created; NOTHING was written and the operator re-runs the printed command.
 */
export type DesfechoKit = 'criado' | 'retomado' | 'atualizado' | 'incerto';

/* -------------------------------------------------------------------------- */
/*                                  Warnings                                  */
/* -------------------------------------------------------------------------- */

/**
 * A NON-blocking finding of a kit run. Every code is a fact the operator may
 * act on later; none stops the run (a refusal is a `ProblemaDeBloqueio`).
 *
 * (v2 r1's republish duplicate-twin code is DELETED by L10(4): a republish
 * never scans, so it had no producer.)
 */
export type CodigoAvisoKit =
  | 'receita-divergente'
  | 'receita-nao-publicavel'
  | 'principal-diferente'
  | 'componente-nao-limita-estoque'
  | 'receita-espelho-divergente'
  | 'modelo-sem-filho'
  | 'variacao-nao-anexada'
  | 'kit-antigo-nao-excluido'
  | 'kit-novo-inativo'
  | 'kit-novo-divergente'
  /** PR 6, V2R1-02: the recriar's delete gate (the target is not older). */
  | 'kit-alvo-mais-novo'
  /** PR 5, V2R1-07: a republish resent the LIVE `item_sku` (`kit-sem-sku` / `kit-sku-com-espacos`). */
  | 'sku-do-kit-nao-enviado';

/**
 * One warning. `produtoId` is the produto the sentence is about (a child, a
 * component or the kit), `null` when it is about the listing as a whole.
 * `mensagem` is a pt-BR MECHANISM sentence with ids only — never a name, an SKU
 * value, a URL or a body.
 */
export interface AvisoKit {
  readonly codigo: CodigoAvisoKit;
  readonly produtoId: string | null;
  readonly mensagem: string;
}

/* -------------------------------------------------------------------------- */
/*                                   Result                                   */
/* -------------------------------------------------------------------------- */

/** One kit run, done — the route's 200/202 body and the CLI's summary, built BY NAME. */
export interface ResultadoPublicacaoKit {
  readonly arma: ArmaKit;
  readonly desfecho: DesfechoKit;
  readonly produtoId: string;
  /** `null` only on `incerto`. */
  readonly itemId: number | null;
  /** `null` only on `incerto`. */
  readonly linkDocId: string | null;
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  readonly itemStatus: string | null;
  readonly kitNativo: boolean | null;
  readonly modelos: {
    readonly vinculados: number;
    readonly anexados: number;
    readonly semFilho: number;
  };
  /** The replaced listing of a recriar/converter (PR 6); `null` otherwise. */
  readonly antecessor: {
    readonly itemId: number;
    readonly linkDocId: string;
    readonly excluido: boolean;
    readonly substituido: boolean;
  } | null;
  readonly avisos: readonly AvisoKit[];
  readonly avisosResolvidos: number;
  readonly chamadasShopee: number;
  /** Shopee's refusal on an `incerto` create: rendered by the route (202 body) and the CLI. */
  readonly recusa: {
    readonly codigo: string;
    readonly fraseShopee: string | null;
    readonly motivo: MotivoRecusaKit | null;
  } | null;
  /** {@link comandoDeRetomada} of this run on `incerto`, else `null` (S1F-03). */
  readonly comando: string | null;
}

/* -------------------------------------------------------------------------- */
/*                         The frozen context (prepararKit)                    */
/* -------------------------------------------------------------------------- */

/**
 * Step 11's deps plus the aviso counter the recipe-aviso re-decision needs to
 * RAISE (`escreverAviso`'s `increment`). The route and the CLI wire
 * `FieldValue.increment` (PR 7); PR 5/6 tests pass a fake. The re-decision's
 * µs clock comes from `avisos/autorizacao.ts`'s `depsDeEscrita`/`agoraUsDe`,
 * never from a `nowMs` multiplied here.
 */
export type KitDeps = PublicarAnuncioDeps & { readonly increment: (by: number) => unknown };

/** One sellable unit of the kit produto K — a family child, or a família de um's member. */
export interface FilhoDoKit {
  readonly produtoId: string;
  readonly sku: string | null;
  readonly ordem: number;
  /** This child's OWN recipe (each child its own, L2), PARSED (`quantidade` defaults to 1). */
  readonly componentesKit: Readonly<
    Record<string, { readonly quantidade: number; readonly limitarEstoque?: boolean }>
  > | null;
  /**
   * The SAME map as STORED, unparsed — what every fingerprint READER folds (the
   * aviso decision, the `apps/functions` trigger, step 9's R-t). The stamp
   * `receitaKitConferida` is computed from THIS (`chaveReceitaArmazenadaDoFilho`,
   * `planoKit.ts`), never from the parsed {@link FilhoDoKit.componentesKit}: an
   * entry stored without `quantidade` parses to 1 but folds to `null`, and a stamp
   * taken from the parse could never equal what the readers compute (R1-RT7-02).
   * Absent (a hand-built context) ⇒ the parsed map stands in.
   */
  readonly componentesKitArmazenado?: Readonly<
    Record<string, { readonly quantidade?: unknown; readonly [campo: string]: unknown }>
  > | null;
  /** `precoDoFilhoNaTabela` through `filhoParaPublicar`; `null` = no usable price. */
  readonly preco: number | null;
  /** `varianteDoFilhoNoGrupo` — the tier option text; `null` for a família de um. */
  readonly variante: string | null;
}

/**
 * Everything one kit run READ, before any Shopee write (reconcile §2.5.3).
 * Built by `prepararKit.ts`; read by `planoKit.ts` and the appliers.
 */
export interface ContextoKit {
  readonly arma: Exclude<ArmaDePublicacao, { readonly arma: 'item' }>;
  readonly integracaoId: string;
  readonly produto: {
    readonly id: string;
    readonly sku: string | null;
    readonly raw: Record<string, unknown>;
  };
  /** Ordered by `ordem`; a família de um = `[member]`. */
  readonly filhos: readonly FilhoDoKit[];
  readonly familiaDeUm: boolean;
  /** The ONE variation axis (n ≥ 2). */
  readonly grupo: { readonly id: string; readonly nome: string } | null;
  /** > 1 ⇒ `kit-dois-eixos`. */
  readonly gruposDistintos: number;
  readonly descricao: string | null;
  /** Component produtoId → its Shopee address in this conta, or why it has none. */
  readonly resolucao: ReadonlyMap<string, ResolucaoComponenteKit>;
  /** `has_model` per item id — the live AND the ERP-resolved items. */
  readonly temModelos: ReadonlyMap<number, boolean>;
  readonly categoriaPorProduto: ReadonlyMap<string, number | null>;
  /**
   * Create arms: `--principal` resolved; `kit-atualizar`: `principalDoKitShopee(vivo)`
   * (L1: read back); a `completar` (recriar/converter resume): the COMPLETED kit's
   * read-back main, NEVER `vivo`'s (V2R3-01).
   */
  readonly principal: EnderecoShopeeDoComponente | null;
  /** `--principal` as sent: COMPARED on `kit-atualizar` (`principal-diferente`) and by the recriar guard. */
  readonly principalPedido: EnderecoShopeeDoComponente | null;
  /**
   * `--principal` RAW, the ERP produto id the operator typed (`null` = not sent).
   * Kept beside its resolution because a named principal that does not RESOLVE
   * reads `principalPedido: null` — indistinguishable from "not sent" — and a
   * create arm would then default (one item) or ask for one (two items) instead
   * of saying the named one is invalid (OP-8). Absent ⇒ not sent.
   */
  readonly principalSolicitado?: string | null;
  /**
   * `--status` as the operator asked (OP-9): `UNLIST` makes a CREATE send
   * `item_setting.unlisted: true`; `NORMAL` or absent sends no `unlisted` at all
   * (Shopee's default, the body probes #1/#2 measured). A republish never sends
   * it (R-s(4): pausing a live kit is step 11's `unlist_item`).
   */
  readonly statusPedido?: ShopeeItemStatusWritable;
  /** `null` when no principal category is known. */
  readonly limites: LimitesKitLidos | null;
  /** UNCACHED. */
  readonly canais: readonly ShopeeLogisticsChannel[];
  /** The conta's `prodshopee` of K (OURS for `decidirKitNovo`). */
  readonly vinculos: readonly VinculoDaConta[];
  /** atualizar/recriar: the target kit link; converter: the ordinary antecessor; criar: `null`. */
  readonly alvo: { readonly linkDocId: string; readonly raw: Record<string, unknown> } | null;
  /**
   * The target's live read (atualizar; recriar unless the target link is
   * `removido` — then `null`, M123). `criadoEm` = base-info `create_time`, SECONDS
   * (V2R1-02).
   */
  readonly vivo: {
    readonly status: string | null;
    readonly kit: ShopeeKitItem | null;
    readonly criadoEm: number | null;
  } | null;
  /** The TARGET's `variashopee` rows (`idDoRef` fold, §2.6). */
  readonly linhasDoAnuncio: readonly {
    readonly produtoId: string;
    readonly docId: string;
    readonly raw: Record<string, unknown>;
  }[];
  /**
   * V2R1-03: EVERY child's `variashopee` for this conta, each with
   * `idDoRef(produtoShopeeOuterRef)` (`null` = unreadable, never bound);
   * {@link ContextoKit.linhasDoAnuncio} is its filter by the target.
   */
  readonly linhasDaConta: readonly {
    readonly produtoId: string;
    readonly docId: string;
    readonly linkDocId: string | null;
    readonly raw: Record<string, unknown>;
  }[];
  /** Create arms ONLY; `null` on `kit-atualizar` (a republish never scans, L10(4)). */
  readonly busca: Awaited<ReturnType<typeof localizarKitsPorSku>> | null;
  /**
   * S2C-02: each `nossos` item_id the scan did NOT list → its batched base-info
   * status (`null` = deleted/absent); empty on `kit-atualizar` (no scan, L10(4)).
   */
  readonly nossosVivos: ReadonlyMap<number, string | null>;
}

/* -------------------------------------------------------------------------- */
/*                         The uncertain create (202)                          */
/* -------------------------------------------------------------------------- */

/**
 * The `incerto` sentence the route (202) and the CLI print beside `recusa`,
 * FOLLOWED BY {@link comandoDeRetomada} (S1F-03: a plain publish is a DIFFERENT
 * arm after a recriar (kit-atualizar on the old kit) or a converter (the item
 * arm on the old listing — the write L8 forbids), so the answer always names the
 * exact command).
 *
 * L10-R2: the "importe-o" promise holds only while no OTHER run has linked a kit
 * to this produto — once one has, the same command is `kit-atualizar` (or a
 * converter refusal), which scans nothing (L10(4)), so the sentence says so
 * instead of lying. 4 minutes = the route ceiling (`timeoutSeconds: 180`,
 * `apps/shopee/apphosting.yaml`) + 60 s over the ~9 s listing latency.
 */
export const MENSAGEM_KIT_INCERTO =
  'a Shopee pode ter criado o kit — aguarde 4 minutos e rode exatamente este comando de novo: se o kit existir, o ' +
  'ERP recusa com «já existe na Shopee — importe-o» e importar:anuncio o liga a este produto; senão, o ERP o cria. ' +
  'Se outra execução tiver vinculado um kit a este produto nesse meio-tempo, o comando não procura mais pelo SKU: ' +
  'um kit duplicado só aparece num próximo --recriar';

/**
 * Pure. The flags of THIS run re-rendered, so a re-run is literally the same
 * command:
 *
 * `publicar:anuncio --integracao <id> --produto <id>` +
 * - `kit-recriar`: ` --link <alvo> --recriar` (a recriar always names its target, R-a);
 * - `kit-converter`: ` --converter-em-kit`, plus ` --link <antecessor>` when it was named;
 * - `kit-atualizar`: ` --link <id>` when it was named;
 * - `kit-criar`: nothing (a first create names no link);
 *
 * then ` --principal <id>` when one was sent, then ` --status UNLIST` when the
 * run asked for a paused create (OP-9 — `NORMAL` is the default and is not
 * printed), then each `extras` entry (the CLI's own mode flag, e.g. `--live`).
 * The 202 body carries it as `comando`.
 */
export function comandoDeRetomada(
  arma: ArmaKit,
  a: {
    readonly integracaoId: string;
    readonly produtoId: string;
    readonly linkDocId: string | null;
    readonly principal: string | null;
    readonly status?: ShopeeItemStatusWritable;
    readonly extras?: readonly string[];
  },
): string {
  const partes: string[] = [
    'publicar:anuncio',
    '--integracao',
    a.integracaoId,
    '--produto',
    a.produtoId,
  ];
  switch (arma) {
    case 'kit-criar':
      break;
    case 'kit-atualizar':
      if (a.linkDocId !== null) partes.push('--link', a.linkDocId);
      break;
    case 'kit-recriar':
      if (a.linkDocId !== null) partes.push('--link', a.linkDocId);
      partes.push('--recriar');
      break;
    case 'kit-converter':
      partes.push('--converter-em-kit');
      if (a.linkDocId !== null) partes.push('--link', a.linkDocId);
      break;
  }
  if (a.principal !== null) partes.push('--principal', a.principal);
  if (a.status === SHOPEE_ITEM_STATUS_WRITABLE.unlist) partes.push('--status', a.status);
  for (const extra of a.extras ?? []) partes.push(extra);
  return partes.join(' ');
}
