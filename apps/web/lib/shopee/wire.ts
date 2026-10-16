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
 * up in a diff instead of at runtime. The later blocks name their own twins
 * the same way — the label's `etiqueta/pendenteEtiqueta.ts`, the returns'
 * `devolucoes/estadoDevolucao.ts` (step 17), and the category / band answers of
 * `taxonomia/dto.ts` (read by step 18's size-chart tab). The size-chart
 * envelopes themselves are the exception: IMPORTED from `@delfrance/schemas`,
 * never mirrored.
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
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  acaoSugeridaPublicacaoShopeeSchema,
  envioPrecoFaseSchema,
  envioPrecoResultadoSchema,
  envioPrecoShopeeStatusSchema,
  estadoAnuncioShopeeSchema,
  importacaoShopeeStatusSchema,
  shopeeViolacaoSchema,
} from '@delfrance/schemas';

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

/* ---------------------------------------------------------------------------
 * Size charts (#1526, step 18) — the category tree and the item bands the
 * `/medidas` Shopee tab reads (`GET …/taxonomia/{categorias,limites}`, step 10's
 * routes), and the two size-chart reads (`GET …/tabela-medidas/{lista,detalhe}`)
 * ------------------------------------------------------------------------- */

// ⚠️ The same KNOWN duplication as the rest of this file, with two sources:
// `apps/shopee/lib/shopee/taxonomia/dto.ts` (`categoriaResumoDtoSchema`,
// `categoriaNoDtoSchema`) and `taxonomia/limites.ts` (`limitesDeItemDtoSchema`'s
// `sizeChartLimit`) — step 10's answers, older than this tab. The NAMES below
// are identical to those, so a rename shows up in a diff. This block owns what
// the BROWSER accepts, nothing more.
//
// ⚠️ The two SIZE-CHART envelopes (`lista`, `detalhe`, with the projected chart
// inside) are deliberately NOT mirrored: they are IMPORTED from
// `@delfrance/schemas` — the package both apps can reach — so the route and this
// browser parse the same bytes with the same schema objects. A hand-copied twin
// beside a comment saying it matches is exactly the drift #1369 shipped.
//
// How this file's three rules land here:
// - every number is OURS (rule 3): the ids were read through the package's
//   tolerant wire readers before the backend projected them, so a string here is
//   our serialisation bug and is loud — strict `z.number().int()`, never
//   `wireInt()`;
// - every field is required (rule 2): each route answers all of them on every
//   200, and no deployed backend predates the size-chart routes (an older
//   backend answers them with a 404, which is an HTTP error, never a parse);
// - unknown keys are stripped (rule 1), and the limites answer declares ONLY the
//   slice this browser reads — every other band of that body is dropped here, so
//   a change to one of them can never cost this screen.

/** One category as a picker row. `name` / `originalName` are Shopee's display / original names. */
export const categoriaResumoDtoSchema = z.object({
  categoryId: z.number().int(),
  name: z.string().nullable(),
  originalName: z.string().nullable(),
  /** The backend's three-valued leaf gate, folded: only `folha` is `true`. */
  isLeaf: z.boolean(),
});
export type CategoriaResumoDto = z.infer<typeof categoriaResumoDtoSchema>;

/** One focused node: the row, its parent, its ancestors (root FIRST) and its direct children. */
export const categoriaNoDtoSchema = categoriaResumoDtoSchema.extend({
  /** `0` marks a root — a real value, never an absence. */
  parentId: z.number().int(),
  pathFromRoot: z.array(categoriaResumoDtoSchema),
  children: z.array(categoriaResumoDtoSchema),
});
export type CategoriaNoDto = z.infer<typeof categoriaNoDtoSchema>;

/**
 * The body of `GET …/taxonomia/categorias?integracaoId=[&categoryId=]`: the
 * ROOTS when no id was asked (`no: null`), ONE node when one was
 * (`raizes: null`). An id the tree does not hold is a 404
 * (`SHOPEE_CATEGORIA_DESCONHECIDA`), never a 200.
 *
 * ⚠️ A body with NEITHER half answers no question at all — the browser would
 * render an empty picker that looks like a tree with no categories. It is
 * refused, so the operator reads a contract breach instead of a blank list.
 */
export const respostaCategoriasShopeeSchema = z
  .object({
    raizes: z.array(categoriaResumoDtoSchema).nullable(),
    no: categoriaNoDtoSchema.nullable(),
  })
  .refine((r) => r.raizes !== null || r.no !== null, {
    message: 'a resposta de categorias não trouxe nem as raízes nem o nó pedido',
    path: ['no'],
  });
export type RespostaCategoriasShopee = z.infer<typeof respostaCategoriasShopeeSchema>;

/**
 * The body of `GET …/taxonomia/limites?integracaoId=&categoryId=`, cut to the
 * slice the size-chart tab reads: `size_chart_limit` (announcements 1010/1404).
 *
 * ⚠️ ADVICE, never a gate (reconcile L7): none of these three booleans may
 * disable a pick. Each is three-valued — `null` is "Shopee did not say", which
 * is NOT `false` — and the whole block is `null` when Shopee sent none.
 */
export const respostaLimitesShopeeSchema = z.object({
  /** `'shop'` or `'category'` — a free string (rule 1's spirit: the browser only shows it). */
  scope: z.string(),
  categoryId: z.number().int().nullable(),
  limites: z.object({
    sizeChartLimit: z
      .object({
        sizeChartMandatory: z.boolean().nullable(),
        supportImageSizeChart: z.boolean().nullable(),
        supportTemplateSizeChart: z.boolean().nullable(),
      })
      .nullable(),
  }),
});
export type RespostaLimitesShopee = z.infer<typeof respostaLimitesShopeeSchema>;

/**
 * The bodies of `GET …/tabela-medidas/lista?integracaoId=&categoryId=` and
 * `GET …/tabela-medidas/detalhe?integracaoId=&sizeChartId=` — NOT declared here.
 *
 * They are the SAME schema objects the `apps/shopee` routes build their 200s
 * against, from `@delfrance/schemas` (`tabelaDeMedidasShopeeDto.ts`), so a
 * renamed or added key is a compile error on both sides of the deploy instead
 * of a `ShopeeClientRespostaInvalidaError` here. Re-exported under their own
 * names so every browser import of this file stays as it was.
 *
 * - `lista`: `leaf: false` is a non-leaf category (`tabelas: []`, Shopee never
 *   asked); `totalCount` is the FIRST page's, a diagnostic; `truncado` means
 *   the backend stopped before Shopee said the list was over; `removidas` and
 *   `idsIlegiveis` are counts the browser shows, never rows.
 * - `detalhe`: the chart projected ONCE, on the backend, by
 *   `projetarTabelaShopee`; the browser renders it and never re-projects it. A
 *   template Shopee no longer has is a 404 (`SHOPEE_TABELA_MEDIDAS_INEXISTENTE`).
 */
export {
  detalheTabelaMedidasDtoSchema,
  listaTabelasMedidasDtoSchema,
  tabelaMedidasLinhaDtoSchema,
  type DetalheTabelaMedidasDto,
  type ListaTabelasMedidasDto,
  type TabelaMedidasLinhaDto,
} from '@delfrance/schemas';

/* ---------------------------------------------------------------------------
 * Step 21 (#1529, sub-step 21-1) — the three on-demand pushes, the publish and
 * re-verify answers, the two account-wide jobs, and the extras an error body
 * carries
 * ------------------------------------------------------------------------- */

// ⚠️ The same KNOWN duplication as the rest of this file, with these sources: the
// bodies the `apps/shopee/app/api/marketplace/shopee/{enviar-estoque,
// enviar-precos,anuncio-status,publicar,reverificar-anuncio,importar-todos/**,
// atualizar-precos/**}/route.ts` handlers build BY NAME. This block owns what the
// BROWSER accepts, nothing more.
//
// How this file's three rules land here, plus two of this block's own:
// - unknown keys STRIP (rule 1), and each object declares only the SLICE the
//   browser reads; the keys it drops on purpose are named in a comment beside it,
//   so a change to one of them can never cost a screen;
// - every declared field is REQUIRED (rule 2): each route builds its 2xx BY NAME
//   from a parsed document, so it always sends every key. The tolerances are
//   NAMED, one per place: `estadoAnuncio` (a member a newer backend adds), the
//   price rows' `variacaoNome`/`variacaoSku` (added after this build's first
//   backend), the kit 202's `aguardarMs`, and every field of
//   {@link detalhesErroShopeeSchema};
// - numbers are strict when the backend computed them and `wireNumber()` when the
//   value was read OFF Shopee (rule 3) — `precoAnterior`, everywhere;
// - ⚠️ NO object slice is derived from a stored-document schema. `.pick` /
//   `.extend` inherit that schema's READ-TOLERANCE defaults (`.default(0)`,
//   `() => []`), so a counter or a list a route stopped sending would read as `0`
//   or `[]` — "nothing happened" — instead of failing loudly. Each job slice is
//   declared here, strict, with no default. The one derived import is
//   `shopeeViolacaoSchema.strip()`, whose `null` defaults are Shopee's own
//   absences;
// - VOCABULARIES are imported from `@delfrance/schemas`, never re-declared: the
//   job statuses, the report row's `resultado`/`fase`, `estadoAnuncio`, the
//   pause/reactivate direction and the refusal's `acao`.

/** The four outcomes of one listing of a push — the `PushOutcome` the three web registries share. */
const pushOutcomeShopeeSchema = z.enum(['enviado', 'pulado', 'falha', 'nao-tentado']);

/** A requested produto that produced no listing at all, and why. Shared by all three pushes. */
const semEnvioShopeeSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  motivo: z.string(),
  mensagem: z.string(),
});

/**
 * One LISTING of an on-demand stock push (`POST …/enviar-estoque`).
 *
 * ⚠️ `motivo` is NOT a failure signal: a clamped send (raised to a promotion's
 * floor) is a SUCCESS that still carries one. Read `outcome`.
 */
export const envioEstoqueManualShopeeListingSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  anuncioId: z.string().nullable(),
  linkDocId: z.string().nullable(),
  outcome: pushOutcomeShopeeSchema,
  motivo: z.string().nullable(),
  /** The BACKEND's pt-BR sentence — it owns this wording. */
  mensagem: z.string(),
  /** What was SENT; `null` whenever nothing was. */
  quantidade: z.number().nullable(),
  /** Models Shopee refused inside an otherwise accepted call. */
  modelosRecusados: z.number().int(),
  /** Models whose quantity was raised to a promotion's reserved floor. */
  clampados: z.number().int(),
}); // STRIPPED on purpose: variacaoProdutoId (always null), variacoes (per-model rows), rearme (always null)
export type EnvioEstoqueManualShopeeListing = z.infer<typeof envioEstoqueManualShopeeListingSchema>;

/**
 * The body of `POST …/enviar-estoque` — 200 even when every listing failed: a
 * per-listing refusal is DATA.
 *
 * ⚠️ `canal: z.literal('shopee')`: a `NEXT_PUBLIC_SHOPEE_URL` pointed at another
 * channel's backend answers a body of the same envelope, and must be a
 * `RespostaInvalida` here rather than that channel's rows rendered as Shopee's.
 */
export const envioEstoqueManualShopeeSchema = z.object({
  canal: z.literal('shopee'),
  integracaoId: z.string(),
  listings: z.array(envioEstoqueManualShopeeListingSchema),
  produtosSemEnvio: z.array(semEnvioShopeeSchema),
  /** ISO-8601 — set when Shopee's DAILY quota paused the conta; the rest was not attempted. */
  pausadoAte: z.string().nullable(),
}); // STRIPPED: contaNome, solicitados, familias, resumo (the dialog recounts the rows)
export type EnvioEstoqueManualShopee = z.infer<typeof envioEstoqueManualShopeeSchema>;

/**
 * One row of an on-demand PRICE push (`POST …/enviar-precos`) — one per MODEL
 * (one for a listing without models), because each model carries its own price.
 */
export const envioPrecoManualShopeeListingSchema = z.object({
  /** The family ANCHOR, always. */
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  /** The CHILD this model belongs to; `null` for a listing without models. */
  variacaoProdutoId: z.string().nullable(),
  anuncioId: z.string().nullable(),
  linkDocId: z.string().nullable(),
  outcome: pushOutcomeShopeeSchema,
  motivo: z.string().nullable(),
  mensagem: z.string(),
  /** What was SENT — the tabela's price, OURS, hence strict. */
  preco: z.number().nullable(),
  /** Shopee's shelf price as the run READ it — provider-origin, hence tolerant (rule 3). */
  precoAnterior: wireNumber().nullable(),
  /** Shopee's own code, verbatim — diagnostics only, never the copy. */
  codigo: z.string().nullable(),
  /**
   * The child's `nome` / `sku`, for a per-model label.
   *
   * ⚠️ `.default(null)` under rule 2 — the one tolerance of this row: a backend
   * older than the label sends neither key, and the row then reads unlabelled.
   */
  variacaoNome: z.string().nullable().default(null),
  variacaoSku: z.string().nullable().default(null),
}); // STRIPPED: variacoes (always null — the rows are already per model)
export type EnvioPrecoManualShopeeListing = z.infer<typeof envioPrecoManualShopeeListingSchema>;

/** The body of `POST …/enviar-precos` — 200 even when every row failed. */
export const envioPrecoManualShopeeSchema = z.object({
  canal: z.literal('shopee'),
  integracaoId: z.string(),
  listings: z.array(envioPrecoManualShopeeListingSchema),
  produtosSemEnvio: z.array(semEnvioShopeeSchema),
  /** ISO-8601 — set when a quota pause stopped the run; the rest was not attempted. */
  pausadoAte: z.string().nullable(),
}); // STRIPPED: contaNome, solicitados, familias, resumo
export type EnvioPrecoManualShopee = z.infer<typeof envioPrecoManualShopeeSchema>;

/**
 * One listing of a PAUSE / REACTIVATE run (`POST …/anuncio-status`).
 *
 * ⚠️ `statusFinal` is what the listing READS after the write, never the status
 * that was asked for.
 */
export const anuncioStatusShopeeListingSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  anuncioId: z.string().nullable(),
  linkDocId: z.string().nullable(),
  outcome: pushOutcomeShopeeSchema,
  motivo: z.string().nullable(),
  mensagem: z.string(),
  statusFinal: z.string().nullable(),
  /**
   * The shared listing-state enum. ⚠️ `.catch(…desconhecido)` and scoped to THIS
   * field: a member a newer backend adds degrades to the enum's own "unknown",
   * never costs the run's whole answer — and a malformed sibling still rejects.
   */
  estadoAnuncio: estadoAnuncioShopeeSchema.nullable().catch(ESTADO_ANUNCIO_SHOPEE.desconhecido),
}); // STRIPPED: membros (always null)
export type AnuncioStatusShopeeListing = z.infer<typeof anuncioStatusShopeeListingSchema>;

/** The body of `POST …/anuncio-status` — 200 even when every listing was refused. */
export const anuncioStatusShopeeSchema = z.object({
  canal: z.literal('shopee'),
  integracaoId: z.string(),
  acao: z.enum([ACAO_STATUS_ANUNCIO.pausar, ACAO_STATUS_ANUNCIO.reativar]),
  listings: z.array(anuncioStatusShopeeListingSchema),
  produtosSemAnuncio: z.array(semEnvioShopeeSchema),
  /** ISO-8601 — set when Shopee's DAILY quota stopped the run. */
  pausadoAte: z.string().nullable(),
}); // STRIPPED: solicitados, familias, resumo
export type AnuncioStatusShopee = z.infer<typeof anuncioStatusShopeeSchema>;

/** A count or an id the backend computed — strict. */
const inteiro = () => z.number().int();

/** The ordinary-listing arm of `POST …/publicar` (200). */
const itemPublicadoShopeeSchema = z.object({
  itemId: inteiro(),
  /** `null` when the read-back degraded — nothing authoritative was read, which is NOT "unknown". */
  estadoAnuncio: estadoAnuncioShopeeSchema.nullable().catch(ESTADO_ANUNCIO_SHOPEE.desconhecido),
  itemStatus: z.string().nullable(),
  /** `semFilho` is a COUNT here — the per-model detail rides the log and the CLI. */
  modelos: z.object({
    total: inteiro(),
    criados: inteiro(),
    atualizados: inteiro(),
    semFilho: inteiro(),
  }),
  fotos: z.object({ reutilizadas: inteiro(), enviadas: inteiro(), falhas: inteiro() }),
  avisoShopee: z.string().nullable(),
  taxInfoOmitido: z.string().nullable(),
  tabelaDeMedidas: z.object({
    sizeChartId: inteiro().nullable(),
    fonte: z.string(),
    motivo: z.string().nullable(),
    /** WHY the photo fallback was withheld — a code, never a boolean. */
    fotoOmitida: z.string().nullable(),
    avisoObrigatoria: z.boolean(),
  }),
});
export type ItemPublicadoShopee = z.infer<typeof itemPublicadoShopeeSchema>;

/**
 * The native-kit arm of `POST …/publicar` — the 200, and the 202 whose
 * `desfecho` is `incerto` (`desfecho === 'incerto'` IS the 202; no status
 * plumbing is needed to tell them apart).
 *
 * ⚠️ `comando` and `mensagem` are deliberately NOT declared: both are CLI text (a
 * command line to re-run), and the browser renders neither.
 */
const kitPublicadoShopeeSchema = z.object({
  arma: z.enum(['kit-criar', 'kit-atualizar', 'kit-recriar', 'kit-converter']),
  /** Strict: the tab BRANCHES on it, and an outcome it does not know is not one it can render. */
  desfecho: z.enum(['criado', 'retomado', 'atualizado', 'incerto']),
  /** `null` only on `incerto`. */
  itemId: inteiro().nullable(),
  /** `null` only on `incerto`. */
  linkDocId: z.string().nullable(),
  estadoAnuncio: estadoAnuncioShopeeSchema.nullable().catch(ESTADO_ANUNCIO_SHOPEE.desconhecido),
  itemStatus: z.string().nullable(),
  kitNativo: z.boolean().nullable(),
  modelos: z.object({ vinculados: inteiro(), anexados: inteiro(), semFilho: inteiro() }),
  /** The replaced listing of a recriar/converter; `null` otherwise. */
  antecessor: z
    .object({
      itemId: inteiro(),
      linkDocId: z.string(),
      excluido: z.boolean(),
      substituido: z.boolean(),
    })
    .nullable(),
  /** `codigo` is a FREE string: the tab keys its copy on it and falls back for a code it lacks. */
  avisos: z.array(z.object({ codigo: z.string(), produtoId: z.string().nullable() })),
  avisosResolvidos: inteiro(),
  recusa: z
    .object({
      codigo: z.string(),
      fraseShopee: z.string().nullable(),
      motivo: z.string().nullable(),
    })
    .nullable(),
  /**
   * How long to wait before the IDENTICAL re-send an `incerto` asks for.
   * ⚠️ Optional — the one tolerance of this arm: a backend older than the field
   * omits it, and the caller then waits `AGUARDAR_KIT_INCERTO_SHOPEE_MS`
   * (`@delfrance/schemas`), never a copy of that number.
   */
  aguardarMs: z.number().int().positive().optional(),
});
export type KitPublicadoShopee = z.infer<typeof kitPublicadoShopeeSchema>;

/**
 * The body of `POST …/publicar`, tagged by arm.
 *
 * ⚠️ The KIT arm is tried FIRST: it is the one with a discriminating key
 * (`arma`). Each transform stamps `tipo` AFTER the parse, so a `tipo` key a
 * backend might send can never override it.
 */
export const respostaPublicarShopeeSchema = z.union([
  kitPublicadoShopeeSchema.transform((k) => ({ tipo: 'kit' as const, ...k })),
  itemPublicadoShopeeSchema.transform((i) => ({ tipo: 'item' as const, ...i })),
]);
export type RespostaPublicarShopee = z.infer<typeof respostaPublicarShopeeSchema>;

/**
 * The body of `POST …/reverificar-anuncio` (200). A listing Shopee no longer has
 * is `removido` here, never an error.
 */
export const respostaReverificarShopeeSchema = z.object({
  /** `atualizado` / `ignorado-sem-mudanca` / `removido` — a free string the toast keys on. */
  acao: z.string(),
  /** Never `null` on this route (an unread listing is `desconhecido`); the catch is the shared tolerance. */
  estadoAnuncio: estadoAnuncioShopeeSchema.catch(ESTADO_ANUNCIO_SHOPEE.desconhecido),
  itemStatus: z.string().nullable(),
  deboost: z.boolean(),
  /**
   * The rows Shopee objects to, IMPORTED from `@delfrance/schemas`, `.strip()`ped
   * so an unenumerated top-level key never reaches the browser.
   *
   * ⚠️ `.strip()` is SHALLOW: an unknown key inside a `suggested_category[]` item
   * survives (that item schema is `.passthrough()`). Display-only, and pinned as
   * a near miss in `wire.test.ts`.
   */
  violacoes: z.array(shopeeViolacaoSchema.strip()),
  /** `false` when the violation pull refused — the rows above are the STORED ones. */
  violacoesLidas: z.boolean(),
  modelos: z.object({ total: inteiro(), atualizados: inteiro(), ausentes: inteiro() }).nullable(),
  avisoResolvido: z.boolean(),
  /** The native-kit recipe aviso decision this run reached; `null` when it did not run. */
  avisoReceitaKit: z.enum(['aberto', 'resolvido', 'nada']).nullable(),
}); // STRIPPED: chamadasShopee (a budget diagnostic)
export type RespostaReverificarShopee = z.infer<typeof respostaReverificarShopeeSchema>;

/** The 202 of BOTH job starts (`importar-todos`, `atualizar-precos`). */
export const jobIdShopeeSchema = z.object({ jobId: z.string().min(1) });
export type JobIdShopee = z.infer<typeof jobIdShopeeSchema>;

/** The 200 of BOTH job cancels. Anything else is a contract breach, never a cancel to toast. */
export const canceladoShopeeSchema = z.object({ status: z.literal('cancelled') });
export type CanceladoShopee = z.infer<typeof canceladoShopeeSchema>;

/**
 * The body of `GET …/importar-todos/status`. DECLARED, strict, no default — see
 * this block's header for why it is not a `.pick` of the job document's schema.
 */
export const massImportStatusShopeeSchema = z.object({
  status: importacaoShopeeStatusSchema,
  scanned: inteiro(),
  imported: inteiro(),
  created: inteiro(),
  skipped: inteiro(),
  kits: inteiro(),
  /** Total failures — UNCAPPED, so it may exceed `failures.length`. */
  failureCount: inteiro(),
  /** The first N failures. ⚠️ `itemId` is Shopee's NUMBER, never a string. */
  failures: z.array(z.object({ itemId: inteiro(), motivo: z.string(), mensagem: z.string() })),
  /** How many listings are still queued — the queues' SIZE, never their contents. */
  restante: inteiro(),
  varreduraExaurida: z.boolean(),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  erro: z.string().nullable(),
});
export type MassImportStatusShopee = z.infer<typeof massImportStatusShopeeSchema>;

/** The counters and stamps every price-job answer carries — the status AND each history row. */
const contadoresPrecoShopee = {
  status: envioPrecoShopeeStatusSchema,
  baixarPreco: z.boolean(),
  planejados: inteiro(),
  enviados: inteiro(),
  pulados: inteiro(),
  falhas: inteiro(),
  pausas: inteiro(),
  /** Listings PARKED on the daily quota. */
  parques: inteiro(),
  /** The queue's SIZE, never its contents. */
  filaRestante: inteiro(),
  relatorioShards: inteiro(),
  /** MILLISECONDS — set while the job is parked on the daily quota. */
  retomarEm: z.number().nullable(),
  relatorioCompleto: z.boolean(),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  erro: z.string().nullable(),
};

/** One entry of the capped `skips` sample — with the sentence the route renders for its `code`. */
const amostraPrecoShopeeSchema = z.object({
  itemId: z.string().nullable(),
  produtoId: z.string(),
  code: z.string(),
  linkDocId: z.string().nullable(),
  precoAnterior: wireNumber().nullable(),
  mensagem: z.string(),
});

/** The body of `GET …/atualizar-precos/status`. */
export const priceSyncStatusShopeeSchema = z.object({
  jobId: z.string(),
  ...contadoresPrecoShopee,
  skips: z.array(amostraPrecoShopeeSchema),
  /** A skip plus Shopee's own code in `error`. */
  failures: z.array(amostraPrecoShopeeSchema.extend({ error: z.string() })),
});
export type PriceSyncStatusShopee = z.infer<typeof priceSyncStatusShopeeSchema>;

/** The body of `GET …/atualizar-precos/historico` — newest first, no samples. */
export const priceSyncHistoricoShopeeSchema = z.object({
  envios: z.array(
    z.object({ jobId: z.string(), integracaoId: z.string(), ...contadoresPrecoShopee }),
  ),
});
export type PriceSyncHistoricoShopee = z.infer<typeof priceSyncHistoricoShopeeSchema>;

/**
 * One row of the price-job report page — the 13 keys the route sends by name.
 *
 * ⚠️ `preco` is the price the plan INTENDED, present on `pulado`/`falha` rows
 * too: key a "para" column off `resultado`, never off `preco` being non-null.
 * There is no `variacoes` key (Mercado Livre's alone).
 */
const priceSyncRelatorioLinhaShopeeSchema = z.object({
  produtoId: z.string(),
  variacaoProdutoId: z.string().nullable(),
  anuncioId: z.string().nullable(),
  linkDocId: z.string().nullable(),
  resultado: envioPrecoResultadoSchema,
  fase: envioPrecoFaseSchema,
  motivo: z.string().nullable(),
  mensagem: z.string(),
  erro: z.string().nullable(),
  preco: z.number().nullable(),
  precoAnterior: wireNumber().nullable(),
  produtoNome: z.string().nullable(),
  sku: z.string().nullable(),
});
export type PriceSyncRelatorioLinhaShopee = z.infer<typeof priceSyncRelatorioLinhaShopeeSchema>;

/** One page of `GET …/atualizar-precos/relatorio`; loop on `proximoDepois` until it is `null`. */
export const priceSyncRelatorioPaginaShopeeSchema = z.object({
  linhas: z.array(priceSyncRelatorioLinhaShopeeSchema),
  proximoDepois: z.string().nullable(),
  status: envioPrecoShopeeStatusSchema,
  relatorioCompleto: z.boolean(),
  filaRestante: inteiro(),
});
export type PriceSyncRelatorioPaginaShopee = z.infer<typeof priceSyncRelatorioPaginaShopeeSchema>;

/**
 * One refusal row of a 422 (`SHOPEE_PUBLISH_BLOCKED` / `SHOPEE_PUBLISH_REJECTED`).
 *
 * ⚠️ The `acao` catch is PER ROW: a `tipo` a newer backend adds degrades THAT
 * row's next step to `null` (no button), and its sibling's valid `acao` survives.
 * A catch on the whole list would null every row for one unknown member.
 */
export const problemaShopeeSchema = z.object({
  /** A Shopee REQUEST field path, or `null`. */
  campo: z.string().nullable().catch(null),
  motivo: z.string(),
  mensagem: z.string(),
  acao: acaoSugeridaPublicacaoShopeeSchema.nullable().catch(null),
});
export type ProblemaShopee = z.infer<typeof problemaShopeeSchema>;

/**
 * The extras an ERROR body carries beyond `{ error, code }` — read once by the
 * client into `ShopeeClientHttpError.detalhes`.
 *
 * ⚠️ `.catch(null)` PER FIELD, on purpose: an absent key, a wrong type or a
 * malformed list each read as `null` and never cost the error — which must
 * always construct, whatever the body. One bad key nulls only itself.
 */
export const detalhesErroShopeeSchema = z.object({
  /** 409 `SHOPEE_CONTA_PAUSADA` — ISO-8601. */
  pausadoAte: z.string().nullable().catch(null),
  /** 400 `SHOPEE_SELECAO_EXCEDE_LIMITE` — the bound, and the deduped size asked for. */
  limite: z.number().int().nullable().catch(null),
  solicitados: z.number().int().nullable().catch(null),
  /** 422 `SHOPEE_PRECO_CONTA_RECUSADA` / `SHOPEE_PUBLISH_BLOCKED`. */
  motivo: z.string().nullable().catch(null),
  /** 422 `SHOPEE_PRECO_CONTA_RECUSADA` — the shop's region, when it was read. */
  regiao: z.string().nullable().catch(null),
  /** 422 `SHOPEE_PUBLISH_REJECTED` — what exists on Shopee NOW. */
  etapa: z.string().nullable().catch(null),
  /** 409 `SHOPEE_ANUNCIO_NAO_PUBLICADO` — the link that has no listing yet. */
  linkDocId: z.string().nullable().catch(null),
  /** 409 `…_RUNNING` — the job that is already running, to attach to. */
  jobId: z.string().nullable().catch(null),
  /** The two publish 422s — one row per refusal. */
  problemas: z.array(problemaShopeeSchema).nullable().catch(null),
});
export type DetalhesErroShopee = z.infer<typeof detalhesErroShopeeSchema>;

/** Every extra absent — what an error with no readable body carries. */
export const DETALHES_ERRO_SHOPEE_VAZIOS: DetalhesErroShopee = Object.freeze({
  pausadoAte: null,
  limite: null,
  solicitados: null,
  motivo: null,
  regiao: null,
  etapa: null,
  linkDocId: null,
  jobId: null,
  problemas: null,
});
