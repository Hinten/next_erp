/**
 * Mercado Livre MODERATIONS — decide when to ask, and turn ML's answer into the
 * link doc's `moderacoes` (#1087).
 *
 * The complaint this closes: ML pauses a listing for a policy reason, the ERP
 * records `status: 'paused'` and nothing else, and the operator sees a dead
 * anúncio with no idea what to fix. ML *does* publish the reason and the fix —
 * `GET /moderations/last_moderation/{item_id}-ITM` — we simply never asked.
 *
 * ⚠️ There is **no `moderations` notification topic**. Checked against ML's
 * published topic list (developers site, *Recursos da API → Notificações*): a
 * moderation reaches us as an ordinary `items` delivery, and *Gerenciar
 * moderações* says outright to build the `moderation_reference_id` from that
 * notification by appending `-ITM`. So this hangs off the `items` sync that
 * already runs, with no new topic, no receiver change and no extra lookup.
 *
 * ⚠️ Lives here and not in `packages/integrations/mercado-livre` for the same
 * reason `publishFalhas.ts` does: it needs the `MlModeracao` shape from
 * `@delfrance/schemas`, and that package deliberately depends on no schemas.
 *
 * Modelled on `publishFalhas.ts` throughout — tolerant parse, capped output,
 * never throws. A failure to explain a failure must not become the failure.
 */
import {
  ML_MODERATION_ELEMENT,
  MercadoLivreHttpError,
  type MlModeration,
  type MlModerationEvidence,
} from '@delfrance/integrations-mercado-livre';
import { type MlModeracao, mlModeracaoSchema } from '@delfrance/schemas';

/**
 * ML's answer is unbounded and a Firestore document is not. Mirrors
 * `MAX_CAUSAS`: the operator acts on the first entries and the rest are the same
 * story. In practice `last_moderation` returns one.
 */
export const MAX_MODERACOES = 10;

/** Per moderation. `evidences` can list every offending picture on the listing. */
export const MAX_EVIDENCIAS = 20;

/**
 * `wordings[].type` — ML's two documented values. A REASON explains, a REMEDY
 * fixes; compared case-insensitively because only the uppercase spelling is
 * documented and a lowercase one would silently drop the whole text.
 */
const WORDING_REASON = 'reason';
const WORDING_REMEDY = 'remedy';

/**
 * The `sub_status` values that mean "ML has a moderation on this listing".
 *
 * Assembled from the status/substatus/tag table in *Gerenciar moderações* plus
 * the two companion pages, *Moderações com pausa* and *Moderações de imagens*:
 *
 *  | status         | sub_status / tag                      |
 *  |----------------|---------------------------------------|
 *  | `under_review` | waiting_for_patch · forbidden · held  |
 *  |                | pending_documentation · suspended     |
 *  |                | suspended_for_prevention · warning    |
 *  |                | picture_downloading_pending           |
 *  | `paused`       | moderation_penalty                    |
 *  |                | picture_download_pending              |
 *  | `active`       | poor_quality_thumbnail · moderation_penalty |
 *  | `closed`       | moderation_penalty                    |
 *
 * ⚠️ Both `picture_download_pending` and `picture_downloading_pending` are here
 * on purpose. They are not a typo of one another — ML's pages use the first for
 * the `paused` case and the second for the `under_review` one, and normalising
 * them to a single spelling would miss whichever page is right.
 *
 * ⚠️ `active` earns a place in this table, which is what makes moderation a poor
 * fit for `errors`: a `poor_quality_thumbnail` listing is LIVE and sendable, so
 * the stock re-arm gate would have cleared the diagnosis on the same write that
 * produced it.
 */
const MODERATION_SUB_STATUS: ReadonlySet<string> = new Set([
  'moderation_penalty',
  'poor_quality_thumbnail',
  'picture_download_pending',
  'picture_downloading_pending',
  'waiting_for_patch',
  'forbidden',
  'held',
  'pending_documentation',
  'suspended',
  'suspended_for_prevention',
  'warning',
]);

/**
 * Whether this reading is worth a `last_moderation` call.
 *
 * `under_review` qualifies on the STATUS alone: ML's docs put every one of its
 * substatuses in the moderation table, and a listing under review with a
 * sub_status we have not catalogued is exactly the case where the operator most
 * needs the reason. Everything else has to name a moderation sub_status.
 *
 * Being a predicate rather than "always fetch" is what keeps the `items` stream
 * affordable: it fires for every change to every listing the seller owns, and a
 * healthy one must keep costing the single `GET /items/{id}` it costs today.
 *
 * Pure and total — no clock, no network.
 */
export function precisaConsultarModeracao(
  status: string | null | undefined,
  subStatus: readonly string[] | null | undefined,
): boolean {
  if (status === 'under_review') return true;
  return (subStatus ?? []).some((s) => MODERATION_SUB_STATUS.has(s));
}

/** `MLB123` → `MLB123-ITM`, the `moderation_reference_id` for a listing. */
export function moderationReferenceId(itemId: string): string {
  return `${itemId}-${ML_MODERATION_ELEMENT.item}`;
}

/** `wordings[type=X].value`, first non-empty. */
function wording(moderation: MlModeration, type: string): string | null {
  for (const w of moderation.wordings ?? []) {
    if (w.type?.trim().toLowerCase() !== type) continue;
    const value = w.value?.trim();
    if (value != null && value.length > 0) return value;
  }
  return null;
}

/**
 * ML spells the evidence key BOTH ways in its own published responses —
 * `evidences` on *Gerenciar moderações*, `evidence` on *Moderações com pausa*
 * and *Moderações de imagens*. Take whichever arrived; take both if both do.
 */
function evidences(moderation: MlModeration): MlModerationEvidence[] {
  return [...(moderation.evidences ?? []), ...(moderation.evidence ?? [])];
}

/** Distinct, non-empty, capped — in first-seen order. */
function distinct(values: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed != null && trimmed.length > 0) out.add(trimmed);
  }
  return [...out].slice(0, MAX_EVIDENCIAS);
}

/**
 * ML's `last_moderation` response → what the link doc stores.
 *
 * ⚠️ An entry is dropped ONLY when it carries neither a REASON nor a `name` —
 * then it genuinely says nothing. A moderation with a `name` and no REASON is
 * KEPT, with `motivo: null`.
 *
 * That last rule is not a nicety. Dropping it would store `moderacoes: []`,
 * which on disk is byte-identical to a healthy listing and to ML's 404 — i.e. it
 * would record "not moderated" about a listing ML just told us IS moderated,
 * which is precisely the state {@link consultarModeracoes}'s 404 narrow and its
 * transient rethrow exist to prevent. `POOR_QUALITY_THUMBNAIL` +
 * `section_name: pictures` is also strictly more than the bare "pausado" this
 * whole feature replaces.
 *
 * ⚠️ But do NOT promote `name` into `motivo` to paper over it. A raw
 * SCREAMING_SNAKE filter id sitting where the operator expects ML's Portuguese
 * prose reads as a translated reason and is not one; `motivo: null` beside a
 * `nome` says exactly what happened.
 *
 * ⚠️ `remedio` stays null when ML sent no REMEDY, and that null is DATA: ML's
 * docs are explicit that a removed listing (`under_review` + `forbidden`)
 * returns a REASON and no REMEDY *because there is no way back*. Never fall back
 * to the motivo to fill it — that would promise a fix that does not exist.
 *
 * Never throws: a malformed entry is skipped, not propagated.
 */
export function mapModeracoes(raw: readonly MlModeration[] | null | undefined): MlModeracao[] {
  const out: MlModeracao[] = [];
  for (const moderation of raw ?? []) {
    const motivo = wording(moderation, WORDING_REASON);
    const nome = moderation.name?.trim() ?? null;
    // Nothing to say at all — no text, not even which filter fired.
    if (motivo == null && (nome == null || nome.length === 0)) continue;
    if (motivo == null) {
      // ⚠️ Deliberately observable. Every ML sample publishes `wordings`, so this
      // branch is defensive rather than documented — and the live run (LIVE-TEST
      // §8.1) is the only thing that can say how often ML really omits it. A
      // silent degrade would leave that question permanently unanswerable.
      console.warn('[mercado-livre] moderação sem REASON — mantida apenas pelo filtro', {
        nome,
        secoes: evidences(moderation).map((e) => e.section_name),
      });
    }

    const evidencias = evidences(moderation);
    out.push(
      mlModeracaoSchema.parse({
        nome,
        // Verbatim. ML sends two formats for this one field and neither is
        // safe to normalise here — see the schema's docblock.
        dataCriacao: moderation.date_created ?? null,
        motivo,
        remedio: wording(moderation, WORDING_REMEDY),
        secoes: distinct(evidencias.map((e) => e.section_name)),
        evidencias: distinct(evidencias.map((e) => e.text_matched)),
      }),
    );
    if (out.length >= MAX_MODERACOES) break;
  }
  return out;
}

/** The one ML method a moderation read needs (injectable for tests). */
export interface ModeracaoApi {
  getLastModeration(referenceId: string): Promise<MlModeration[]>;
}

/**
 * ML's active moderations for one listing, or `[]` when there are none.
 *
 * Shared by `itemsStatusSync` (the webhook) and `reverificarAnuncio` (the
 * operator's manual re-check) so the two can never disagree about when a
 * moderation is read or what a 404 means.
 *
 * ⚠️ GATED, not unconditional — see {@link precisaConsultarModeracao}. `items`
 * fires for every change to every listing the seller owns, and the sync's cost
 * model is that a healthy one costs exactly one `GET /items/{id}`. Gating also
 * bounds the blast radius: a moderation-endpoint outage cannot stall healthy
 * listings, because they never touch it.
 *
 * ⚠️ A **404 is DATA** — "this element has no active moderation" — and becomes
 * `[]`, never a failure.
 *
 * ⚠️ Everything else RETHROWS, including a 5xx, and this is the judgement call
 * worth stating. Swallowing a transient would persist `[]`, i.e. "not
 * moderated", which is indistinguishable from a healthy listing and is exactly
 * the no-explanation state this module exists to end. Throwing writes nothing at
 * all, the queue retries, and the listing keeps what it had until ML answers.
 * Note a 401 never arrives here as `MercadoLivreHttpError` — `api.ts` raises
 * `MercadoLivreReauthRequiredError` — so reauth rethrows through the same door.
 */
export async function consultarModeracoes(
  api: ModeracaoApi,
  itemId: string,
  status: string | null | undefined,
  subStatus: readonly string[] | null | undefined,
): Promise<MlModeracao[]> {
  if (!precisaConsultarModeracao(status, subStatus)) return [];
  let raw: MlModeration[];
  try {
    raw = await api.getLastModeration(moderationReferenceId(itemId));
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) return [];
    throw err; // transient (5xx/429/network) or reauth → the caller retries
  }
  return mapModeracoes(raw);
}

/**
 * Value equality for the link-doc change gate.
 *
 * ⚠️ Needed because `moderacoes` has to count as a change in its own right, the
 * same way `errorsToClear` does: a listing already at the right
 * estado/status/sub_status would otherwise short-circuit on `unchanged` and keep
 * a moderation that ML has since lifted. A stale reason on a healthy listing is
 * indistinguishable from a real one, which makes it worse than no reason at all.
 *
 * Compares the fields that are DISPLAYED. `dataCriacao` is included because the
 * same filter firing again is genuinely new information for the operator; the ML
 * moderation `id` is not compared at all, and is not even stored — the docs warn
 * it stops existing once the moderation resolves.
 */
export function moderacoesIguais(
  a: readonly MlModeracao[] | null | undefined,
  b: readonly MlModeracao[] | null | undefined,
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    const x = aa[i];
    const y = bb[i];
    if (!x || !y) return false;
    if (
      x.nome !== y.nome ||
      x.dataCriacao !== y.dataCriacao ||
      x.motivo !== y.motivo ||
      x.remedio !== y.remedio ||
      !stringArraysEqual(x.secoes, y.secoes) ||
      !stringArraysEqual(x.evidencias, y.evidencias)
    ) {
      return false;
    }
  }
  return true;
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Read a link doc's stored `moderacoes` back out of the raw Firestore payload.
 *
 * Tolerant on purpose — every other reader in this module's neighbourhood
 * (`applyResolvedStatus`, `syncFamilyMember`) works from
 * `Record<string, unknown>` snapshots that may predate the field entirely, or
 * carry whatever a legacy corpus row has.
 */
export function moderacoesArmazenadas(raw: Record<string, unknown>): MlModeracao[] {
  if (!Array.isArray(raw.moderacoes)) return [];
  const out: MlModeracao[] = [];
  for (const entry of raw.moderacoes) {
    const parsed = mlModeracaoSchema.safeParse(entry);
    // ⚠️ The SAME gate {@link mapModeracoes} applies on the way in, and it has to
    // be repeated here rather than left to the schema: every field is nullable
    // (see `motivo`) and the shape is `.passthrough()`, so a junk object parses
    // clean. An all-null entry would then count as a moderation — enough to win
    // the family fold's explainability tie-break and to render an alert saying
    // nothing. Read and write agree on what counts as a moderação, or the fold
    // sees one where the sync never stored one.
    if (parsed.success && (parsed.data.motivo != null || parsed.data.nome != null)) {
      out.push(parsed.data);
    }
  }
  return out;
}
