/**
 * **The publish ENTRY POINT** (step 19, #1527 — reconcile §2.5.3, L9, L10-R1):
 * the ONE function the `publicar` route and the `publicar:anuncio` CLI call, and
 * the only place a publish chooses WHICH listing it addresses.
 *
 * {@link publicarShopee} = {@link escolherArmaShopee} (read the produto and the
 * conta's links ONCE, then the pure dispatcher `kits/armaDePublicacao.ts`), then
 * either step 11's `publicarAnuncioShopee` — always handed the arm's
 * `linkDocId` — or the native-kit entry `publicarKitShopee`. The dry run's half
 * is {@link ensaiarPublicacaoShopee}: the same choice, then the READ half of the
 * chosen arm (`prepararPublicacao` for the item arm, `ensaiarKitShopee` for a kit
 * arm). So the dry run, `--live` and the route address ONE listing: nothing
 * downstream re-picks a listing the dispatcher skipped (M186).
 *
 * ⚠️ Why the id is always handed explicitly: `resolverLinkPorProduto` — the
 * resolver `prepararPublicacao` runs — stays step 11's LEXICAL pick over EVERY
 * link of the conta in every PR (L10(3), R-12(b)), a removed native kit and a
 * superseded listing included. Handing it `null` while the conta has links would
 * let it re-aim the publish at a listing the dispatcher deliberately skipped.
 *
 * Dependencies run ONE way — this module → {`publicarAnuncio.ts`, `kits/`}, and
 * `kits/` → `publicarAnuncio.ts`'s exported helpers — so there is no module
 * cycle (S3F-11). Clock-free and Next-free like the rest of `anuncios/`: the
 * route supplies `nowMs`, `esperar`, the partner client and the aviso counter.
 */
import { produtoCollection } from '@delfrance/data/admin/collections';

import { escolherArmaDePublicacao, type ResultadoDoDespacho } from '../kits/armaDePublicacao';
import type { ArmaDeKit, EntradaDeKit } from '../kits/prepararKit';
import { ensaiarKitShopee, publicarKitShopee, type EnsaioDeKit } from '../kits/publicarKit';
import type { ArmaDePublicacao, KitDeps, ResultadoPublicacaoKit } from '../kits/resultadoKit';
import { ShopeePublishBlockedError, temProblemaDeBloqueio } from './errosPublicacao';
import type { ResolvedorDeImagensShopee } from './fotosPublicacao';
import { lerVinculosDaConta } from './linkAnuncio';
import type { ContextoPublicacao } from './planoPublicacao';
import {
  prepararPublicacao,
  publicarAnuncioShopee,
  type EntradaDePublicacao,
  type PrepararPublicacaoDeps,
  type ResultadoPublicacao,
} from './publicarAnuncio';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the route's body (and the CLI's flags) resolve to: step 11's entrada plus
 * the three native-kit options (R-a). `recriar` always names its target
 * (`linkDocId`), and `recriar` with `converterEmKit` never arrives: the body
 * reader and the CLI answer both before this module is reached.
 */
export type EntradaDePublicacaoShopee = EntradaDePublicacao & {
  /** L1: an ERP component produto id, the kit's main component; `null` = not sent. */
  readonly principal: string | null;
  /** L4(4): recreate the named native kit. */
  readonly recriar: boolean;
  /** L8: turn the produto's ordinary listing into a native kit. */
  readonly converterEmKit: boolean;
};

/** One publish, done: step 11's result, or a native-kit run's. */
export type ResultadoPublicacaoShopee =
  | { readonly tipo: 'item'; readonly resultado: ResultadoPublicacao }
  | { readonly tipo: 'kit'; readonly resultado: ResultadoPublicacaoKit };

/** One dry run: the arm chosen, and what its READ half read. Nothing written, nothing created. */
export type EnsaioDePublicacaoShopee =
  | {
      readonly tipo: 'item';
      /** The id the dispatcher handed the item arm — the one `--live` would publish to. */
      readonly linkDocId: string | null;
      readonly contexto: ContextoPublicacao;
    }
  | { readonly tipo: 'kit'; readonly arma: ArmaDeKit; readonly ensaio: EnsaioDeKit };

/* -------------------------------------------------------------------------- */
/*                                 the choice                                  */
/* -------------------------------------------------------------------------- */

function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

/**
 * The FIRST half of a publish (L10-R1): read the produto and this conta's
 * `prodshopee` links ONCE, then {@link escolherArmaDePublicacao}. Zero Shopee
 * calls.
 *
 * @returns `null` when the produto does not exist, or when the dispatcher
 *   answers `null` because the named `linkDocId` is not this conta's — both the
 *   route's 404; otherwise the dispatcher's answer — an arm, or the refusal
 *   problems.
 */
export async function escolherArmaShopee(
  deps: Pick<PrepararPublicacaoDeps, 'db' | 'integracaoId'>,
  entrada: EntradaDePublicacaoShopee,
): Promise<ResultadoDoDespacho | null> {
  const snap = await produtoCollection.docRef(deps.db, {}, entrada.produtoId).get();
  if (!snap.exists) return null;
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  const vinculos = await lerVinculosDaConta(deps.db, deps.integracaoId, entrada.produtoId);
  return escolherArmaDePublicacao({
    produto: {
      id: entrada.produtoId,
      paiId: textoOuNull(raw.paiId),
      ehKit: raw.ehKit,
      ehKitVirtual: raw.ehKitVirtual,
    },
    vinculos,
    corpo: {
      linkDocId: textoOuNull(entrada.linkDocId),
      recriar: entrada.recriar,
      converterEmKit: entrada.converterEmKit,
      principal: entrada.principal,
    },
  });
}

/**
 * The dispatcher's arm, or its refusal THROWN — a `ShopeePublishBlockedError`
 * carrying every problem, exactly as every other pre-write refusal is (422 on
 * the route, `descreverBloqueioPublicacao` on the CLI). Zero Shopee calls.
 */
function armaOuRecusa(
  entrada: EntradaDePublicacaoShopee,
  despacho: ResultadoDoDespacho,
): ArmaDePublicacao {
  if (despacho.ok) return despacho.arma;
  const problemas = despacho.problemas;
  if (!temProblemaDeBloqueio(problemas)) {
    throw new Error('[shopee/anuncios] o despacho recusou sem nenhum problema');
  }
  throw new ShopeePublishBlockedError({ produtoId: entrada.produtoId, itemId: null, problemas });
}

/** Step 11's entrada for the item arm — BY NAME, the id always the dispatcher's. */
function entradaDoItem(
  entrada: EntradaDePublicacaoShopee,
  linkDocId: string | null,
): EntradaDePublicacao {
  return {
    produtoId: entrada.produtoId,
    linkDocId,
    categoryId: entrada.categoryId ?? null,
    statusPedido: entrada.statusPedido,
  };
}

/** The kit entry's entrada — BY NAME (the arm carries the link, never the entrada). */
function entradaDoKit(entrada: EntradaDePublicacaoShopee): EntradaDeKit {
  return {
    produtoId: entrada.produtoId,
    linkDocId: textoOuNull(entrada.linkDocId),
    categoryId: entrada.categoryId ?? null,
    statusPedido: entrada.statusPedido,
    principal: entrada.principal,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   publish                                   */
/* -------------------------------------------------------------------------- */

/**
 * Publish ONE produto on ONE conta, on the arm the dispatcher chose.
 *
 * @returns `null` when there is nothing to publish onto — the produto does not
 *   exist, or a named `linkDocId` is not this conta's (decided by the
 *   dispatcher, whatever kit option came with it, before any arm runs) — the
 *   route's **404**. Every refusal is a throw: `ShopeePublishBlockedError`
 *   before any Shopee write (the dispatcher's own included),
 *   `ShopeePublishRejectedError` for a wire refusal. A kit create whose outcome
 *   is uncertain is NOT a throw:
 *   it is a `ResultadoPublicacaoKit` with `desfecho: 'incerto'` (the route's
 *   202), because nothing was written and the operator must re-run.
 */
export async function publicarShopee(
  deps: KitDeps,
  entrada: EntradaDePublicacaoShopee,
): Promise<ResultadoPublicacaoShopee | null> {
  const despacho = await escolherArmaShopee(deps, entrada);
  if (despacho === null) return null;
  const arma = armaOuRecusa(entrada, despacho);

  if (arma.arma === 'item') {
    const resultado = await publicarAnuncioShopee(deps, entradaDoItem(entrada, arma.linkDocId));
    return resultado === null ? null : { tipo: 'item', resultado };
  }
  return { tipo: 'kit', resultado: await publicarKitShopee(deps, entradaDoKit(entrada), arma) };
}

/**
 * The DRY RUN of {@link publicarShopee} (the CLI's default mode): the SAME choice,
 * then only the READ half of the chosen arm — `prepararPublicacao` with the
 * dispatcher's `linkDocId` for the item arm, `ensaiarKitShopee` for a kit arm.
 * No Shopee write, no `add_kit_item`, no Firestore write. (A kit arm may still
 * READ — the L6 scan on a create arm — and upload the photos when content would
 * be sent: step 11's documented dry-run exception.)
 *
 * @returns `null` exactly when {@link publicarShopee} would answer `null`.
 * @throws ShopeePublishBlockedError on a dispatcher refusal (zero Shopee calls),
 *   and on any refusal the arm's read half raises, as `--live` would.
 */
export async function ensaiarPublicacaoShopee(
  deps: PrepararPublicacaoDeps,
  entrada: EntradaDePublicacaoShopee,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<EnsaioDePublicacaoShopee | null> {
  const despacho = await escolherArmaShopee(deps, entrada);
  if (despacho === null) return null;
  const arma = armaOuRecusa(entrada, despacho);

  if (arma.arma === 'item') {
    const contexto = await prepararPublicacao(
      deps,
      entradaDoItem(entrada, arma.linkDocId),
      resolvedor,
    );
    return contexto === null ? null : { tipo: 'item', linkDocId: arma.linkDocId, contexto };
  }
  return {
    tipo: 'kit',
    arma,
    ensaio: await ensaiarKitShopee(deps, entradaDoKit(entrada), arma, resolvedor),
  };
}
