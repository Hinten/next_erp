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
 * The one `null` (no link at all) is flagged `despachoSemVinculo`, and the
 * no-link mint REFUSES (409 `CONTENCAO`) when its own re-read finds a link that
 * appeared after this read — another run's freshly minted draft included —
 * rather than let that resolver pick it unlocked (#1911 batch-A review). And
 * `aplicarPublicacao` refuses any create onto a draft it holds no lock of.
 *
 * Dependencies run ONE way — this module → {`publicarAnuncio.ts`,
 * `criacaoIncerta.ts`, `reservaRascunho.ts`, `kits/`}, and `kits/` →
 * `publicarAnuncio.ts`'s exported helpers — so there is no module cycle
 * (S3F-11). Clock-free and Next-free like the rest of `anuncios/`: the route
 * supplies `nowMs`, `esperar`, the partner client and the aviso counter.
 *
 * ⚠️ The one decision this module takes on top of the dispatcher's (§I4 on
 * the KIT arms, #1911 batch-B review round 5): an attestation's EXPECTATION
 * (`criacaoIncertaAdota`) was read off a DRAFT's refusal, and only the item
 * arm's reservation can honour it. A named link the dispatcher sends to a kit
 * arm is no draft, so the publish is refused with the reservation's own 409
 * `JA_PUBLICADO` BEFORE the arm runs — see {@link recusarAtestacaoNumBracoDeKit}.
 */
import { produtoCollection } from '@delfrance/data/admin/collections';

import { escolherArmaDePublicacao, type ResultadoDoDespacho } from '../kits/armaDePublicacao';
import type { ArmaDeKit, EntradaDeKit } from '../kits/prepararKit';
import { ensaiarKitShopee, publicarKitShopee, type EnsaioDeKit } from '../kits/publicarKit';
import type { ArmaDePublicacao, KitDeps, ResultadoPublicacaoKit } from '../kits/resultadoKit';
import {
  CriacaoDeAnuncioIncertaError,
  expectativaDaAtestacao,
  type ResultadoItemIncerto,
} from './criacaoIncerta';
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
import { conflitoDeRascunhoJaPublicado } from './reservaRascunho';

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

/**
 * One publish, done: step 11's result, a native-kit run's — or (#1911, D5) an
 * ordinary listing's first `add_item` whose outcome nobody can know: the
 * draft's lock kept for the wait and the attempt recorded (the route's 202).
 */
export type ResultadoPublicacaoShopee =
  | { readonly tipo: 'item'; readonly resultado: ResultadoPublicacao }
  | { readonly tipo: 'item-incerto'; readonly resultado: ResultadoItemIncerto }
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

/**
 * Step 11's entrada for the item arm — BY NAME, the id always the dispatcher's.
 * `null` only when the dispatcher found NO link of the produto on the conta, and
 * then it says so (`despachoSemVinculo`): the no-link mint's own re-read refuses
 * any link that appeared in between instead of falling back to step 11's
 * lexical resolver (#1911 batch-A review, the mint race).
 */
function entradaDoItem(
  entrada: EntradaDePublicacaoShopee,
  linkDocId: string | null,
): EntradaDePublicacao {
  return {
    produtoId: entrada.produtoId,
    linkDocId,
    categoryId: entrada.categoryId ?? null,
    statusPedido: entrada.statusPedido,
    ...(linkDocId === null ? { despachoSemVinculo: true } : {}),
  };
}

/**
 * §I4 on the KIT arms (#1911 batch-B review round 5; Lucas 2026-11-03: "an
 * attested publish whose link is no longer a draft must not run as an update
 * — refuse, nothing sent"). The attestation's EXPECTATION (`[L]` = adopt `L`,
 * `[]` = a deliberate create) was read off a DRAFT's refusal, and only the
 * item arm's reservation (`reservaRascunho.ts`) can honour it — it is also
 * where round 4 refuses a named link that stopped being a draft. The kit arms
 * never reach that reservation, and they never read `deps.aoVivo`: a named
 * link the dispatcher sends to `kit-atualizar` / `kit-recriar` (a native kit,
 * live or not — the import can adopt a native-kit listing onto an ordinary
 * draft) or to `kit-converter` (a live ordinary listing) would otherwise run
 * a kit WRITE the operator never confirmed. A named DRAFT never reaches a kit
 * arm (the dispatcher sends it to the item arm or refuses it), so this fires
 * only for a link that is no draft.
 *
 * Refused with the reservation's OWN 409 `JA_PUBLICADO`
 * ({@link conflitoDeRascunhoJaPublicado} — one sentence, one home), decided on
 * the dispatcher's read of the links (rule 7: nothing written, nothing to
 * lose), BEFORE any Shopee call, upload or Firestore write of the arm.
 *
 * The SAME predicate as round 4's reservation guard,
 * `expectativaDaAtestacao`: the bare `confirmarCriacaoIncerta` flag (the
 * CLI's), an absent or `null` expectation, and no `aoVivo` at all (a caller
 * with no live controls) keep the kit arm exactly as before.
 *
 * @throws ConflitoDeRascunhoShopeeError `JA_PUBLICADO` for `entrada.linkDocId`.
 * @throws Error when an expectation arrives with no `linkDocId` — the body
 *   reader answers that 400 (round 3), so reaching here is a composition
 *   defect; never a fallback to the arm.
 */
function recusarAtestacaoNumBracoDeKit(
  deps: Pick<KitDeps, 'aoVivo'>,
  entrada: EntradaDePublicacaoShopee,
  arma: Exclude<ArmaDePublicacao, { readonly arma: 'item' }>,
): void {
  const esperado = deps.aoVivo === undefined ? null : expectativaDaAtestacao(deps.aoVivo);
  if (esperado === null) return;
  const linkDocId = textoOuNull(entrada.linkDocId);
  if (linkDocId === null) {
    throw new Error(
      `[shopee/anuncios] uma atestação com expectativa chegou ao braço ${arma.arma} sem ` +
        'linkDocId — a leitura do corpo a recusa (400) antes daqui. Nada foi gravado nem enviado.',
    );
  }
  console.warn(
    '[shopee/anuncios] atestação com expectativa num vínculo que o despacho mandou a um braço de kit; nada enviado',
    { produtoId: entrada.produtoId, linkDocId, arma: arma.arma, esperado },
  );
  throw conflitoDeRascunhoJaPublicado(linkDocId);
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
 *   before any Shopee LISTING write (the dispatcher's own included; reads and
 *   photo uploads may precede it) — EXCEPT the item arm's model-leg refusals
 *   on an UPDATE, which follow `update_item` (`modelosPublicacao.ts`),
 *   `ShopeePublishRejectedError` for a wire refusal, and the draft lock's
 *   `ConflitoDeRascunhoShopeeError` (the 409) — the item arm's reservation's,
 *   or, for an attestation's expectation that the dispatcher routed to a KIT
 *   arm, {@link recusarAtestacaoNumBracoDeKit}'s `JA_PUBLICADO`, thrown
 *   before the arm runs (§I4, round 5). A kit create whose outcome
 *   is uncertain is NOT a throw:
 *   it is a `ResultadoPublicacaoKit` with `desfecho: 'incerto'` (the route's
 *   202), because nothing was written and the operator must re-run. Neither is
 *   an ordinary listing's (#1911): the item arm's `CriacaoDeAnuncioIncertaError`
 *   — thrown only AFTER the draft recorded the attempt — is narrowed BY CLASS
 *   into `tipo: 'item-incerto'` here, the one place that reads it.
 */
export async function publicarShopee(
  deps: KitDeps,
  entrada: EntradaDePublicacaoShopee,
): Promise<ResultadoPublicacaoShopee | null> {
  const despacho = await escolherArmaShopee(deps, entrada);
  if (despacho === null) return null;
  const arma = armaOuRecusa(entrada, despacho);
  // §I4 on the kit arms (round 5): BEFORE the arm — no Shopee call, no upload,
  // no write. The item arm's equivalent is its reservation's 409 `JA_PUBLICADO`,
  // on whichever of its reads finds it.
  if (arma.arma !== 'item') recusarAtestacaoNumBracoDeKit(deps, entrada, arma);

  if (arma.arma === 'item') {
    try {
      const resultado = await publicarAnuncioShopee(deps, entradaDoItem(entrada, arma.linkDocId));
      return resultado === null ? null : { tipo: 'item', resultado };
    } catch (err) {
      if (err instanceof CriacaoDeAnuncioIncertaError) {
        return { tipo: 'item-incerto', resultado: err.resultado };
      }
      throw err;
    }
  }
  return { tipo: 'kit', resultado: await publicarKitShopee(deps, entradaDoKit(entrada), arma) };
}

/**
 * The DRY RUN of {@link publicarShopee} (the CLI's default mode): the SAME choice,
 * then only the READ half of the chosen arm — `prepararPublicacao` with the
 * dispatcher's `linkDocId` for the item arm, `ensaiarKitShopee` for a kit arm.
 * No Shopee write, no `add_kit_item`, no Firestore write. (A kit arm may still
 * READ — the L6 scan on a create arm — and upload the photos when content would
 * be sent: step 11's documented dry-run exception.) ⚠️ The item arm's dry run
 * runs NEITHER of its look-ups — ENSURE nor, since #1911 P5b, the first
 * create's same-SKU scan: both live under the draft's lock, which only the live
 * publish takes, and the CLI's summary of a create says so.
 *
 * ⚠️ No §I4 guard here, and none is needed: the dry run carries NO
 * attestation — `PrepararPublicacaoDeps` omits `aoVivo`, so there is no
 * expectation to refuse — and it sends no listing write and writes no
 * document.
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
