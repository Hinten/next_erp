/**
 * Zod schemas for every JSON body the apps/mercado-livre backend answers with,
 * and the public types inferred from them.
 *
 * ## Why the schema is the source and the type is inferred
 *
 * These used to be hand-written `interface`s in `client.ts`, and `call<T>()`
 * ended in `return parsed as T` — a compile-time assertion with no runtime
 * check. On any 2xx the caller got whatever arrived wearing a type nobody
 * verified, which is how a stale backend's 200 was reported as a successful
 * mint when it had actually reused two accounts and wiped a credential
 * (#1295 → #1302). Deriving the type from the schema means there is exactly one
 * definition, so the check and the type cannot drift.
 *
 * ## Three rules these schemas follow
 *
 * 1. ⚠️ **Unknown keys pass.** Zod 4 objects strip by default and nothing here
 *    is `.strict()`. `apps/web` calls the DEPLOYED channel backend, so the
 *    browser is routinely OLDER *or* NEWER than the thing answering it — a
 *    strict object would turn every forward deploy into an outage.
 * 2. ⚠️ **A field the wire may omit is declared optional, with the fallback the
 *    consumer already applies.** Every `?? []` / `?? null` in a consumer is
 *    evidence about the wire, not a defensive tic: `itemIds` (#798),
 *    `allowedUnits` (`attributeForm.ts`), `roots` (`categoriaTree.ts`),
 *    `docId` (#1302). Those become `.default(…)` here so the parse tolerates
 *    exactly what production already tolerates, and the public type is
 *    unchanged. This is what makes "throw on a mismatch" safe: a throw then
 *    means the response is genuinely not what we claimed.
 * 3. ⚠️ **Numbers are tolerant when the value ORIGINATES at Mercado Livre**
 *    (`wireInt()` / `wireNumber()` from `@delfrance/core/wire`) and strict
 *    (`z.number()`) when our own backend computed it. ML quotes numbers
 *    inconsistently and the value rides through our proxy unchanged, so a
 *    strict `z.number()` on a forwarded id costs the WHOLE response — #1087 is
 *    the worked example, where one quoted `order_id` stopped a payment
 *    importing. A count or a timestamp we produced is different: a string there
 *    is our bug and should be loud. `packages/core/src/wire/index.ts` states the
 *    same three-way rule.
 *
 * ⚠️ **Response shapes only.** Request payloads keep their hand-written
 * interfaces in `client.ts` — for an outbound body strictness is correct, and
 * mixing the two here would put a tolerant number on a field we serialise
 * ourselves.
 */
import { z } from 'zod';

import { wireInt, wireNumber } from '@delfrance/core/wire';

export const contaSchema = z.object({
  connected: z.boolean(),
  me: z
    .object({
      /** ML's own user id, forwarded verbatim — hence tolerant. */
      id: wireInt(),
      nickname: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
});
export type MercadoLivreConta = z.infer<typeof contaSchema>;

export const publicarResultSchema = z.object({
  /** The parent link's external id — a FAMILY id under User Products (#798). */
  itemId: z.string(),
  /** Old-shape estado code, 1–2 chars ('p' publicado, 'pa' pausado, 'E' erro, …). */
  estado: z.string(),
  permalink: z.string().nullable(),
  /**
   * Every ML item the publish wrote: one normally, one PER VARIATION for a
   * User-Products family.
   *
   * ⚠️ Optional because this app talks to the DEPLOYED channel backend, not the
   * one in this checkout — a revision predating #798 answers without it, and
   * `listingLinks.ts` must still produce the old single-item sentence.
   */
  itemIds: z.array(z.string()).optional(),
  /** Items closed because their ERP variação no longer exists (UP only). */
  orfaosEncerrados: z.array(z.string()).optional(),
});
export type MercadoLivrePublicarResult = z.infer<typeof publicarResultSchema>;

/** One member of a re-verified User-Products family (#1142). */
export const reverificarMembroSchema = z.object({
  itemId: z.string(),
  memberDocId: z.string(),
  /**
   * Did ML answer for this member? `false` means its stored status still stands.
   * ⚠️ Not the same as `status: 'closed'` — an unreadable member is unknown.
   */
  lido: z.boolean(),
  status: z.string().nullable(),
  subStatus: z.array(z.string()).nullable(),
  enviavel: z.boolean(),
});
export type MercadoLivreReverificarMembro = z.infer<typeof reverificarMembroSchema>;

export const reverificarResultSchema = z.object({
  /** Old-shape estado code derived from the listing's fresh ML status. */
  estado: z.string(),
  /** Raw ML `status` as of the re-check (`active`/`paused`/`closed`/…). */
  status: z.string().nullable(),
  subStatus: z.array(z.string()).nullable(),
  /** Whether the stock sweep will send to this listing again. */
  enviavel: z.boolean(),
  /**
   * Present only for a User-Products FAMILY, one entry per member — the level at
   * which a family actually has a status. The four fields above are the FOLD
   * over these, which is all the parent link can carry.
   *
   * ⚠️ Only used for the toast's wording. The per-variation table reads the
   * member links from Firestore directly and repaints from the live snapshot, so
   * it does not depend on this and shows the same values after a reload.
   */
  membros: z.array(reverificarMembroSchema).optional(),
});
export type MercadoLivreReverificarResult = z.infer<typeof reverificarResultSchema>;

export const importarResultSchema = z.object({
  /** The created/updated ERP produto id. */
  produtoId: z.string(),
  /** Old-shape estado code derived from the ML listing status. */
  estado: z.string(),
  nome: z.string(),
  /** True when a new produto was created (false = an existing one was re-synced). */
  created: z.boolean(),
});
export type MercadoLivreImportarResult = z.infer<typeof importarResultSchema>;

/** One per-item failure recorded on a mass-import job (capped server-side). */
export const massImportFailureSchema = z.object({
  itemId: z.string(),
  error: z.string(),
});
export type MercadoLivreMassImportFailure = z.infer<typeof massImportFailureSchema>;

/** Progress snapshot of a mass-import job (`GET importar-todos/status`). */
export const massImportStatusSchema = z.object({
  /** `cancelled` is operator-initiated — see `cancelMassImport`. */
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  // Counters and stamps this backend computes itself: a string here is OUR bug,
  // so these stay strict (rule 3).
  scanned: z.number(),
  imported: z.number(),
  created: z.number(),
  skipped: z.number(),
  failureCount: z.number(),
  failures: z.array(massImportFailureSchema),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  erro: z.string().nullable(),
});
export type MercadoLivreMassImportStatus = z.infer<typeof massImportStatusSchema>;

/** One contained per-item skip on a price-sync job (`itemId` is null for plan-time skips). */
export const priceSyncSkipSchema = z.object({
  itemId: z.string().nullable(),
  produtoId: z.string(),
  code: z.string(),
});
export type MercadoLivrePriceSyncSkip = z.infer<typeof priceSyncSkipSchema>;

/** One per-item failure recorded on a price-sync job — a skip plus its error (capped server-side). */
export const priceSyncFailureSchema = priceSyncSkipSchema.extend({ error: z.string() });
export type MercadoLivrePriceSyncFailure = z.infer<typeof priceSyncFailureSchema>;

/** Progress snapshot of a price-sync job (`GET atualizar-precos/status`). */
export const priceSyncStatusSchema = z.object({
  status: z.enum(['running', 'completed', 'failed']),
  baixarPreco: z.boolean(),
  planejados: z.number(),
  enviados: z.number(),
  pulados: z.number(),
  /**
   * Anúncios the job could not have enumerated — a drifted denorm, a link on a
   * variation child, or a malformed `paiId` (#1072).
   *
   * ⚠️ This is a SUBSET of `pulados`, not a sibling of it: each finding is
   * recorded through the same `registerSkip` that increments `pulados`, so it
   * rides the shared `skips` sample where the operator can actually read the
   * rows. What this counter adds is that it is exact and uncapped — the `skips`
   * list stops at 200 and can be exhausted by the plan phase alone, so on a
   * drifted catalogue the count is the only honest number. Zero is what makes
   * `completed` mean what it says.
   */
  naoEnumerados: z.number(),
  falhas: z.number(),
  pausas: z.number(),
  /** The first skips, for display — capped server-side; `pulados` stays exact. */
  skips: z.array(priceSyncSkipSchema),
  /** The first failures, for display — capped server-side; `falhas` stays exact. */
  failures: z.array(priceSyncFailureSchema),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  erro: z.string().nullable(),
});
export type MercadoLivrePriceSyncStatus = z.infer<typeof priceSyncStatusSchema>;

/** The shared per-flow tally carried by both push envelopes. */
const resumoEnvioSchema = z.object({
  enviados: z.number(),
  pulados: z.number(),
  falhas: z.number(),
  naoTentados: z.number(),
});

/**
 * One listing's outcome from an on-demand stock push (#819).
 *
 * Channel-NEUTRAL on purpose (`anuncioId`, not `itemId`): the second
 * marketplace's `/api/marketplace/<canal>/enviar-estoque` answers with the same
 * envelope, and `lib/marketplace/estoque` dispatches without knowing which one
 * replied.
 */
export const envioEstoqueListingSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  variacaoProdutoId: z.string().nullable(),
  anuncioId: z.string().nullable(),
  linkDocId: z.string().nullable(),
  outcome: z.enum(['enviado', 'pulado', 'falha', 'nao-tentado']),
  /** Machine code; null only on `'enviado'`. */
  motivo: z.string().nullable(),
  /** Operator-facing pt-BR text — the BACKEND owns this wording. */
  mensagem: z.string(),
  quantidade: z.number().nullable(),
  variacoes: z.number().nullable(),
  rearme: z
    .object({
      executado: z.boolean(),
      estado: z.string().nullable(),
      enviavel: z.boolean(),
    })
    .nullable(),
});
export type MercadoLivreEnvioEstoqueListing = z.infer<typeof envioEstoqueListingSchema>;

/** A requested produto that produced no listing at all, and why. */
export const envioEstoqueSemEnvioSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  motivo: z.string(),
  mensagem: z.string(),
});
export type MercadoLivreEnvioEstoqueSemEnvio = z.infer<typeof envioEstoqueSemEnvioSchema>;

export const envioEstoqueResultSchema = z.object({
  canal: z.literal('mercado-livre'),
  integracaoId: z.string(),
  contaNome: z.string().nullable(),
  solicitados: z.number(),
  familias: z.number(),
  resumo: resumoEnvioSchema,
  listings: z.array(envioEstoqueListingSchema),
  produtosSemEnvio: z.array(envioEstoqueSemEnvioSchema),
  /** ISO-8601 — set when the conta is rate-limit paused. */
  pausadoAte: z.string().nullable(),
});
export type MercadoLivreEnvioEstoqueResult = z.infer<typeof envioEstoqueResultSchema>;

/**
 * One listing's outcome from an on-demand PRICE push (#804).
 *
 * Channel-NEUTRAL on purpose (`anuncioId`, not `itemId`): the second
 * marketplace's `/api/marketplace/<canal>/enviar-precos` answers with the same
 * envelope, and `lib/marketplace/preco` dispatches without knowing which one
 * replied.
 *
 * ⚠️ `motivo` is UPPER_SNAKE here and kebab on the stock envelope. That is not
 * an oversight — these are the price stack's own codes, the same ones the
 * account-wide job persists in its `skips` list. Nothing in this layer reads
 * them; `mensagem` is what gets rendered.
 */
export const envioPrecoListingSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  variacaoProdutoId: z.string().nullable(),
  anuncioId: z.string().nullable(),
  linkDocId: z.string().nullable(),
  outcome: z.enum(['enviado', 'pulado', 'falha', 'nao-tentado']),
  /** Machine code; null only on `'enviado'`. */
  motivo: z.string().nullable(),
  /** Operator-facing pt-BR text — the BACKEND owns this wording. */
  mensagem: z.string(),
  /**
   * The price actually sent; null when nothing was sent.
   *
   * ⚠️ Money, and `precoAnterior` is read back OFF the ML listing — so both are
   * tolerant per rule 3. A quoted amount must never cost the whole envelope.
   */
  preco: wireNumber().nullable(),
  /** What the listing carried before, when the run got far enough to read it. */
  precoAnterior: wireNumber().nullable(),
  variacoes: z.number().nullable(),
});
export type MercadoLivreEnvioPrecoListing = z.infer<typeof envioPrecoListingSchema>;

export const envioPrecoResultSchema = z.object({
  canal: z.literal('mercado-livre'),
  integracaoId: z.string(),
  contaNome: z.string().nullable(),
  solicitados: z.number(),
  familias: z.number(),
  resumo: resumoEnvioSchema,
  listings: z.array(envioPrecoListingSchema),
  produtosSemEnvio: z.array(envioEstoqueSemEnvioSchema),
  /** ISO-8601 — set when ML rate-limited the conta. */
  pausadoAte: z.string().nullable(),
});
export type MercadoLivreEnvioPrecoResult = z.infer<typeof envioPrecoResultSchema>;

/**
 * The RUNNING jobs of both bulk flows for a set of contas
 * (`GET jobs-em-andamento`). Each entry carries the `jobId` the caller then
 * polls through the per-flow `…Status` methods, plus the `integracaoId` that
 * places it against a row. Running-only by design: a job that finished while
 * the page was closed is not listed (#816).
 */
export const jobsEmAndamentoSchema = z.object({
  importacoes: z.array(
    massImportStatusSchema.extend({ jobId: z.string(), integracaoId: z.string() }),
  ),
  enviosPreco: z.array(
    priceSyncStatusSchema.extend({ jobId: z.string(), integracaoId: z.string() }),
  ),
});
export type MercadoLivreJobsEmAndamento = z.infer<typeof jobsEmAndamentoSchema>;

/** A node of the ML category tree (`GET categorias`). */
export const categoriaNoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});
export type MercadoLivreCategoriaNo = z.infer<typeof categoriaNoSchema>;

export const categoriasSchema = z.object({
  /**
   * Populated only when no `categoryId` was asked for.
   *
   * ⚠️ `.default(null)` rather than a bare `.nullable()`: `categoriaTree.ts`
   * reads it as `data.roots ?? []`, which is the evidence that a backend may
   * omit the key entirely rather than send `null`.
   */
  roots: z.array(categoriaNoSchema).nullable().default(null),
  node: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      /** Ancestors, root-first — the cascade's breadcrumb. */
      pathFromRoot: z.array(categoriaNoSchema),
      children: z.array(categoriaNoSchema),
      /** Only a leaf has listing types and attributes. */
      isLeaf: z.boolean(),
      settings: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
});
export type MercadoLivreCategorias = z.infer<typeof categoriasSchema>;

/** One ML category suggestion (`GET categorias/sugestoes`). */
export const categoriaSugestaoSchema = z.object({
  categoryId: z.string(),
  categoryName: z.string().nullable(),
  domainId: z.string().nullable(),
  domainName: z.string().nullable(),
  /**
   * Ancestor trail, root-first, resolved server-side because
   * `domain_discovery/search` returns only the LEAF name.
   *
   * ⚠️ Without it the picker is unusable, not merely terse: ML files the same
   * leaf name (e.g. "Camisetas e Regatas") under several different parents, so
   * every suggestion renders identically and the operator cannot tell which is
   * which. `null` when the path could not be resolved — the row degrades to its
   * leaf name rather than disappearing.
   */
  pathFromRoot: z
    .array(z.object({ id: z.string(), name: z.string().nullable() }))
    .nullable()
    .default(null),
});
export type MercadoLivreCategoriaSugestao = z.infer<typeof categoriaSugestaoSchema>;

/**
 * One editable ML category attribute (`GET categorias/atributos`).
 *
 * Already filtered and normalised server-side: ERP-owned ids (SELLER_SKU,
 * PACKAGE_*), hidden attributes, size-chart attributes and out-of-scope
 * variation attributes never appear here, and the list arrives ordered
 * required-first.
 */
export const categoriaAtributoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** `string | number | number_unit | boolean | list`, or whatever ML adds. */
  valueType: z.string().nullable(),
  values: z.array(z.object({ id: z.string().nullable(), name: z.string().nullable() })),
  /** Helper text (`hint`, falling back to `tooltip`). */
  hint: z.string().nullable(),
  /** ML-sourced, hence tolerant (rule 3). */
  valueMaxLength: wireInt().nullable(),
  defaultUnit: z.string().nullable(),
  /**
   * ⚠️ `.default([])`, because `attributeForm.ts` already reads this as
   * `attr.allowedUnits ?? []` "despite the type saying otherwise" — a response
   * predating the field would otherwise blank the WHOLE attribute grid over a
   * unit. That `??` is the evidence; this is where it gets written down.
   */
  allowedUnits: z
    .array(z.object({ id: z.string().nullable(), name: z.string().nullable() }))
    .default([]),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  required: z.boolean(),
  multivalued: z.boolean(),
  readOnly: z.boolean(),
  relevance: wireInt().nullable(),
});
export type MercadoLivreCategoriaAtributo = z.infer<typeof categoriaAtributoSchema>;

export const categoriaAtributosSchema = z.object({
  /** False ⇒ a mid-tree category; keep the operator in the cascade. */
  leaf: z.boolean(),
  atributos: z.array(categoriaAtributoSchema),
  /** Why an attribute was withheld, so a gap is explainable. */
  omitidos: z.array(z.object({ id: z.string(), motivo: z.string() })),
});
export type MercadoLivreCategoriaAtributos = z.infer<typeof categoriaAtributosSchema>;

/** The listing types available for a leaf category (`GET tipos-anuncio`). */
export const tiposAnuncioSchema = z.object({
  leaf: z.boolean(),
  tipos: z.array(categoriaNoSchema),
});
export type MercadoLivreTiposAnuncio = z.infer<typeof tiposAnuncioSchema>;

/** One party's stated expectation on a claim. */
export const expectativaReclamacaoSchema = z.object({
  playerRole: z.string().nullable(),
  expectedResolution: z.string().nullable(),
  status: z.string().nullable(),
});
export type MercadoLivreExpectativaReclamacao = z.infer<typeof expectativaReclamacaoSchema>;

/** A seller action ML still offers, with its SLA clock. */
export const prazoAcaoSchema = z.object({
  acao: z.string(),
  obrigatoria: z.boolean(),
  prazo: z.string().nullable(),
});
export type MercadoLivrePrazoAcao = z.infer<typeof prazoAcaoSchema>;

/** One partial-refund offer, or a recommendation/restriction about them. */
export const ofertaParcialSchema = z.object({
  /** ML-sourced money and percentages — tolerant per rule 3. */
  amount: wireNumber().nullable(),
  percentage: wireNumber().nullable(),
});
export type MercadoLivreOfertaParcial = z.infer<typeof ofertaParcialSchema>;

export const conselhoParcialSchema = z.object({
  percentage: wireNumber().nullable(),
  reason: z.string().nullable(),
  type: z.string().nullable(),
});
export type MercadoLivreConselhoParcial = z.infer<typeof conselhoParcialSchema>;

/**
 * Live state of one Mercado Livre claim.
 *
 * ⚠️ **A snapshot, never a cache.** `acoesDisponiveis` is ML's answer to "what
 * may this seller do right now", derived from the claim's stage and status, and
 * it empties as the claim closes. Anything rendered from it has to be refetched
 * rather than remembered.
 */
export const reclamacaoEstadoSchema = z.object({
  /** ML's claim id — tolerant per rule 3. */
  claimId: wireInt(),
  status: z.string().nullable(),
  stage: z.string().nullable(),
  tipo: z.string().nullable(),
  reasonId: z.string().nullable(),
  tipoReclamacao: z.enum(['PNR', 'PDD']).nullable(),
  /**
   * ⚠️ No `.default([])`, and this is the one where it would cost something.
   * The doc above says this list "empties as the claim closes", so a defaulted
   * `[]` renders "no actions available" identically to a claim ML did not
   * answer for at all — the silent-nothing this stack exists to remove.
   * `claimResolve.ts:207` sets it unconditionally, so there is no evidence for
   * a default and no wire shape it would rescue.
   */
  acoesDisponiveis: z.array(z.string()),
  prazos: z.array(prazoAcaoSchema),
  /**
   * ⚠️ These are the WIRE names, and they are not what the interface said.
   *
   * `claimResolve.ts:109-110` declares `podeEnviarMensagem` /
   * `motivoSemMensagem` — renamed on the backend in `dbe53a99` and never
   * carried across to `apps/web`, which kept `podeResponder` /
   * `motivoSemResposta`. The cast hid it, and it is a LIVE bug on main:
   * `ReclamacaoMlPanel` read `motivoSemResposta`, always got `undefined`, and
   * always fell through to the generic "o Mercado Livre não oferece nenhuma
   * ação" instead of ML's real reason.
   *
   * Internally the backend still calls it `podeResponder`
   * (`claimResolve.ts:209` maps `acionabilidade.podeResponder` onto the wire
   * name), which is exactly how the two drifted apart.
   */
  podeEnviarMensagem: z.boolean(),
  motivoSemMensagem: z.string().nullable(),
  /** `null` WITH `expectativasIndisponiveis` means the read failed, not "none". */
  expectativas: z.array(expectativaReclamacaoSchema).nullable(),
  expectativasIndisponiveis: z.boolean(),
  ofertasParciais: z
    .object({
      currency_id: z.string().nullable(),
      available_offers: z.array(ofertaParcialSchema),
      recommendations: z.array(conselhoParcialSchema),
      restrictions: z.array(conselhoParcialSchema),
    })
    .nullable(),
});
export type MercadoLivreReclamacaoEstado = z.infer<typeof reclamacaoEstadoSchema>;

/** What a successful ML chat reply reports back. */
export const respostaChatSchema = z.object({
  conversaId: z.string(),
  mensagemId: z.string(),
  /**
   * Non-null when the send also CLOSED the thread — answering a question is
   * terminal, so the composer must go read-only immediately rather than wait
   * for the next notification to import the new status.
   */
  respostaBloqueada: z.string().nullable(),
});
export type MercadoLivreRespostaChat = z.infer<typeof respostaChatSchema>;

/**
 * `GET /anuncio-teste` — the data ML requires a test listing to carry, resolved
 * against the live catalogue, plus whether the target account is a test user.
 */
export const anuncioTesteSchema = z.object({
  title: z.string(),
  descricao: z.string(),
  /**
   * A **leaf** under ML's "Outros", which the route descends to — only a leaf can
   * be published into. Null when the site has no such root, or when no leaf is
   * reachable beneath it within the depth cap; the operator then picks.
   */
  categoryId: z.string().nullable(),
  /**
   * Names from the "Outros" root down to `categoryId`, so the alert can say which
   * category was chosen. Null whenever `categoryId` is.
   */
  categoriaPath: z.array(z.string()).nullable(),
  /**
   * Why there is no category, when there isn't one. `'sem-raiz'` = ML's site has
   * no root named "Outros"; `'sem-folha'` = it has one, but no leaf was reachable
   * beneath it. Null when a category WAS resolved. The two need different
   * actions, so one "não foi possível" message for both sent operators hunting.
   */
  categoriaMotivo: z.enum(['sem-raiz', 'sem-folha']).nullable(),
  /** Lowest-exposure type the category offers; null ⇒ the operator picks. */
  listingTypeId: z.string().nullable(),
  conta: z.object({
    nickname: z.string().nullable(),
    /** False ⇒ warn: ML forbids test listings on a real seller account. */
    ehContaDeTeste: z.boolean(),
  }),
});
export type MercadoLivreAnuncioTeste = z.infer<typeof anuncioTesteSchema>;

/**
 * One Mercado Livre test user, as stored by the backend.
 *
 * ⚠️ `password` is a live credential ML shows exactly once and never reissues.
 * Render it, let the operator copy it — do not log it, and do not put it in a
 * query string or an analytics event.
 */
export const usuarioTesteSchema = z.object({
  role: z.enum(['vendedor', 'comprador']),
  /**
   * The Firestore document holding this record — `vendedor` / `comprador` for
   * the pair bootstrap, `${role}-${id}` for an additional mint.
   *
   * ⚠️ Rendered next to every account because it is the ONLY field that can
   * answer "did the new buyer land beside the old one, or on top of it?". Every
   * buyer carries `role: 'comprador'`, so without it a list that failed to grow
   * is indistinguishable from a document that was replaced.
   *
   * ⚠️ `.nullish()` on the INPUT and `string | null` on the OUTPUT: every
   * deployment older than this field omits the key entirely — including one that
   * already mints correctly — and the panel NAMES the absence rather than
   * rendering a blank chip (#1302). Refusing the read instead would destroy more
   * than it protects: these stored passwords are the only copy that exists.
   * An empty string means the same thing as absent, so it lands on `null` too.
   */
  docId: z
    .string()
    .nullish()
    .transform((v) => (typeof v === 'string' && v !== '' ? v : null)),
  /** ML user ids — tolerant per rule 3. */
  id: wireInt(),
  nickname: z.string(),
  password: z.string(),
  site_id: z.string(),
  site_status: z.string().nullable(),
  email: z.string().nullable(),
  /** Our own stamp, so strict. */
  createdAt: z.number().nullable(),
  createdByUserId: wireInt().nullable(),
  /**
   * ML's e-mail verification code for this account — the trailing digits of
   * `id`, in both lengths ML may ask for. There is no inbox to check, so
   * without these the operator cannot get past a verification prompt.
   */
  codigosVerificacaoEmail: z.object({ quatro: z.string(), seis: z.string() }),
});
export type MercadoLivreUsuarioTeste = z.infer<typeof usuarioTesteSchema>;

/** Result of the dev-only mint. */
export const usuariosTesteResultSchema = z.object({
  usuarios: z.array(usuarioTesteSchema),
  /** Roles minted on this run — each consumed one of the account's ten slots. */
  criados: z.array(z.enum(['vendedor', 'comprador'])),
  /** Roles already stored, reused instead of re-minted. */
  reaproveitados: z.array(z.enum(['vendedor', 'comprador'])),
  /** Credential docs deleted from the bootstrap conta — it is now disconnected. */
  credenciaisRemovidas: z.number(),
  /**
   * Whether the credential was revoked at all.
   *
   * ⚠️ Read THIS, never `credenciaisRemovidas === 0` — a revocation against an
   * already-empty subcollection also returns zero, so the count cannot tell
   * "we left this conta connected" from "there was nothing left to delete".
   *
   * ⚠️ **`.optional()` deliberately, and it must stay that way.** The field is
   * the CAPABILITY PROBE `exigirMintAvulso` uses to date the backend: its
   * absence is what identifies a deployment predating the single-role mint, and
   * that check answers with a message naming the deploy to run. Making it
   * required here would move the refusal into the schema and replace that
   * message with a generic field list.
   */
  credencialRevogada: z.boolean().optional(),
  conta: z.object({ id: wireInt(), nickname: z.string().nullable() }),
});
export type MercadoLivreUsuariosTesteResult = z.infer<typeof usuariosTesteResultSchema>;

/** One model the AI settings page may offer. */
export const iaModeloSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type MercadoLivreIaModelo = z.infer<typeof iaModeloSchema>;

/** One suggested cell. `value_id` is set only for a closed-list match. */
export const medidaSugestaoSchema = z.object({
  rowKey: z.string(),
  attributeId: z.string(),
  value_id: z.string().nullable(),
  value_name: z.string(),
});
export type MercadoLivreMedidaSugestao = z.infer<typeof medidaSugestaoSchema>;

/**
 * What the model was actually given.
 *
 * ⚠️ Per source, not one `comFoto` flag: the operator has to tell "the model had
 * nothing to read" apart from "the model read it and could not do it". A silent
 * text-only run is what made a working feature look broken.
 */
export const medidasContextoSchema = z.object({
  /** How many photos reached the model. */
  fotos: z.number(),
  /**
   * How many photos the tabela has, read or not.
   *
   * ⚠️ `anexadas > 0` with `fotos === 0` is a photo that exists but has no
   * readable copy yet — the operator must be told to WAIT, not to upload the
   * photo they are looking at.
   */
  anexadas: z.number(),
  descricao: z.boolean(),
  codigo: z.boolean(),
  /** Whether an already-filled chart from another conta was sent as reference. */
  referencia: z.boolean(),
});
export type MercadoLivreMedidasContexto = z.infer<typeof medidasContextoSchema>;

/**
 * One attribute the model proposes, in the shape the listing's rows already use.
 *
 * ⚠️ Redeclared here rather than imported. `@delfrance/integrations-mercado-livre`
 * is server-only at its root (its OAuth core holds the app clientSecret), which
 * is why every ML wire type in this file is a local declaration.
 *
 * ⚠️ The one DUAL shape in this file: it is both a response element
 * (`AtributosSugestao.sugestoes`) and a request element (`sugerirAtributos`'s
 * `anterior`). Every field is a string or null, so rule 3 never applies and the
 * two directions cannot disagree.
 */
export const atributoSugestaoSchema = z.object({
  id: z.string(),
  /** ML's enumerated value id, the `-1` N/A sentinel, or null for free text. */
  value_id: z.string().nullable(),
  value_name: z.string(),
  unit_id: z.string().nullable(),
});
export type MercadoLivreAtributoSugestao = z.infer<typeof atributoSugestaoSchema>;

/** `POST /sugerir-atributos` — suggestions to STAGE, never applied by the server. */
export const atributosSugestaoSchema = z.object({
  /** False ⇒ a mid-tree category; no model call was made. */
  leaf: z.boolean(),
  /** How many attributes were offered to the model. */
  atributos: z.number(),
  sugestoes: z.array(atributoSugestaoSchema),
  /** Whether a produto photo reached the model at all. */
  comFoto: z.boolean(),
});
export type MercadoLivreAtributosSugestao = z.infer<typeof atributosSugestaoSchema>;

/** `POST /sugerir-medidas` — staged suggestions, never applied server-side. */
export const medidasSugestaoSchema = z.object({
  sugestoes: z.array(medidaSugestaoSchema),
  /** How many cells were offered to the model. */
  celulas: z.number(),
  contexto: medidasContextoSchema,
  /** True when a cap or a duplicate size label dropped part of the grid. */
  truncado: z.boolean(),
});
export type MercadoLivreMedidasSugestao = z.infer<typeof medidasSugestaoSchema>;

/** `GET /ia/modelos` — the catalogue plus the currently effective resolution. */
export const iaModelosSchema = z.object({
  modelos: z.array(iaModeloSchema),
  /**
   * `'live'` = straight from the provider. `'fallback'` = the shipped list,
   * because the provider could not be reached or answered nothing usable. The
   * page must say which, rather than implying the catalogue is current.
   */
  fonte: z.enum(['live', 'fallback']),
  /** Why the list is a fallback. Present only when `fonte === 'fallback'`. */
  erro: z.string().optional(),
  /**
   * The shipped system instruction, verbatim — what runs when `promptSistema` is
   * left empty.
   *
   * ⚠️ It arrives over the wire rather than being imported: the ML integrations
   * package root is **server-only** (its OAuth core holds the app clientSecret),
   * and a copy kept in `apps/web` would drift from the text the model is
   * actually given.
   */
  promptPadrao: z.string(),
  efetivo: z.object({
    /** What a suggestion would use right now. */
    modelo: z.string(),
    /** True ⇒ the stored model is not served and this is a substitute. */
    substituido: z.boolean(),
    /**
     * Which link of the chain won. `'env'` is the one worth surfacing: a
     * backend env var silently overrides the shipped default and the operator
     * has no other way to discover it.
     */
    origem: z.enum(['config', 'env', 'padrao']),
    padrao: z.string(),
  }),
});
export type MercadoLivreIaModelos = z.infer<typeof iaModelosSchema>;

/** One chart-enabled ML domain (`GET size-charts/domains`). */
export const chartDomainSchema = z.object({
  domain_id: z.string(),
  name: z.string().nullable(),
});
export type MercadoLivreChartDomain = z.infer<typeof chartDomainSchema>;

/**
 * The domain technical-specs tree (`POST size-charts/specs`) — deeply nested,
 * ML-owned and consumed only by the chart editor's walk, so it stays opaque
 * (`unknown`); `chartSpec.ts` reads it defensively.
 *
 * ⚠️ Deliberately NOT modelled field by field. A schema over an ML-owned tree
 * we never read by name asserts nothing and would only manufacture a way to
 * reject a response the editor handles perfectly well.
 */
export const chartSpecsSchema = z.record(z.string(), z.unknown());
export type MercadoLivreChartSpecs = z.infer<typeof chartSpecsSchema>;

/**
 * The charts as ML echoes them back — opaque for the same reason as
 * `chartSpecsSchema`.
 */
const tabelasSchema = z.array(z.unknown());

/** One ML chart-validation problem (`POST size-charts/sync` → 200 data). */
export const chartValidationErrorSchema = z.object({
  chartIndex: z.number(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  /** Offending row, or null for a chart-level problem (a rejected name, …). */
  rowIndex: wireInt().nullable(),
  /** Attribute ids the cell covers — more than one for a combined column. */
  attributeIds: z.array(z.string()),
  /** The row's main-attribute value as ML echoed it, for when `rowIndex` is null. */
  rowMainValue: z.string().nullable(),
});
export type MercadoLivreChartValidationError = z.infer<typeof chartValidationErrorSchema>;

export const syncChartsResultSchema = z.object({
  /** The charts after the sync (ML ids written back where accepted). */
  tabelas: tabelasSchema,
  validationErrors: z.array(chartValidationErrorSchema),
  updated: z.boolean(),
});
export type MercadoLivreSyncChartsResult = z.infer<typeof syncChartsResultSchema>;

/** `POST size-charts/excluir` — ML accepted the REMOVAL REQUEST (see the method doc). */
export const chartDeleteResultSchema = z.object({
  requested: z.literal(true),
  message: z.string().nullable(),
  tabelas: tabelasSchema,
});
export type MercadoLivreChartDeleteResult = z.infer<typeof chartDeleteResultSchema>;

/** `POST size-charts/verificar-exclusao` — the verdict on a pending removal. */
export const chartDeleteCheckResultSchema = z.object({
  /** True ⇒ ML confirmed the removal and the guia is off the tabMedi doc. */
  removed: z.boolean(),
  /** `'ACTIVE'` = still linked to a listing; null once ML stopped serving it. */
  chartStatus: z.string().nullable(),
  tabelas: tabelasSchema,
});
export type MercadoLivreChartDeleteCheckResult = z.infer<typeof chartDeleteCheckResultSchema>;

/* -------------------------------------------------------------------------- */
/* Anonymous response envelopes                                               */
/*                                                                            */
/* These had no named type at all — they were inline `call<{ jobId: string }>` */
/* shapes, which is the cheapest place for a cast to hide.                    */
/* -------------------------------------------------------------------------- */

export const authorizeUrlSchema = z.object({ authorizeUrl: z.string() });
export const urlSchema = z.object({ url: z.string() });
export const jobIdSchema = z.object({ jobId: z.string() });
export const cancelledSchema = z.object({ status: z.literal('cancelled') });
export const enqueuedSchema = z.object({ enqueued: z.boolean() });
export const sugestoesCategoriaSchema = z.object({
  sugestoes: z.array(categoriaSugestaoSchema),
});
export const usuariosTesteListSchema = z.object({ usuarios: z.array(usuarioTesteSchema) });
export const chartDomainsSchema = z.object({ domains: z.array(chartDomainSchema) });
export const reclamacaoAcaoResultSchema = z.object({
  ok: z.boolean(),
  status: z.string().nullable(),
  acao: z.string(),
});
export const acaoPerguntaResultSchema = z.object({
  conversaId: z.string(),
  acao: z.enum(['excluir', 'bloquear']),
});
