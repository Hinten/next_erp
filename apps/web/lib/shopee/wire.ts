/**
 * Zod schemas for every JSON body the `apps/shopee` backend answers with, and
 * the public types inferred from them.
 *
 * ## ⚠️ This file is a KNOWN duplication — say so, and keep the names identical
 *
 * The same shapes are declared in `apps/shopee/lib/shopee/conta/status.ts`,
 * whose docblock mandates this mirror: `apps/web` has no dependency edge to any
 * `apps/*` and none is possible, so a browser surface that needs a backend shape
 * has exactly two options — share it, or write it twice. The field names here
 * are IDENTICAL to that module's, which is the whole point: a drift then shows
 * up in a diff instead of at runtime. The two later blocks name their own
 * twins the same way — the label's `etiqueta/pendenteEtiqueta.ts`, and the
 * returns' `devolucoes/estadoDevolucao.ts` (step 17).
 *
 * ⚠️ This header must not describe what the OTHER copy does beyond naming it.
 * A comment asserting the behaviour of a file the compiler cannot see is the
 * smell root `CLAUDE.md` names — the copies drift *toward plausible* and read
 * correct while disagreeing (#1369). What this file owns is the shape the
 * BROWSER will accept; `status.ts` owns what the backend sends.
 *
 * ## The two clocks, mirrored
 *
 * A Shopee conta has two independent expiries and this schema keeps them apart:
 * `expireTime` / `diasParaExpirar` are the **authorization** (7–365 days, the
 * seller's consent — its lapse means a re-consent), while `credencial.expiraEm`
 * is the **access token** (~4 hours, refreshable). They are different fields
 * with different units of meaning, and nothing here folds one into the other.
 *
 * ## Three rules these schemas follow (the same three as `lib/mercado-livre/wire.ts`)
 *
 * 1. ⚠️ **Unknown keys pass.** Zod 4 objects strip by default and nothing here
 *    is `.strict()`. `apps/web` calls the DEPLOYED channel backend, so the
 *    browser is routinely OLDER *or* NEWER than the thing answering it — a
 *    strict object would turn every forward deploy into an outage.
 * 2. ⚠️ **A field is required here only while no deployed backend can omit it.**
 *    All four return paths of `GET /api/marketplace/shopee/conta` are total over
 *    the eight top-level keys (they all spread `CONTA_DESCONECTADA`), which is a
 *    measured claim rather than a default, so those eight stay required. **The
 *    maintenance rule** for anything added later: declare it
 *    `.optional()`/`.default(…)` with the fallback the panel already applies —
 *    an OLDER backend answering a NEWER browser is the risk, and a required
 *    field is what turns that skew into a dead screen.
 *    `credencial.renovacaoFalhou` is the first field to take that rule up: it
 *    defaults to `false`, so a browser carrying it still reads a payload written
 *    before the field existed, and the only cost of the skew is that a failed
 *    renewal is not announced until the backend catches up.
 * 3. ⚠️ **Numbers are tolerant when the value ORIGINATES outside our own
 *    arithmetic** (`wireInt()` from `@delfrance/core/wire`) and strict
 *    (`z.number()`) when the backend computed it. `shopId` / `mainAccountId` are
 *    read out of Firestore through the SOFT `parseRead`, which hands back the
 *    RAW document on a schema mismatch — so a legacy quoted id reaches this wire
 *    unchanged; `authTime` / `expireTime` are Shopee's own seconds multiplied
 *    into milliseconds. `diasParaExpirar` and `credencial.expiraEm` are ours: a
 *    string there is our serialisation bug and should be loud (#1087 is the
 *    worked example of the opposite mistake costing a whole response).
 */
import { z } from 'zod';

import { wireInt, wireNumber } from '@delfrance/core/wire';

/**
 * `get_shop_info`'s projection — a SIDE read, absent (`loja: null`) whenever the
 * backend could not make it. A stale stored access token does NOT imply that
 * absence, and the absence implies nothing about either clock.
 */
export const shopeeLojaSchema = z.object({
  shopName: z.string().nullable(),
  region: z.string().nullable(),
  /**
   * ⚠️ `.catch(null)` and NOT a widened `z.string()`: Shopee documents three
   * lifecycle values today and may add a fourth, and the badge this drives is
   * one line of a panel. A member we do not know degrades to "no badge" — it
   * must never cost the operator the whole conta read.
   *
   * ⚠️ The catch is scoped to THIS field. A malformed sibling (`shopName: 42`)
   * still rejects the object, which is what keeps the tolerance from being
   * blanket `z.any()`.
   */
  status: z.enum(['BANNED', 'FROZEN', 'NORMAL']).nullable().catch(null),
});
export type ShopeeLoja = z.infer<typeof shopeeLojaSchema>;

/** The body of `GET /api/marketplace/shopee/conta?integracaoId=…` (always 200). */
export const shopeeContaStatusSchema = z.object({
  connected: z.boolean(),
  /** Shopee's shop id, denormalised onto the integração — provider-origin. */
  shopId: wireInt().nullable(),
  /** Set instead of `shopId` when the consent was main-account-scoped. */
  mainAccountId: wireInt().nullable(),
  /** Milliseconds — when the seller granted the AUTHORIZATION. */
  authTime: wireInt().nullable(),
  /** Milliseconds — when the AUTHORIZATION lapses. */
  expireTime: wireInt().nullable(),
  /** Whole days to that lapse, floored by the backend. Ours, hence strict. */
  diasParaExpirar: z.number().int().nullable(),
  /** `null` whenever the backend could not read `get_shop_info` at all. */
  loja: shopeeLojaSchema.nullable(),
  /** The OTHER clock. `null` when no credential is stored at all. */
  credencial: z
    .object({
      expiraEm: z.number().int(),
      expirada: z.boolean(),
      /**
       * The last renewal of the access token failed TERMINALLY and none has
       * succeeded since — the one credential state an operator can act on
       * (everything else heals on the next call that needs a token).
       *
       * ⚠️ `.default(false)` under rule 2: a payload written before this field
       * existed still parses, and reads as "no failure known", which is the
       * tolerant direction — a browser one deploy ahead of the backend shows
       * the healthy copy for a while instead of a dead screen.
       */
      renovacaoFalhou: z.boolean().default(false),
    })
    .nullable(),
});
export type ShopeeContaStatus = z.infer<typeof shopeeContaStatusSchema>;

/**
 * The body of `GET /api/marketplace/shopee/oauth/start?integracaoId=…`.
 *
 * ⚠️ `.min(1)` is load-bearing: the only consumer hands this straight to
 * `window.location.assign`, and `assign('')` does not fail — it silently
 * RELOADS the current page, so the operator clicks "Conectar conta" and lands
 * back where they started with no error anywhere.
 */
export const oauthStartResponseSchema = z.object({ authorizeUrl: z.string().min(1) });
export type ShopeeOauthStart = z.infer<typeof oauthStartResponseSchema>;

/* ---------------------------------------------------------------------------
 * The label (#1523, step 15) — the 202 body of `POST /api/marketplace/shopee/etiqueta`
 * ------------------------------------------------------------------------- */

// ⚠️ The same KNOWN duplication as the rest of this file, with a different
// source: `apps/shopee/lib/shopee/etiqueta/pendenteEtiqueta.ts` (`EtiquetaPendente`,
// `Progresso`) and `modoDeEnvio.ts` (`EnderecoDeColeta`, `EscolhaDeEnvio`).
// The NAMES below are identical to those, so a rename shows up in a diff; the
// test file parses literals copied from the backend's own tests (reconcile
// R-aa). This block owns what the BROWSER accepts, nothing more.
//
// Every number and string in this body is computed by the backend (rule 3):
// strict `z.number()`, never `wireInt()`. Every field is required (rule 2) —
// no deployed backend predates this route — except `escolhaInvalida`, whose
// default is the reading an absent key can only mean ("nothing was answered
// yet"). Unknown keys pass (rule 1).

/** A count the backend computed — strict, never negative. */
const contagem = () => z.number().int().nonnegative();

/**
 * The counts every 202 carries — what makes the give-up message deterministic
 * (`organizados === total && total > 0` means "already arranged"). Counts only.
 */
export const shopeeEtiquetaProgressoSchema = z.object({
  total: contagem(),
  organizados: contagem(),
  comRastreio: contagem(),
  prontos: contagem(),
});
export type Progresso = z.infer<typeof shopeeEtiquetaProgressoSchema>;

/**
 * One pickup address offered in an `escolher-envio` question. Ids are OPAQUE
 * STRINGS here (Shopee's `address_id` is an int64): the browser echoes them
 * back verbatim and never does arithmetic on them.
 */
export const shopeeEnderecoDeColetaSchema = z.object({
  id: z.string().min(1),
  rotulo: z.string(),
  principal: z.boolean(),
  /** May be EMPTY — a zero-slot address, where Shopee schedules the pickup. */
  horarios: z.array(
    z.object({
      id: z.string().min(1),
      rotulo: z.string(),
      recomendado: z.boolean(),
    }),
  ),
});
export type EnderecoDeColeta = z.infer<typeof shopeeEnderecoDeColetaSchema>;

/**
 * The backend's phase — a FREE string here, never a closed enum. The browser
 * only compares two of them (one toast per phase) and shows the backend's own
 * `mensagem`, so a phase added to a newer backend costs nothing; an enum would
 * turn it into a dead label flow for every browser one deploy behind.
 */
const fase = z.string().min(1);

const aguardarSchema = z.object({
  acao: z.literal('aguardar'),
  fase,
  /** Milliseconds to wait before the next call. `0` is legal (the caller clamps it). */
  tentarEmMs: z.number().int().nonnegative(),
  mensagem: z.string().min(1),
  progresso: shopeeEtiquetaProgressoSchema,
});

const escolherEnvioSchema = z
  .object({
    acao: z.literal('escolher-envio'),
    fase,
    /** The ONE package this question is about — echoed back in `envio.pacote`. */
    pacote: z.string().min(1),
    /** "Pacote i de n" on a split order, `null` otherwise. */
    pacoteRotulo: z.string().nullable(),
    mensagem: z.string().min(1),
    enderecos: z.array(shopeeEnderecoDeColetaSchema),
    permiteDropoff: z.boolean(),
    /** The previous answer no longer matches Shopee — the question is asked AGAIN. */
    escolhaInvalida: z.boolean().default(false),
    progresso: shopeeEtiquetaProgressoSchema,
  })
  // ⚠️ A question with no address AND no dropoff has no answer: the dialog
  // would offer nothing but "Cancelar". The backend refuses that case as a 409
  // (`sem-endereco-de-coleta`), so a 202 carrying it is not a question at all.
  .refine((q) => q.enderecos.length > 0 || q.permiteDropoff, {
    message: 'uma pergunta sem endereço precisa oferecer a postagem na agência',
    path: ['enderecos'],
  });

const baixarPorPacoteSchema = z.object({
  acao: z.literal('baixar-por-pacote'),
  fase,
  /**
   * One call per package, with `pacote`. `.min(2)`: one package is not a split.
   *
   * ⚠️ NO upper bound, on purpose. Shopee's own 50-package ceiling on one
   * download is a reason the backend asks for THIS loop, not a bound on it — it
   * sends more than 50 here (truth: `executarEtiqueta.ts`; pinned by
   * `executarEtiqueta.test.ts` "51 pacotes prontos … ⇒ baixar-por-pacote com os
   * 51", mirrored in `wire.test.ts`). A `.max(50)` rejected that body and sent
   * the operator to a deploy that fixed nothing (review 2, Q1-1).
   */
  pacotes: z.array(z.string().min(1)).min(2),
  mensagem: z.string().min(1),
  progresso: shopeeEtiquetaProgressoSchema,
});

/**
 * The 202 body: a wait, a question, or "download the packages one at a time" —
 * three members, and only three (the 1-hour confirm was removed with its whole
 * apparatus, reconcile Appendix A).
 *
 * ⚠️ An unknown `acao` REJECTS the body. Unlike an unknown KEY, a new member is
 * something the caller would have to ANSWER, and treating it as a wait would
 * poll a question nobody asks (W17).
 */
export const shopeeEtiquetaPendenteSchema = z.discriminatedUnion('acao', [
  aguardarSchema,
  escolherEnvioSchema,
  baixarPorPacoteSchema,
]);
export type ShopeeEtiquetaPendente = z.infer<typeof shopeeEtiquetaPendenteSchema>;

/**
 * The operator's answer to an `escolher-envio` question — what the browser
 * SENDS, so a type and no schema. `horarioId: null` is meaningful: a zero-slot
 * address, where Shopee schedules the pickup. The backend judges each shape
 * against its EXACT key set, so the client rebuilds it by name before sending.
 */
export type EscolhaDeEnvio =
  | {
      readonly pacote: string;
      readonly modo: 'pickup';
      readonly enderecoId: string;
      readonly horarioId: string | null;
    }
  | { readonly pacote: string; readonly modo: 'dropoff' };

/* ---------------------------------------------------------------------------
 * Returns (#1525, step 17) — `GET …/reclamacao/estado` and `POST …/reclamacao/acao`
 * ------------------------------------------------------------------------- */

// ⚠️ The same KNOWN duplication as the rest of this file, with a different
// source: `apps/shopee/lib/shopee/devolucoes/estadoDevolucao.ts`
// (`EstadoDevolucaoShopee`, `acaoDevolucaoShopeeSchema`) and the two
// `app/api/marketplace/shopee/reclamacao/{estado,acao}/route.ts` answers. The
// NAMES below are identical to those, so a rename shows up in a diff. This block
// owns what the BROWSER accepts, nothing more.
//
// How this file's three rules land here:
// - every Shopee TOKEN (status, motivo, negotiation / proof / compensation
//   status, validation type) is a FREE string — Shopee adds vocabulary without
//   notice, and the labels (`reclamacaoLabels.ts`) show an unknown one raw;
// - our own CODES the browser only LABELS (`prazos[].tipo`,
//   `pendenciasForaDoErp`, `acoesDisponiveis`) are free strings too: a code a
//   newer backend adds must cost a raw badge, never the whole panel;
// - the solução is the one closed enum, because the browser SENDS it back (the
//   offer's `solucao`, the accept's `solucaoExibida`) and it is ours, not a
//   Shopee token: a member this build cannot send is not one it can act on, so
//   a third one is a coordinated change of both sides;
// - Shopee's numbers (amounts, the request type, the counter-offer count, the
//   deadlines as Shopee seconds × 1000) are tolerant, `wireNumber()` /
//   `wireInt()`;
// - ⚠️ the four ARRAYS carry NO default. A defaulted `[]` reads "no actions /
//   no deadlines" for a backend that did not answer them — the ML wire's lesson
//   on `acoesDisponiveis`. No deployed backend predates this route, so every
//   field is required (rule 2); a field added later is `.optional()` with the
//   panel's fallback.

/** A return's solution as the backend normalised it — the one closed enum here. */
export const solucaoDevolucaoShopeeSchema = z.enum(['RETURN_REFUND', 'REFUND']);
export type SolucaoDevolucaoShopee = z.infer<typeof solucaoDevolucaoShopeeSchema>;
export const SOLUCAO_DEVOLUCAO_SHOPEE = {
  devolucaoEReembolso: 'RETURN_REFUND',
  soReembolso: 'REFUND',
} as const satisfies Record<string, SolucaoDevolucaoShopee>;

/**
 * The seller actions the ERP can run on a return — what the browser SENDS as
 * `acao`. The estado's `acoesDisponiveis` stays a free string list: the panel
 * renders a code it knows as a button and any other as a badge.
 */
export const acaoReclamacaoShopeeSchema = z.enum(['confirmar', 'ofertar', 'aceitar-oferta']);
export type AcaoReclamacaoShopee = z.infer<typeof acaoReclamacaoShopeeSchema>;
export const ACAO_RECLAMACAO_SHOPEE = {
  confirmar: 'confirmar',
  ofertar: 'ofertar',
  aceitarOferta: 'aceitar-oferta',
} as const satisfies Record<string, AcaoReclamacaoShopee>;

/** One seller-facing deadline. Only positive deadlines are sent. */
export const shopeePrazoDevolucaoSchema = z.object({
  /** Ours: `resposta-vendedor`, `final-vendedor`, `envio-comprador`, `evidencias`, `compensacao`, `proposta`. */
  tipo: z.string().min(1),
  /** Milliseconds — Shopee's own seconds × 1000, so tolerant (rule 3). */
  prazoMs: wireInt(),
  /** Shopee refunds the buyer on its own when this deadline lapses. */
  reembolsoAutomatico: z.boolean(),
});
export type ShopeePrazoDevolucao = z.infer<typeof shopeePrazoDevolucaoSchema>;

/** One ELIGIBLE solution the seller may offer. Bounds are REAIS, Shopee's floats. */
export const shopeeSolucaoOfertavelSchema = z.object({
  solucao: solucaoDevolucaoShopeeSchema,
  ajustavel: z.boolean(),
  minimo: wireNumber().nullable(),
  maximo: wireNumber().nullable(),
});
export type ShopeeSolucaoOfertavel = z.infer<typeof shopeeSolucaoOfertavelSchema>;

/**
 * The live state of one Shopee return (`PERM.incidenteResolucao.read`).
 *
 * ⚠️ **A snapshot, never a cache.** `acoesDisponiveis` is the backend's answer
 * to "what may the seller do right now"; the web holds no copy of that rule
 * (#1369) and must refetch rather than remember.
 */
export const shopeeReclamacaoEstadoSchema = z.object({
  returnSn: z.string().min(1),
  orderSn: z.string().min(1),
  /** The ERP pedido the return's order maps to — echoed back on every action. */
  pedidoId: z.string().min(1),
  status: z.string().min(1),
  terminal: z.boolean(),
  solucao: solucaoDevolucaoShopeeSchema.nullable(),
  /** Raw Shopee reason tokens. */
  motivo: z.string().nullable(),
  motivoReavaliado: z.string().nullable(),
  /** REAIS. */
  valorReembolso: wireNumber().nullable(),
  valorAntesDesconto: wireNumber().nullable(),
  moeda: z.string().nullable(),
  /** Shopee's `return_refund_request_type` (0 normal, 1 in transit, 2 on the spot). */
  tipoRequisicao: wireInt().nullable(),
  tipoValidacao: z.string().nullable(),
  negociacao: z
    .object({
      status: z.string().nullable(),
      solucaoOfertada: solucaoDevolucaoShopeeSchema.nullable(),
      valorOfertado: wireNumber().nullable(),
      contrapropostasRestantes: wireInt().nullable(),
    })
    .nullable(),
  prova: z.object({ status: z.string().nullable() }).nullable(),
  compensacao: z
    .object({
      status: z.string().nullable(),
      valor: wireNumber().nullable(),
    })
    .nullable(),
  prazos: z.array(shopeePrazoDevolucaoSchema),
  /** Eligible solutions only; `[]` when none, or when Shopee refused the read. */
  solucoes: z.array(shopeeSolucaoOfertavelSchema),
  acoesDisponiveis: z.array(z.string()),
  /** A pt-BR sentence when `acoesDisponiveis` is empty. */
  motivoSemAcao: z.string().nullable(),
  /** What the seller must do on the Seller Centre, which the ERP does not do. */
  pendenciasForaDoErp: z.array(z.string()),
});
export type ShopeeReclamacaoEstado = z.infer<typeof shopeeReclamacaoEstadoSchema>;

/**
 * What a successful `POST …/reclamacao/acao` reports.
 *
 * ⚠️ `ok: z.literal(true)`: a 200 saying anything else is a contract breach,
 * never a success to toast. `acao` / `returnSn` are echoes, read loosely — a
 * parse failure AFTER an irreversible action would tell the operator the action
 * failed when it did not. `atualizacao` says whether the post-action re-import
 * was enqueued; it only changes a sentence, so an unknown value degrades to
 * "not said" rather than costing the success.
 */
export const shopeeReclamacaoAcaoRespostaSchema = z.object({
  ok: z.literal(true),
  acao: z.string(),
  returnSn: z.string(),
  atualizacao: z.enum(['enfileirada', 'nao-enfileirada']).optional().catch(undefined),
});
export type ShopeeReclamacaoAcaoResposta = z.infer<typeof shopeeReclamacaoAcaoRespostaSchema>;
