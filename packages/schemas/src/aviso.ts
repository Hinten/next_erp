import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { microsSinceEpoch } from './shared/datetime';

// Mirrors `PERM.aviso` from @delfrance/auth (kept as local literals like the
// other schema files, so this package keeps no dependency edge to @delfrance/auth).
const PERM_AVISO_READ = 1n << 112n;
const PERM_AVISO_WRITE = 1n << 113n;
const PERM_AVISO_DELETE = 1n << 114n;

/* -------------------------------------------------------------------------- */
/*                                   Enums                                    */
/* -------------------------------------------------------------------------- */

export const SEVERIDADE_AVISO_LABELS = {
  critico: 'Crítico',
  atencao: 'Atenção',
  informativo: 'Informativo',
} as const;

/**
 * How loudly an aviso asks for the operator. NOT derivable from `tipo`: one
 * Shopee `get_app_push_config` read yields `Warning` (atenção) or `Suspended`
 * (crítico) from the same call site, and a violation is `atencao` until its
 * `fix_deadline_time` is close.
 *
 * `critico` is the only tier that escalates out of the app (see
 * `@delfrance/data/admin/avisos`), so widening it is not free: an escalation
 * everyone learns to ignore is worse than none in a three-person team.
 */
export const severidadeAvisoSchema = z
  .enum(['critico', 'atencao', 'informativo'])
  .meta({ labels: SEVERIDADE_AVISO_LABELS });
export type SeveridadeAviso = z.infer<typeof severidadeAvisoSchema>;

/** Named members of {@link severidadeAvisoSchema} — see `delfrance/prefer-schema-enum`. */
export const SEVERIDADE_AVISO = {
  critico: 'critico',
  atencao: 'atencao',
  informativo: 'informativo',
} as const satisfies Record<string, SeveridadeAviso>;

export const CANAL_AVISO_LABELS = {
  shopee: 'Shopee',
  mercadoLivre: 'Mercado Livre',
  mercadoPago: 'Mercado Pago',
  whatsapp: 'WhatsApp',
  melhorEnvio: 'Melhor Envio',
  nfe: 'NF-e',
  estoque: 'Estoque',
  sistema: 'Sistema',
} as const;

/**
 * Which subsystem raised the aviso. `sistema` covers what belongs to no channel
 * — infrastructure, sweeps, the retention job itself.
 */
export const canalAvisoSchema = z
  .enum([
    'shopee',
    'mercadoLivre',
    'mercadoPago',
    'whatsapp',
    'melhorEnvio',
    'nfe',
    'estoque',
    'sistema',
  ])
  .meta({ labels: CANAL_AVISO_LABELS });
export type CanalAviso = z.infer<typeof canalAvisoSchema>;

/** Named members of {@link canalAvisoSchema} — see `delfrance/prefer-schema-enum`. */
export const CANAL_AVISO = {
  shopee: 'shopee',
  mercadoLivre: 'mercadoLivre',
  mercadoPago: 'mercadoPago',
  whatsapp: 'whatsapp',
  melhorEnvio: 'melhorEnvio',
  nfe: 'nfe',
  estoque: 'estoque',
  sistema: 'sistema',
} as const satisfies Record<string, CanalAviso>;

export const TIPO_AVISO_LABELS = {
  shopeeAutorizacaoExpirando: 'Autorização Shopee expirando',
  shopeeDesautorizado: 'Conta Shopee desautorizada',
  shopeePushDegradado: 'Entrega de notificações Shopee degradada',
  shopeePushSuspenso: 'Assinatura de notificações Shopee suspensa',
  canalSemCredencial: 'Canal sem credencial válida',
  nfeUploadRejeitado: 'Envio de NF-e rejeitado pelo canal',
  pedidoPrecisaDecisao: 'Pedido aguardando decisão',
  anuncioComViolacao: 'Anúncio com violação',
  jobConcluidoComFalhas: 'Processamento concluído com falhas',
} as const;

/**
 * The kind of thing that happened. This is the **only** field the read-time
 * wording map keys on, so it is a closed enum rather than free text: adding a
 * `tipo` fails typecheck in `apps/web` until its message exists, which is what
 * keeps a stored aviso from rendering as a blank row.
 *
 * ⚠️ Every member must name its **machine resolver** before it ships. The
 * collection is `serverOwned`, so there is no operator "dismiss" button — an
 * aviso nothing resolves stands until retention sweeps it, and "a stale reason
 * on a healthy listing is indistinguishable from a real one".
 *
 * The list starts small on purpose: v1 wires no producer (the Shopee sweep needs
 * `apps/shopee/functions/`, created in that plan's step 3), so these are the
 * shapes the first producers will claim, not a speculative catalogue.
 */
export const tipoAvisoSchema = z
  .enum([
    'shopeeAutorizacaoExpirando',
    'shopeeDesautorizado',
    'shopeePushDegradado',
    'shopeePushSuspenso',
    'canalSemCredencial',
    'nfeUploadRejeitado',
    'pedidoPrecisaDecisao',
    'anuncioComViolacao',
    'jobConcluidoComFalhas',
  ])
  .meta({ labels: TIPO_AVISO_LABELS });
export type TipoAviso = z.infer<typeof tipoAvisoSchema>;

/** Named members of {@link tipoAvisoSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_AVISO = {
  shopeeAutorizacaoExpirando: 'shopeeAutorizacaoExpirando',
  shopeeDesautorizado: 'shopeeDesautorizado',
  shopeePushDegradado: 'shopeePushDegradado',
  shopeePushSuspenso: 'shopeePushSuspenso',
  canalSemCredencial: 'canalSemCredencial',
  nfeUploadRejeitado: 'nfeUploadRejeitado',
  pedidoPrecisaDecisao: 'pedidoPrecisaDecisao',
  anuncioComViolacao: 'anuncioComViolacao',
  jobConcluidoComFalhas: 'jobConcluidoComFalhas',
} as const satisfies Record<string, TipoAviso>;

/* -------------------------------------------------------------------------- */
/*                              Route builders                                */
/* -------------------------------------------------------------------------- */

/**
 * The in-app routes an aviso may point at, as builders rather than literals.
 *
 * A producer stores its route on the document (`urlInterna.rota`), which makes
 * the aviso self-contained — the bell renders a link with no lookup. The cost is
 * that the route FREEZES at write time: resolved avisos live 90 days, unresolved
 * ones stand indefinitely, and the writer is a Cloud Function with no dependency
 * edge to `apps/web`, so a route rename there is typechecked against nothing.
 *
 * This is the mitigation. Every producer calls a builder here instead of writing
 * a literal, so each shape has exactly one definition — and
 * `apps/web/lib/avisos/rotas.test.ts` walks `app/(app)/**` asserting every
 * `padrao` below resolves to a real route directory. Without that test this is
 * only a convention, and conventions drift *toward plausible* (#1369).
 *
 * `padrao` is the Next.js route pattern; `build` produces the concrete path.
 * They are pinned against each other in `aviso.test.ts` so one cannot be edited
 * without the other.
 */
export const ROTAS_AVISO = {
  canalShopee: {
    padrao: '/canais/shopee/[id]',
    build: (integracaoId: string) => `/canais/shopee/${integracaoId}`,
  },
  canalMercadoLivre: {
    padrao: '/canais/mercado-livre/[id]',
    build: (integracaoId: string) => `/canais/mercado-livre/${integracaoId}`,
  },
  canalWhatsapp: {
    padrao: '/canais/whatsapp/[id]',
    build: (integracaoId: string) => `/canais/whatsapp/${integracaoId}`,
  },
  // ⚠️ `/pedidos/[id]` is NOT navigable — it is a bare directory holding
  // `editar/` and `nfe/`, with no page of its own. The whole app links to
  // `/pedidos/{id}/editar` (see `pedidos/_components/direcao.ts`). Caught by
  // `apps/web/lib/avisos/rotas.test.ts`, which is what it is for.
  pedido: {
    padrao: '/pedidos/[id]/editar',
    build: (pedidoId: string) => `/pedidos/${pedidoId}/editar`,
  },
  produto: {
    padrao: '/produtos/[id]',
    build: (produtoId: string) => `/produtos/${produtoId}`,
  },
  inicio: {
    padrao: '/inicio',
    build: () => '/inicio',
  },
} as const;

export type RotaAvisoKey = keyof typeof ROTAS_AVISO;

/* -------------------------------------------------------------------------- */
/*                                  Schema                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where an aviso sends the operator inside the ERP. `campo` names the field to
 * focus or highlight on arrival — a background listing write rejected by the
 * channel has no open form to surface into, so the route alone is not enough to
 * act on.
 */
export const urlInternaAvisoSchema = z
  .object({
    rota: z.string().min(1).describe('Rota'),
    campo: z.string().nullable().default(null).describe('Campo'),
  })
  .passthrough();
export type UrlInternaAviso = z.infer<typeof urlInternaAvisoSchema>;

/**
 * Aviso — `avisos`. The in-app operator notification inbox: one row per
 * operator-actionable business event, written by the Admin SDK, read by the bell
 * in the app shell.
 *
 * ## What belongs here, and what emphatically does not
 *
 * `avisos` carries **operator-actionable business events** — an authorization
 * expiring, an order awaiting a decision, an NF-e upload rejected for a fixable
 * configuration reason — where the audience is the person who can fix it and the
 * fix is in this app.
 *
 * It carries **no webhook plumbing telemetry**. That distinction is not a
 * preference: #809 proposed an ERP screen over `notificacoesMercadoLivre` and was
 * closed `wontfix` because "it is a failures-only processing log. Whoever needs
 * to investigate a parked notification is a dev, and devs have Cloud Logging."
 * That reasoning still holds, and nothing here should erode it. If a parked
 * notification means a business event was lost, raise an aviso about the
 * **business event**, never about the parked document.
 *
 * ## Identity and races
 *
 * The document id IS the dedup key ({@link chaveDeAviso}) — deliberately not
 * stored as a field, so an id and a field can never disagree. That makes the
 * write idempotent by construction (root `CLAUDE.md` rule 7, tier 0): the same
 * logical event reaching us twice from two producers (the weekly Shopee expiry
 * sweep and Shopee's own `push 12`) merges onto one row instead of duplicating.
 * Repeats bump {@link ocorrencias} with `FieldValue.increment`, which is tier 0
 * again — nothing to compare, nothing to lose.
 *
 * `relogioEvento` is the tier-2 escape hatch for genuinely out-of-order provider
 * events: compare stored against incoming inside a transaction, drop when not
 * fresher, and advance it on the write that WINS.
 */
export const avisoSchema = z
  .object({
    tipo: tipoAvisoSchema.describe('Tipo'),
    severidade: severidadeAvisoSchema.describe('Severidade'),
    canal: canalAvisoSchema.nullable().default(null).describe('Canal'),
    /**
     * Values the read-time wording interpolates (`{ loja: 'Delfrance', dias: 29 }`)
     * — **structured params, never a rendered sentence**. The pt-BR text lives in
     * `apps/web/lib/avisos/mensagens.ts` keyed on `tipo`, so fixing a wording
     * applies retroactively to every row already written. Same reason the Shopee
     * plan stores `precoMotivos` as codes.
     */
    params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    /**
     * The provider's own code for WHY, where one exists — Shopee's
     * `authorize_type`, an NF-e upload error number, a `violation_type`. Kept
     * separate from `tipo` because the operator ACTION differs per reason while
     * the event class does not: five de-authorization reasons, five remedies.
     */
    motivo: z.string().nullable().default(null).describe('Motivo'),
    /**
     * Routing hint. `null` = everyone who can act, which is the normal case for
     * machine sweeps; a uid for something genuinely personal ("your bulk price
     * job finished with 40 failures").
     *
     * ⚠️ **Not a security boundary.** The generated ruleset can only express
     * `isSuperUser() || p('d_aviso', 1)` — there is no `resource.data` hook — so
     * every operator can read every row regardless of what this says. The bell
     * filters on it client-side, over documents already in the local cache.
     */
    destinatarioUid: z.string().nullable().default(null).describe('Destinatário'),
    urlInterna: urlInternaAvisoSchema.nullable().default(null).describe('Link interno'),
    /**
     * A provider-supplied external link, for what is fixable only on their site.
     *
     * ⚠️ Untrusted input — it arrives from a provider API. Never hand it to an
     * `href` without {@link urlExternaSegura}.
     */
    urlExterna: z.string().nullable().default(null).describe('Link externo'),
    /**
     * A deadline the PROVIDER supplied — a violation's `fix_deadline_time`, a
     * return's `due_date`, a `ship_by_date`. Copied, never computed: we do not
     * know their business-day rules, and a deadline we invented is worse than
     * none.
     */
    prazo: microsSinceEpoch('Prazo').nullable().default(null),
    criadoEm: microsSinceEpoch('Criado em'),
    atualizadoEm: microsSinceEpoch('Atualizado em'),
    /** Times this same `chave` has been raised. Bumped with `FieldValue.increment`. */
    ocorrencias: z.number().int().positive().default(1).describe('Ocorrências'),
    /**
     * The provider's event clock for the delivery that last won, in whatever unit
     * that provider uses. ⚠️ Compare only against another value of the SAME
     * provider: `ultimaModificacao` is µs on pedido/produto but ms on the ML
     * links, and a cross-unit comparison is a guard that never fires.
     */
    relogioEvento: z.number().int().nullable().default(null),
    /**
     * When a machine resolved it — a **timestamp, not a boolean**, following
     * `disputaAbertaEm`: null/not-null answers the guard, and the value
     * additionally says how long the aviso stood, which is the only way to tell
     * a fast fix from one nobody noticed for a week.
     */
    resolvidoEm: microsSinceEpoch('Resolvido em').nullable().default(null),
    resolucaoMotivo: z.string().nullable().default(null).describe('Motivo da resolução'),
  })
  .passthrough();

export type Aviso = z.infer<typeof avisoSchema>;

export const avisoMeta: CollectionMetadata = {
  collectionPath: 'avisos',
  permissions: {
    read: PERM_AVISO_READ,
    write: PERM_AVISO_WRITE,
    delete: PERM_AVISO_DELETE,
  },
  // Written exclusively through the Admin SDK (sweeps, task handlers, triggers).
  // The generator emits `allow create, update, delete: if false` with no `su`
  // bypass, so the write/delete bits above gate nothing — they exist because
  // `resolvePermissions` requires one PERM bit per action.
  //
  // ⚠️ This also forbids an in-app "dismiss" button, deliberately: it forces
  // every `tipo` to name its machine resolver instead of leaning on the operator
  // to tidy up. Adding one later means `serverOwnedFields` (mutually exclusive
  // with `serverOwned`) or an authed route on a channel backend — the latter
  // touches no ruleset and is the cleaner upgrade.
  serverOwned: true,
  // The bell's query: everything unresolved, newest first, one page. Declaring it
  // is what makes the composite index MANDATORY — `delfrance/default-query-needs-index`
  // plus the `defaultQuery.indexes` backstop. On this Enterprise edition an
  // unindexed listener raises no error and offers no index link; it silently
  // full-scans and bills data scanned, and `limit` shrinks the RESULT, not the
  // scan. A hand-rolled `onSnapshot` in a component would be invisible to both
  // gates, which is exactly why the query lives here.
  defaultQuery: {
    where: [{ field: 'resolvidoEm', value: null }],
    orderBy: [{ field: 'criadoEm', direction: 'desc' }],
    limit: 50,
    columns: ['severidade', 'tipo', 'canal', 'criadoEm'],
  },
};

export const aviso = { schema: avisoSchema, meta: avisoMeta };

/* -------------------------------------------------------------------------- */
/*                         Per-user read state (bare)                         */
/* -------------------------------------------------------------------------- */

/**
 * `avisosLeitura/{uid}` — one document per operator, holding what they have read.
 *
 * ⚠️ **Deliberately NOT a `DomainSchema` and NOT in `ALL_DOMAINS`.** A registered
 * meta would emit `allow write: if isSuperUser() || p('d_aviso', 2)`, letting any
 * operator overwrite anyone else's read state; and adding a stricter match block
 * on the same path would not help, because Firestore ORs every matching `allow`
 * — a second block WIDENS access, it cannot narrow it. So the only rule for this
 * path is the hand-written `EXTRA_MATCH_BLOCK` in `@delfrance/rules-gen`, scoped
 * to `request.auth.uid == uid`.
 *
 * That is the `grupoEconomico` shape exactly (schema outside `ALL_DOMAINS`, one
 * extra block, a `defineCollection` handle in `apps/web`, and an allow-list entry
 * in `collectionCoverage.test.ts`), with one difference worth knowing: that block
 * is read-only, this one grants the client a WRITE.
 *
 * Read state is per `(operator, aviso)` because `avisos` is a shared inbox — a
 * `lida` boolean on the aviso itself would mean "somebody read it", and the first
 * operator to open the panel would silence the bell for everyone else.
 */
export const AVISOS_LEITURA_COLLECTION_PATH = 'avisosLeitura';

export const avisosLeituraSchema = z
  .object({
    /** Everything created at or before this instant counts as read. */
    ultimaVisualizacaoUs: microsSinceEpoch('Última visualização').default(0),
    /**
     * Aviso ids read individually SINCE `ultimaVisualizacaoUs`. Bounded by
     * construction: {@link marcarTodosComoLidos} advances the watermark and
     * clears this array in the same write, so it only ever holds avisos raised
     * since the last "marcar todas como lidas".
     */
    lidos: z.array(z.string()).default([]),
  })
  .passthrough();

export type AvisosLeitura = z.infer<typeof avisosLeituraSchema>;

/* -------------------------------------------------------------------------- */
/*                                Pure folds                                  */
/* -------------------------------------------------------------------------- */

/**
 * Firestore document-id constraints we must not violate, since {@link chaveDeAviso}
 * output IS the id: no `/` (it would fork a subcollection path), not `.` or `..`,
 * no leading `__`, and at most 1500 bytes.
 */
const SEPARADOR_CHAVE = ':';
const MAX_BYTES_CHAVE = 1500;

/**
 * Normalize one segment of a dedup key. `/` is the dangerous one — an outerRef
 * like `documents/usuarios/abc` would otherwise turn a document id into a nested
 * path — but any control or reserved character is folded for the same reason.
 *
 * ⚠️ **{@link SEPARADOR_CHAVE} itself is in the set, and that is the whole
 * point.** Leaving it intact would let a colon inside a segment shift the
 * segment boundaries: `conta: 'loja:123'` and `(conta: 'loja', entidade: '123')`
 * would join to the same string, so two unrelated operator events would collapse
 * onto one document — one aviso lost, silently, with `ocorrencias` reading as a
 * plausible repeat. Colons in segments are not hypothetical: a violation key is
 * `item-9:BANNED` and an ISO instant in `janela` carries them too.
 *
 * ⚠️ This is an equivalence fold: two inputs differing only in folded characters
 * produce the SAME aviso — `a/b`, `a:b` and `a_b` are one key. That is the
 * accepted cost, and `aviso.test.ts` pins it both ways: pairs that must collapse
 * AND near-misses that must stay distinct.
 */
function segmentoChave(valor: string | number): string {
  return String(valor)
    .replace(/[/\\.#[\]:]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
}

export interface ChaveAvisoInput {
  tipo: TipoAviso;
  /** The account/integration the event belongs to, when it belongs to one. */
  conta?: string | null;
  /** The specific entity — an `order_sn`, an `item_id`, a `return_sn`. */
  entidade?: string | null;
  /**
   * What makes two otherwise-identical events DIFFERENT occurrences rather than
   * a repeat of one. For a recurring warning this is the window it refers to
   * ("expiry on 2026-11-02"), NOT the delivery: the weekly sweep and Shopee's
   * `push 12` describe the same expiry and must collapse onto one row, while the
   * same conta in two different expiry windows must not.
   */
  janela?: string | null;
}

/**
 * The dedup identity of an aviso, and its Firestore document id.
 *
 * Keying on `(tipo, conta, entidade, janela)` rather than on the delivery is the
 * whole point: provider notifications are at-least-once, arrive out of order, are
 * re-driven hours later by sweeps, and are frequently duplicated by a pull
 * backstop covering the same event. Anything keyed on a delivery id produces one
 * row per attempt.
 */
export function chaveDeAviso(input: ChaveAvisoInput): string {
  const chave = [input.tipo, input.conta, input.entidade, input.janela]
    .map((parte) => (parte == null || parte === '' ? '' : segmentoChave(parte)))
    .join(SEPARADOR_CHAVE)
    .replace(/:+$/, '');

  // `TextEncoder`, not `Buffer.byteLength`: this package is reached from
  // `apps/web`, so everything in it must be browser-safe.
  if (new TextEncoder().encode(chave).length > MAX_BYTES_CHAVE) {
    throw new RangeError(
      `chaveDeAviso: chave excede ${String(MAX_BYTES_CHAVE)} bytes e não pode ser um id de documento: ${chave.slice(0, 80)}…`,
    );
  }
  return chave;
}

/**
 * Is this aviso unread FOR THIS OPERATOR, and addressed to them at all?
 *
 * Pure and total so the bell, the `/inicio` list and any future consumer cannot
 * disagree — the failure mode #1369 documents, where two copies of one rule drift
 * toward plausible and both look right in review.
 */
export function avisoNaoLido(
  aviso: Pick<Aviso, 'criadoEm' | 'destinatarioUid' | 'resolvidoEm'>,
  avisoId: string,
  leitura: AvisosLeitura | null,
  uid: string,
): boolean {
  if (aviso.resolvidoEm != null) return false;
  if (aviso.destinatarioUid != null && aviso.destinatarioUid !== uid) return false;
  if (leitura == null) return true;
  if (leitura.lidos.includes(avisoId)) return false;
  return aviso.criadoEm > leitura.ultimaVisualizacaoUs;
}

/**
 * The next read state after marking every currently-visible aviso read.
 *
 * ⚠️ Clearing `lidos` is not an optimisation, it is what BOUNDS the array: the
 * watermark now covers everything those ids referred to. Advancing one without
 * clearing the other grows the array forever; clearing without advancing marks
 * nothing read.
 *
 * ⚠️ **Pass the newest `criadoEm` the operator can actually SEE — never a clock
 * reading.** The rows are stamped by a Cloud Function and the panel runs in a
 * browser, so a "now" taken here is a DIFFERENT clock from the one the watermark
 * is compared against. A client running a few minutes fast would mark avisos
 * read that have not been raised yet: they arrive already counted as read and
 * the bell never lights for them. The newest visible `criadoEm` is also the
 * truthful definition of "I have seen everything up to here".
 */
export function marcarTodosComoLidos(ateCriadoEmUs: number): AvisosLeitura {
  return { ultimaVisualizacaoUs: ateCriadoEmUs, lidos: [] };
}

/**
 * A stored internal route is only safe to render as a link if it is genuinely
 * internal. Returns the route when it is, `null` otherwise.
 *
 * `avisos` is `serverOwned`, so only our own producers write `urlInterna` — but
 * `rota` is built from provider-supplied ids, nothing forces a producer through
 * {@link ROTAS_AVISO}, and a stored value outlives the code that wrote it. This
 * makes "internal" true by construction rather than by convention, and it is the
 * convention that drifts.
 *
 * ⚠️ `//evil.com` starts with `/` and is PROTOCOL-RELATIVE — a browser navigates
 * off-site. A bare `startsWith('/')` is not the check.
 */
export function rotaInternaSegura(rota: string | null | undefined): string | null {
  if (rota == null || rota === '') return null;
  if (!rota.startsWith('/')) return null;
  if (rota.startsWith('//')) return null;
  return rota;
}

/**
 * A provider-supplied URL is only safe to render as a link if it is `https:` and
 * points somewhere we expect. Returns the URL when it passes, `null` otherwise —
 * never throws, because a malformed link must degrade to "no button", not to a
 * broken panel.
 */
export function urlExternaSegura(
  url: string | null | undefined,
  hostsPermitidos: ReadonlyArray<string>,
): string | null {
  if (url == null || url === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }

  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const permitido = hostsPermitidos.some(
    (allow) => host === allow.toLowerCase() || host.endsWith(`.${allow.toLowerCase()}`),
  );
  return permitido ? parsed.toString() : null;
}
