import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { millisSinceEpoch } from './shared/datetime';

// Mirror `PERM.integracao` from @delfrance/auth, kept as local literals like
// every other schema file (schemas must not import @delfrance/auth — circular).
//
// Reusing the integracao bits rather than minting a `configIa` bit is
// deliberate: whoever can already connect an account and publish to Mercado
// Livre is the same person who tunes the agent that fills its attributes. A
// dedicated bit would have meant a coordinated change across @delfrance/auth,
// the cargos editor, both regenerated rulesets and their snapshots, plus
// re-minting custom claims for every affected user before they could open the
// page. ⚠️ The page ALSO sits under /configuracoes, whose layout wraps every
// child in `RequirePerm bit={PERM.configuracoes.read}` — so viewing needs
// configuracoes.read and saving needs integracao.write. That pairing is
// intentional but it is two gates, not one.
const PERM_INTEGRACAO_READ = 1n << 56n;
const PERM_INTEGRACAO_WRITE = 1n << 57n;
const PERM_INTEGRACAO_DELETE = 1n << 58n;

/**
 * Which backend serves the model.
 *
 * `vertex` is what ships and what the IAM grant covers (ADC on the App Hosting
 * compute service account, no key anywhere). `googleai` exists because the same
 * `@google/genai` client speaks both and a future deployment might not have a
 * Vertex-enabled project — it is NOT wired today, and the suggestion route
 * ignores anything but `vertex`.
 */
export const provedorIaSchema = z.enum(['vertex', 'googleai']);
export type ProvedorIa = z.infer<typeof provedorIaSchema>;

/** Named members of {@link provedorIaSchema}; the values are already the names. */
export const PROVEDOR_IA = {
  vertex: 'vertex',
  googleai: 'googleai',
} as const satisfies Record<string, ProvedorIa>;

/**
 * The shipped default model, and the last link in the resolution chain.
 *
 * Resolution order at call time is **config doc → `MERCADO_LIVRE_AI_MODEL` env
 * → this constant**, and the resolved name is re-validated server-side against
 * the live model list, so a stale config doc can never 500 the route.
 *
 * ⚠️ Changing this constant is a deploy. That is the whole point of the config
 * doc: the model becomes a dropdown, and the default matters far less than the
 * resolution order does.
 */
export const CONFIG_IA_MODELO_PADRAO = 'gemini-3.5-flash-lite';

/**
 * ConfigIa — one document per AI agent, at `configIa/{agenteId}`.
 *
 * The shape follows `counters`: a singleton keyed by purpose rather than a
 * collection anyone lists. The first (and today only) agent is
 * {@link CONFIG_IA_ML_ATRIBUTOS_DOC_ID}, which fills Mercado Livre category
 * attributes from a produto's name, brand, description and one photo.
 *
 * **What is editable and what is not.** `promptSistema` is editable because the
 * wording of the instruction is exactly the thing an operator needs to iterate
 * on without a deploy. The **response schema is not** — it is rebuilt
 * server-side from ML's own category metadata on every call
 * (`buildAttributeSchema`), and it is what carries the anti-hallucination
 * guarantee: no `required`, no `nullable`, no `anyOf`, so omission stays the
 * cheapest thing the model can do. Exposing it as text would put that guarantee
 * one typo away from gone.
 *
 * ⚠️ **No `defaultQuery`.** A singleton read by known id needs no index, and
 * declaring one would trip the `delfrance/default-query-needs-index` lint error
 * for no benefit (root `CLAUDE.md` rule 1).
 */
export const configIaSchema = z.object({
  /**
   * Model name as the provider spells it (`gemini-3.5-flash-lite`). Populated
   * from a live `GET /ia/modelos` list, never free text — and re-validated
   * against that same list at call time, because a model can be retired between
   * the save and the next suggestion.
   *
   * ⚠️ **`null`, not the default model.** Defaulting this to
   * {@link CONFIG_IA_MODELO_PADRAO} would break the documented resolution order
   * outright: an absent document parses with every default filled in, so a
   * "stored" model would always be present and the
   * `MERCADO_LIVRE_AI_MODEL` env step could never be reached. It also freezes
   * the default — a tenant who once saved this page would never receive a later
   * improvement to the shipped choice. `null` means "no explicit choice; run the
   * chain", which is the same reasoning as `promptSistema` below.
   */
  modelo: z.string().min(1).nullable().default(null).describe('Modelo'),
  provedor: provedorIaSchema.default(PROVEDOR_IA.vertex).describe('Provedor'),
  /**
   * The system instruction. `null` means "use the shipped default"
   * (`DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION`) — which is NOT the same as an
   * empty string, and is why this is nullable rather than defaulting to the
   * text: storing a copy of the default would freeze it, so a later improvement
   * to the shipped wording would silently never reach any tenant that had once
   * opened this page.
   */
  promptSistema: z.string().nullable().default(null).describe('Instrução do sistema'),
  /**
   * Upper bound on the answer. Generous by default: the answer is one small
   * JSON object, and a cap that truncates it produces invalid JSON rather than
   * a short answer — the failure mode is total, not graceful.
   */
  maxOutputTokens: z
    .number()
    .int()
    .min(256)
    .max(65_536)
    .default(8_192)
    .describe('Máximo de tokens'),
  /**
   * Sampling temperature. Defaults to 0 because this is an extraction task, not
   * a writing task: the same produto should yield the same attributes twice.
   */
  temperatura: z.number().min(0).max(2).default(0).describe('Temperatura'),
  /**
   * Kill switch. `false` makes the suggestion route decline with a structured
   * error instead of calling — the one control that stops spend without a
   * deploy and without revoking IAM.
   */
  ativo: z.boolean().default(true).describe('Ativo'),
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().default(null),
});

export type ConfigIa = z.infer<typeof configIaSchema>;

/**
 * Document id of the Mercado Livre attribute agent. A slug, not a generated id:
 * the doc is a singleton looked up by known id from both `apps/web` and
 * `apps/mercado-livre`, so both sides must agree on the spelling without
 * consulting Firestore.
 */
export const CONFIG_IA_ML_ATRIBUTOS_DOC_ID = 'ml-atributos';

/**
 * Document id of the Mercado Livre size-chart agent, which reads measurements
 * off a photo of the supplier's table and fills the guia's grid.
 *
 * ⚠️ **A separate document, not a second use of `ml-atributos`.** The two agents
 * want genuinely different settings: attribute filling is inference from a
 * product photo, measurement extraction is transcription from a table, and the
 * system instruction that makes one work makes the other worse. Separate
 * documents also mean separate kill switches — turning off a misbehaving agent
 * must not disable the other, since `ativo: false` is the only control that
 * stops spend without a deploy.
 */
export const CONFIG_IA_ML_MEDIDAS_DOC_ID = 'ml-medidas';

/** Every agent id, so a UI can enumerate them without hardcoding the list. */
export const CONFIG_IA_AGENTES = [
  CONFIG_IA_ML_ATRIBUTOS_DOC_ID,
  CONFIG_IA_ML_MEDIDAS_DOC_ID,
] as const;

export type ConfigIaAgenteId = (typeof CONFIG_IA_AGENTES)[number];

export const configIaMeta: CollectionMetadata = {
  collectionPath: 'configIa',
  permissions: {
    read: PERM_INTEGRACAO_READ,
    write: PERM_INTEGRACAO_WRITE,
    delete: PERM_INTEGRACAO_DELETE,
  },
};

export const configIa = { schema: configIaSchema, meta: configIaMeta };
