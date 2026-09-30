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
 * up in a diff instead of at runtime.
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

import { wireInt } from '@delfrance/core/wire';

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
   * One call per package, with `pacote`. `2..50`: one package is not a split,
   * and 50 is Shopee's own ceiling on a document batch — outside it the loop
   * that walks this list is not the loop the backend asked for.
   */
  pacotes: z.array(z.string().min(1)).min(2).max(50),
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
