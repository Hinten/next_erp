/**
 * Frete (shipping) schemas — ported from the legacy Flutter ERP at
 * `.old/packages/integracao_frete/lib/src/integracao_frete_base.dart`
 * and `.old/packages/pedido/lib/src/models.dart` (the
 * `FreteDoPedido` class and its nested types Transportadora,
 * Veiculo, Reboque, Volume).
 *
 * Convention recap (matches `pedido.ts`):
 *   - Datetime fields are **microseconds since epoch** (`microsSinceEpoch()`),
 *     the project standard — NOT the legacy Flutter `int` milliseconds. The
 *     builder reads tolerantly (ms / µs / ISO / `Date` → µs); the legacy ms↔µs
 *     mapping is documented in
 *     `tools/migrations/pedido-pagamento-micros.README.md`.
 *   - Enums serialize by their `.value` (a string), not the enum
 *     name itself. For `modalidadeFrete` the values are the
 *     single-digit codes the NFe XSD uses ('0'..'9'); for
 *     `INTEGRACOES_FRETE` they're the integration slugs (amazon →
 *     'amz', etc.).
 *   - Nested entity classes (Transportadora, Veiculo, Reboque,
 *     Volume) use `.passthrough()` for the fields the Flutter app
 *     writes that we haven't enumerated yet.
 */
import { z } from 'zod';
import { microsSinceEpoch } from './datetime';
import { ufSchema } from '../endereco';
import { outerRefSchema } from './outerRef';

/* -------------------------------------------------------------------------- */
/*                            ESTADOS_FRETE enum                              */
/* -------------------------------------------------------------------------- */

/**
 * ESTADOS_FRETE — shipping lifecycle states. 27 values, mirroring the
 * Dart `ESTADOS_FRETE` enum (lines 105-133 of `integracao_frete_base.dart`).
 * Stored on disk as the enum's `.value` (same as the Dart name).
 */
export const ESTADO_FRETE_LABELS = {
  fulfillment: 'Fulfillment',
  iniciado: 'Iniciado',
  aguardandoAutorizacao: 'Aguardando autorização',
  aguardandoNFe: 'Aguardando NFe',
  aguardandoValidacaoTransporadora: 'Aguardando validação da transportadora',
  despachoAutorizado: 'Despacho autorizado',
  aguardandoAgendamento: 'Aguardando agendamento',
  despachoNegado: 'Despacho negado',
  emSeparacao: 'Em separação',
  empacotado: 'Empacotado',
  aguardandoPostagem: 'Aguardando postagem',
  checkFinalizado: 'Check finalizado',
  postado: 'Postado',
  recebidoPelaTransportadora: 'Recebido pela transportadora',
  aCaminho: 'A caminho do cliente',
  tentandoRealizarEntrega: 'Tentando realizar entrega',
  entregue: 'Entregue',
  falhaNaEntrega: 'Falha na entrega',
  suspenso: 'Suspenso',
  enderecoNaoEncontrado: 'Endereço não encontrado',
  aCaminhoDoRemetente: 'Ao remetente',
  devolvido: 'Devolvido ao remetente',
  objetoExtraviado: 'Objeto extraviado',
  cancelado: 'Cancelado',
  desconhecido: 'Desconhecido',
  error: 'Erro',
  aguardandoRetirada: 'Aguardando retirada',
} as const;

export const estadoFreteSchema = z
  .enum([
    'fulfillment',
    'iniciado',
    'aguardandoAutorizacao',
    'aguardandoNFe',
    'aguardandoValidacaoTransporadora',
    'despachoAutorizado',
    'aguardandoAgendamento',
    'despachoNegado',
    'emSeparacao',
    'empacotado',
    'aguardandoPostagem',
    'checkFinalizado',
    'postado',
    'recebidoPelaTransportadora',
    'aCaminho',
    'tentandoRealizarEntrega',
    'entregue',
    'falhaNaEntrega',
    'suspenso',
    'enderecoNaoEncontrado',
    'aCaminhoDoRemetente',
    'devolvido',
    'objetoExtraviado',
    'cancelado',
    'desconhecido',
    'error',
    'aguardandoRetirada',
  ])
  .meta({ labels: ESTADO_FRETE_LABELS });
export type EstadoFrete = z.infer<typeof estadoFreteSchema>;

/**
 * Named members of {@link estadoFreteSchema} — the ONLY way to write an
 * `EstadoFrete` in code. Same rationale as `ESTADO_PEDIDO`; enforced by the
 * `delfrance/prefer-schema-enum` lint rule.
 */
export const ESTADO_FRETE = {
  fulfillment: 'fulfillment',
  iniciado: 'iniciado',
  aguardandoAutorizacao: 'aguardandoAutorizacao',
  aguardandoNFe: 'aguardandoNFe',
  aguardandoValidacaoTransporadora: 'aguardandoValidacaoTransporadora',
  despachoAutorizado: 'despachoAutorizado',
  aguardandoAgendamento: 'aguardandoAgendamento',
  despachoNegado: 'despachoNegado',
  emSeparacao: 'emSeparacao',
  empacotado: 'empacotado',
  aguardandoPostagem: 'aguardandoPostagem',
  checkFinalizado: 'checkFinalizado',
  postado: 'postado',
  recebidoPelaTransportadora: 'recebidoPelaTransportadora',
  aCaminho: 'aCaminho',
  tentandoRealizarEntrega: 'tentandoRealizarEntrega',
  entregue: 'entregue',
  falhaNaEntrega: 'falhaNaEntrega',
  suspenso: 'suspenso',
  enderecoNaoEncontrado: 'enderecoNaoEncontrado',
  aCaminhoDoRemetente: 'aCaminhoDoRemetente',
  devolvido: 'devolvido',
  objetoExtraviado: 'objetoExtraviado',
  cancelado: 'cancelado',
  desconhecido: 'desconhecido',
  error: 'error',
  aguardandoRetirada: 'aguardandoRetirada',
} as const satisfies Record<string, EstadoFrete>;

/**
 * Estados in which the frete has NOT yet been posted to the carrier — ported
 * from the Dart `naoPostado` list (`integracao_frete_base.dart`).
 */
export const ESTADOS_FRETE_NAO_POSTADO: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.iniciado,
  ESTADO_FRETE.aguardandoAutorizacao,
  ESTADO_FRETE.aguardandoNFe,
  ESTADO_FRETE.aguardandoValidacaoTransporadora,
  ESTADO_FRETE.despachoAutorizado,
  ESTADO_FRETE.despachoNegado,
  ESTADO_FRETE.emSeparacao,
  ESTADO_FRETE.empacotado,
  ESTADO_FRETE.desconhecido,
  ESTADO_FRETE.aguardandoAgendamento,
]);

/**
 * True when the frete has left the draft / pre-emission states — i.e. a label
 * has likely been emitted (this INCLUDES `aguardandoPostagem`: bought but not
 * yet physically posted). Re-emitting/reprinting from here should be
 * risk-confirmed, since a duplicate paid label causes operational problems.
 * Mirrors the Dart guard in `emitirOuImprimirFrete`:
 * `estado != checkFinalizado && jaPostado.contains(estado)`, where `jaPostado`
 * is every estado NOT in `naoPostado`. The name follows the Dart port —
 * "jaPostado" here means "past the draft states", not strictly dispatched.
 * ⚠️ NOT a "has the frete progressed past authorization" test — see
 * {@link ESTADOS_FRETE_PRE_AUTORIZACAO} for that question (#702).
 */
export function isFreteJaPostado(estado: EstadoFrete): boolean {
  return estado !== ESTADO_FRETE.checkFinalizado && !ESTADOS_FRETE_NAO_POSTADO.has(estado);
}

/**
 * Estados from which a payment-driven `pago` transition may authorize freight
 * dispatch — strictly those BEFORE `despachoAutorizado` in the lifecycle order
 * of the enum above.
 *
 * Deliberately NOT `!isFreteJaPostado(...)`, which is what the pedido reconcile
 * used until #702: that predicate answers the label-reprint question and returns
 * false for `emSeparacao` / `empacotado` / `aguardandoAgendamento` /
 * `checkFinalizado`, so authorizing dispatch used to REGRESS warehouse progress —
 * and for `empacotado` and `checkFinalizado`, which are the two of those four in
 * {@link ESTADOS_FRETE_REMOVE_ESTOQUE}, the pedido's stock effect along with it.
 *
 * Excluded on purpose: `despachoNegado` (a denial is a decision — a human clears
 * it, not a payment), `desconhecido` (noise, not a shipping event — see
 * {@link ESTADOS_FRETE_IGNORAR_REMOCAO}), `fulfillment` (the marketplace
 * warehouses the goods) and `despachoAutorizado` itself (already authorized —
 * skipping it avoids a redundant write).
 *
 * INVARIANT: disjoint from {@link ESTADOS_FRETE_REMOVE_ESTOQUE} (asserted in the
 * unit tests), so authorizing dispatch can never un-remove stock through
 * `efeitoEstoquePedido`.
 */
export const ESTADOS_FRETE_PRE_AUTORIZACAO: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.iniciado,
  ESTADO_FRETE.aguardandoAutorizacao,
  ESTADO_FRETE.aguardandoNFe,
  ESTADO_FRETE.aguardandoValidacaoTransporadora,
]);

/**
 * True when a `pago` transition may set `freteInicial.estado` to
 * `despachoAutorizado`. Takes a plain `EstadoFrete` like {@link isFreteJaPostado},
 * so an unrecognized value from raw Firestore data yields `false` — the safe
 * direction (leave the frete alone).
 */
export function podeAutorizarDespacho(estado: EstadoFrete): boolean {
  return ESTADOS_FRETE_PRE_AUTORIZACAO.has(estado);
}

/**
 * Estados from which the physical stock of a saída pedido leaves the depósito —
 * ported 1:1 from the Dart `ESTADOS_FRETE.removeEstoque` list
 * (`integracao_frete_base.dart:279`): everything from "packed" onward, including
 * the failure/return tail (the goods are out of the warehouse either way).
 * Consumed by the pedido→estoque sync (`efeitoEstoquePedido`).
 */
export const ESTADOS_FRETE_REMOVE_ESTOQUE: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.empacotado,
  ESTADO_FRETE.aguardandoPostagem,
  ESTADO_FRETE.checkFinalizado,
  ESTADO_FRETE.postado,
  ESTADO_FRETE.recebidoPelaTransportadora,
  ESTADO_FRETE.aCaminho,
  ESTADO_FRETE.tentandoRealizarEntrega,
  ESTADO_FRETE.entregue,
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.suspenso,
  ESTADO_FRETE.enderecoNaoEncontrado,
  ESTADO_FRETE.aCaminhoDoRemetente,
  ESTADO_FRETE.devolvido,
  ESTADO_FRETE.objetoExtraviado,
  ESTADO_FRETE.aguardandoRetirada,
]);

/**
 * Estados whose frete signal must NOT drive stock movement — the Dart
 * `ignorarRemocaoDeEstoque` pair (`integracao_frete_base.dart:201`): an unknown
 * or errored freight status is noise, not a shipping event.
 */
export const ESTADOS_FRETE_IGNORAR_REMOCAO: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.desconhecido,
  ESTADO_FRETE.error,
]);

/* -------------------------------------------------------------------------- */
/*                         modalidadeFrete enum (modFrete)                    */
/* -------------------------------------------------------------------------- */

/**
 * `modalidadeFrete` — maps 1:1 to the SEFAZ NFe XSD `modFrete` codes.
 * Values are the digit strings (`'0'`..`'9'`) Flutter writes, not the
 * enum names. See `.old/packages/canal_de_vendas/lib/src/models.dart:17`.
 */
export const MODALIDADE_FRETE_LABELS = {
  '0': 'Contratação por conta do Emitente (CIF)',
  '1': 'Contratação por conta do Destinatário (FOB)',
  '2': 'Contratação por conta de Terceiros',
  '3': 'Transporte próprio por conta do Remetente',
  '4': 'Transporte próprio por conta do Destinatário',
  '9': 'Sem ocorrência de transporte',
} as const;

export const modalidadeFreteSchema = z
  .enum(['0', '1', '2', '3', '4', '9'])
  .meta({ labels: MODALIDADE_FRETE_LABELS });
export type ModalidadeFrete = z.infer<typeof modalidadeFreteSchema>;

/**
 * Named members of {@link modalidadeFreteSchema}, using the standard freight
 * shorthand from {@link MODALIDADE_FRETE_LABELS} — `MODALIDADE_FRETE.cif` reads
 * where `'0'` does not.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const MODALIDADE_FRETE = {
  cif: '0',
  fob: '1',
  terceiros: '2',
  proprioRemetente: '3',
  proprioDestinatario: '4',
  semTransporte: '9',
} as const satisfies Record<string, ModalidadeFrete>;

/* -------------------------------------------------------------------------- */
/*                         INTEGRACOES_FRETE enum                             */
/* -------------------------------------------------------------------------- */

/**
 * Shipping integration slugs. Note `amazon → 'amz'` — the on-disk value
 * differs from the enum name. Mirrors
 * `.old/packages/integracao_frete/lib/src/integracao_frete_base.dart:15`.
 */
export const INTEGRACAO_FRETE_LABELS = {
  mercadoLivre: 'Mercado Livre',
  lojaIntegrada: 'Loja Integrada',
  melhorEnvios: 'Melhor Envios',
  amz: 'Amazon',
  magalu: 'Magalu',
  retiradaNaLoja: 'Retirar na Loja',
  shopee: 'Shopee',
  motoboy: 'Motoboy',
  fob: 'Entrega por conta do destinatário',
  outros: 'Outros',
} as const;

export const integracoesFreteSchema = z
  .enum([
    'mercadoLivre',
    'lojaIntegrada',
    'melhorEnvios',
    'amz',
    'magalu',
    'retiradaNaLoja',
    'shopee',
    'motoboy',
    'fob',
    'outros',
  ])
  .meta({ labels: INTEGRACAO_FRETE_LABELS });
export type IntegracaoFrete = z.infer<typeof integracoesFreteSchema>;

/**
 * Named members of {@link integracoesFreteSchema}. Every member name matches its
 * slug except `amazon`, whose on-disk value is `'amz'` — exactly the mismatch
 * this convention exists to hide.
 */
export const INTEGRACAO_FRETE = {
  mercadoLivre: 'mercadoLivre',
  lojaIntegrada: 'lojaIntegrada',
  melhorEnvios: 'melhorEnvios',
  amazon: 'amz',
  magalu: 'magalu',
  retiradaNaLoja: 'retiradaNaLoja',
  shopee: 'shopee',
  motoboy: 'motoboy',
  fob: 'fob',
  outros: 'outros',
} as const satisfies Record<string, IntegracaoFrete>;

/* -------------------------------------------------------------------------- */
/*                    FREIGHT_TIPO_CAPS — provider capabilities                */
/* -------------------------------------------------------------------------- */

/**
 * How an etiqueta (label) is produced for a freight tipo:
 *   - `'emit'`    — the app buys + generates the label itself (Melhor Envio):
 *                   quote → cart → checkout → generate → print → webhook status.
 *   - `'fetch'`   — the marketplace already generated it; the app only fetches +
 *                   prints, and status arrives via the marketplace order-sync
 *                   (NOT a freight webhook). Phase 5/6 — not implemented yet.
 *   - `'generic'` — no carrier API; render a generic PDF on demand (a deferred
 *                   follow-up for motoboy / outros).
 *   - `'none'`    — nothing to print (retirada na loja / fob).
 */
export type FreightLabelMode = 'emit' | 'fetch' | 'generic' | 'none';

/**
 * Per-tipo freight capabilities — the single source of truth that replaces the
 * scattered `tipo === 'melhorEnvios'` / `MARKETPLACE_TIPOS` checks the etiqueta
 * dispatch (`etiquetaRowState`) and the Frete tab used to hard-code.
 *
 * ⚠️ The **`can*` flags are the behavioral truth**. Every marketplace-owned
 * tipo (fetch category) stays ALL FALSE until its fetch flow + client route
 * exist — `mercadoLivre`'s `canFetchLabel` is the one live exception — so
 * `etiquetaRowState` yields `'unsupported'` for the rest, byte-identical to
 * the previous `tipo !== 'melhorEnvios'` reject. The generic-label tipos
 * (`motoboy`/`outros`) are the other exception: `canPrint` is true for them
 * too, but `etiquetaRowState` never gates it on `printLabelId` (there is no
 * buy step) — it dispatches to the on-demand generic PDF instead of the
 * Melhor Envio reprint. `labelMode` is **descriptive** (documents intended
 * Phase-5/6 marketplace behavior and today's generic/none split); it does NOT
 * drive the dispatch by itself. Do not flip a marketplace `canPrint` to true
 * until the fetch flow + its client route exist, or a marketplace pedido
 * carrying a `printLabelId` would wrongly route "Imprimir" to the Melhor
 * Envio backend. `marketplaceOwned` is behavioral — it reproduces the old
 * `MARKETPLACE_TIPOS` read-only lock on the Frete tab.
 */
export interface FreightTipoCapabilities {
  /** The importing marketplace owns the whole freight block → Frete tab read-only. */
  readonly marketplaceOwned: boolean;
  /** The app can run a live freight quote (calculate) for this tipo. */
  readonly canQuote: boolean;
  /** The app can buy + generate a label for this tipo. */
  readonly canBuy: boolean;
  /** The app can print an existing label via the freight HTTP client. */
  readonly canPrint: boolean;
  /**
   * The app fetches + prints a marketplace-generated label via that
   * marketplace's own client — NOT the freight HTTP client.
   */
  readonly canFetchLabel: boolean;
  /** The app receives status updates (webhook or order-sync) for this tipo. */
  readonly canTrack: boolean;
  /** Label semantics — DESCRIPTIVE (skill / future), does not drive dispatch. */
  readonly labelMode: FreightLabelMode;
  /**
   * Backend channel segment for the freight HTTP client (`/api/freight/<channel>/*`),
   * or `null` when the tipo has no server route (marketplace/manual/generic).
   * Only `'melhor-envio'` is non-null today; the per-channel client router that
   * consumes this lands with provider #2.
   */
  readonly channel: string | null;
}

/**
 * Capability table keyed by every `IntegracaoFrete` tipo. Because it's a
 * `Record<IntegracaoFrete, …>`, adding a tipo to `integracoesFreteSchema`
 * without a caps row is a **compile error** — the structural guarantee the
 * "add a freight provider" skill checklist relies on.
 */
export const FREIGHT_TIPO_CAPS: Record<IntegracaoFrete, FreightTipoCapabilities> = {
  // Emit — the app buys + generates the label (the only live provider).
  melhorEnvios: {
    marketplaceOwned: false,
    canQuote: true,
    canBuy: true,
    canPrint: true,
    canFetchLabel: false,
    canTrack: true,
    labelMode: 'emit',
    channel: 'melhor-envio',
  },
  // Marketplace-managed (fetch-only, read-only tab). Mercado Livre is the one
  // live fetch provider (`canFetchLabel`); the rest are Phase-5/6 stubs, so
  // every `can*` stays false (→ `'unsupported'` in the row action).
  mercadoLivre: {
    marketplaceOwned: true,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: true,
    canTrack: false,
    labelMode: 'fetch',
    channel: null,
  },
  lojaIntegrada: {
    marketplaceOwned: true,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'fetch',
    channel: null,
  },
  amz: {
    marketplaceOwned: true,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'fetch',
    channel: null,
  },
  magalu: {
    marketplaceOwned: true,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'fetch',
    channel: null,
  },
  shopee: {
    marketplaceOwned: true,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'fetch',
    channel: null,
  },
  // Manual / generic — no carrier API, but a generic PDF label is always
  // available on demand (no buy step, so no printLabelId gate — see
  // etiquetaRowState).
  motoboy: {
    marketplaceOwned: false,
    canQuote: false,
    canBuy: false,
    canPrint: true,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'generic',
    channel: null,
  },
  retiradaNaLoja: {
    marketplaceOwned: false,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'none',
    channel: null,
  },
  fob: {
    marketplaceOwned: false,
    canQuote: false,
    canBuy: false,
    canPrint: false,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'none',
    channel: null,
  },
  outros: {
    marketplaceOwned: false,
    canQuote: false,
    canBuy: false,
    canPrint: true,
    canFetchLabel: false,
    canTrack: false,
    labelMode: 'generic',
    channel: null,
  },
};

/**
 * Safe all-`false` capabilities for an unknown / legacy `tipo`. Firestore docs
 * reach the UI **unparsed**, so a corrupt or legacy `tipo` can be a string
 * outside the enum; returning this (instead of `undefined`) keeps the lookup
 * from crashing the row action / Frete tab.
 */
const UNSUPPORTED_FREIGHT_CAPS: FreightTipoCapabilities = {
  marketplaceOwned: false,
  canQuote: false,
  canBuy: false,
  canPrint: false,
  canFetchLabel: false,
  canTrack: false,
  labelMode: 'none',
  channel: null,
};

/**
 * Capabilities for a freight `tipo`, **tolerant of an unknown / legacy value**.
 * `tipo` reaches the UI straight from Firestore (no Zod parse), so it can be a
 * string outside `IntegracaoFrete` (or `null` while a doc resolves); anything
 * unrecognized → all-`false` `UNSUPPORTED_FREIGHT_CAPS`, matching the pre-table
 * behavior where an unknown tipo was simply "unsupported" / non-marketplace —
 * never a crash. Prefer this over indexing `FREIGHT_TIPO_CAPS` directly at any
 * call site fed by unparsed data.
 */
export function freightCapsFor(tipo: string | null | undefined): FreightTipoCapabilities {
  if (tipo == null) return UNSUPPORTED_FREIGHT_CAPS;
  return FREIGHT_TIPO_CAPS[tipo as IntegracaoFrete] ?? UNSUPPORTED_FREIGHT_CAPS;
}

/**
 * Single definition of "the importing marketplace owns this freight block" — the
 * read-only lock the Frete tab applies, reused server-side by the pedido estado
 * reconcile (#702). Tolerant of an unknown / null tipo, like {@link freightCapsFor}:
 * unrecognized → not marketplace-owned.
 */
export function isFreteMarketplaceOwned(tipo: string | null | undefined): boolean {
  return freightCapsFor(tipo).marketplaceOwned;
}

/* -------------------------------------------------------------------------- */
/*           Nested entity schemas — Transportadora, Veiculo, etc.            */
/*                                                                            */
/*  Flutter wire shapes — lowercase field names, NOT the NFe XSD names        */
/*  (`CNPJ`/`xNome`/`xEnder`…). The NFe orchestrator remaps to the XSD        */
/*  names at the `<transp>` boundary, exactly like Volume → `<vol>`           */
/*  (`apps/nfe/lib/nfe/orchestrator/generator-input.ts`).                     */
/* -------------------------------------------------------------------------- */

/**
 * Transportadora — Flutter wire shape from `Transportadora` at
 * `.old/packages/pedido/lib/src/models.dart:796-848` (`cnpj`, `ie`, `nome`,
 * `endereco`, `municipio`, `uf`). There is no CPF field on the wire — the
 * legacy model only carries a 14-digit `cnpj`.
 */
export const transportadoraSchema = z
  .object({
    cnpj: z.string().nullable().default(null).describe('CNPJ'),
    ie: z.string().nullable().default(null).describe('Inscrição Estadual'),
    nome: z.string().max(60).nullable().default(null).describe('Razão social ou nome'),
    endereco: z.string().max(60).nullable().default(null).describe('Endereço'),
    municipio: z.string().max(60).nullable().default(null).describe('Município'),
    uf: ufSchema.nullable().default(null).describe('UF'),
  })
  .passthrough();
export type Transportadora = z.infer<typeof transportadoraSchema>;

/**
 * Veiculo — Flutter wire shape from `Veiculo` at
 * `.old/packages/pedido/lib/src/models.dart:860-895` (`placa`, `uf`,
 * `rntc`). `placa` and `uf` are required — the legacy decoder crashes on
 * null, so Flutter-written docs always carry both.
 */
export const veiculoSchema = z
  .object({
    placa: z.string().min(1).max(60).describe('Placa'),
    uf: ufSchema.describe('UF'),
    rntc: z.string().max(60).nullable().default(null).describe('RNTC'),
  })
  .passthrough();
export type Veiculo = z.infer<typeof veiculoSchema>;

/**
 * Reboque (trailer) — separate legacy class
 * (`.old/packages/pedido/lib/src/models.dart:907-934`) with the same wire
 * shape as Veiculo.
 */
export const reboqueSchema = veiculoSchema;
export type Reboque = Veiculo;

/**
 * Dimensões (cm) of a Volume. Mirrors `Dimensoes` at
 * `.old/packages/pedido/lib/src/models.dart:1048` — all three required.
 */
export const dimensoesSchema = z
  .object({
    altura: z.number().describe('Altura (cm)'),
    largura: z.number().describe('Largura (cm)'),
    comprimento: z.number().describe('Comprimento (cm)'),
  })
  .passthrough();
export type Dimensoes = z.infer<typeof dimensoesSchema>;

/**
 * Volume — Flutter wire shape from `Volume` at
 * `.old/packages/pedido/lib/src/models.dart:955-1037` (`quantidade`,
 * `especie`, `pesoBruto`…), NOT the NFe XSD `<vol>` names (`qVol`, `esp`,
 * `pesoB`…). The NFe orchestrator remaps to XSD names at the `<transp>`
 * boundary (`apps/nfe/lib/nfe/orchestrator/generator-input.ts`).
 */
export const volumeSchema = z
  .object({
    quantidade: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Quantidade de volumes transportados'),
    especie: z.string().max(60).nullable().default(null).describe('Espécie'),
    marca: z.string().max(60).nullable().default(null).describe('Marca'),
    numero: z.string().max(60).nullable().default(null).describe('Numeração'),
    pesoBruto: z.number().nullable().default(null).describe('Peso Bruto (KG)'),
    pesoLiquido: z.number().nullable().default(null).describe('Peso Líquido (KG)'),
    dimensoes: dimensoesSchema.nullable().default(null).describe('Dimensões'),
    lacres: z.array(z.string()).nullable().default(null).describe('Lacres'),
  })
  .passthrough();
export type Volume = z.infer<typeof volumeSchema>;

/* -------------------------------------------------------------------------- */
/*                          FreteDoPedido — main schema                       */
/* -------------------------------------------------------------------------- */

/**
 * FreteDoPedido — shipping block embedded as `pedido.freteInicial`.
 * Ported from `.old/packages/pedido/lib/src/models.dart:389-625`.
 * `.passthrough()` for any Flutter-only fields not enumerated below.
 */
export const freteDoPedidoSchema = z
  .object({
    // External tracking ----------------------------------------------------
    externalId: z.string().nullable().default(null).describe('ID externo'),
    printLabelId: z.string().nullable().default(null).describe('ID da etiqueta'),
    externalOptionId: z.string().nullable().default(null).describe('Opção externa (ID)'),
    externalOptionIntegracao: integracoesFreteSchema
      .nullable()
      .default(null)
      .describe('Integração da opção externa'),
    externalOptionData: z
      .record(z.string(), z.unknown())
      .nullable()
      .default(null)
      .describe('Dados da opção externa'),
    /** Selection moment for the marketplace freight option (µs since epoch). */
    externalOptionSelectionDate: microsSinceEpoch('Data de seleção da opção externa')
      .nullable()
      .default(null),

    // Status + routing ------------------------------------------------------
    estado: estadoFreteSchema.describe('Estado do frete'),
    integracaoFreteOuterRef: outerRefSchema
      .nullable()
      .default(null)
      .describe('Integração do frete'),
    integracaoTargetOuterRef: outerRefSchema
      .nullable()
      .default(null)
      .describe('Target da integração'),
    /** Legacy path field; kept for parse compatibility, slated for removal. */
    integracao_path: z.string().nullable().default(null).describe('Path da integração'),

    // Recipients ------------------------------------------------------------
    clienteRecebedorOuterReference: outerRefSchema
      .nullable()
      .default(null)
      .describe('Cliente recebedor'),
    enderecoFreteOuterReference: outerRefSchema
      .nullable()
      .default(null)
      .describe('Endereço de entrega'),

    // Modality + entities ---------------------------------------------------
    /**
     * ⚠️ FISCAL DEFAULT — deliberately NOT the legacy read default.
     *
     * `'0'` (CIF, contratação por conta do emitente) is the ONLY modalidade that
     * charges the freight INTO the nota, and three reads in
     * `apps/nfe/lib/nfe/orchestrator/generator-input.ts` key on it — all three
     * see whatever this default produces, because `bundle.ts:parseFreteFromPedido`
     * feeds the generator through `freteDoPedidoSchema.safeParse`:
     *   - `vFrete` → `det[…].prod.vFrete`, `ICMSTot.vFrete` and the `vNF` sum;
     *   - the single-payment `vPag` override (the payment absorbs the freight);
     *   - the `<cobr>` duplicata values, which follow that same override.
     * A block stored WITHOUT `modalidade` must therefore never read back as CIF:
     * the store would pay ICMS on freight a third party charged (#1090).
     *
     * `'1'` (destinatário / FOB) declares the freight — `<transp><modFrete>` still
     * carries the code — without charging it, and keeps the transportadora /
     * veículo / volume sub-blocks that `'9'` would suppress
     * ({@link freteDoPedidoSchema} readers short-circuit on `'9'`).
     *
     * This DIVERGES from legacy read-parity on purpose. Flutter's
     * `_modalidadeFreteFromJson` (`.old/packages/pedido/lib/src/models.dart:344`)
     * answers `contratacaoEmitente` for an absent value — but that shape is not
     * one we inherit: the Dart field is non-nullable and its `@JsonKey` carries no
     * `includeIfNull: false`, so every doc the legacy model serializes HAS the
     * key, and the legacy CONSTRUCTOR default is `semFrete`, never CIF. Do not
     * "restore parity" by putting `'0'` back.
     */
    modalidade: modalidadeFreteSchema.default(MODALIDADE_FRETE.fob).describe('Modalidade'),
    transportadora: transportadoraSchema.nullable().default(null).describe('Transportadora'),
    veiculo: veiculoSchema.nullable().default(null).describe('Veículo'),
    reboques: z.array(reboqueSchema).nullable().default(null).describe('Reboques'),
    vagao: z.string().max(20).nullable().default(null).describe('Vagão'),
    balsa: z.string().max(20).nullable().default(null).describe('Balsa'),
    volumes: z.array(volumeSchema).nullable().default(null).describe('Volumes'),
    /** Tracking code (max 200 per Flutter constraint). */
    codRastreio: z.string().max(200).nullable().default(null).describe('Código de rastreio'),

    // Costs -----------------------------------------------------------------
    valorCobrado: z.number().nullable().default(null).describe('Valor cobrado do frete'),
    custoCalculado: z.number().nullable().default(null).describe('Custo calculado'),
    custoFinal: z.number().nullable().default(null).describe('Custo final'),

    // Schedule — DateTime fields stored as µs since epoch -------------------
    ehReverso: z.boolean().default(false).describe('Frete reverso'),
    /** Extra days added to the shipping deadline (a day count, not a date). */
    prazoExtra: z.number().int().default(0).describe('Prazo extra (dias)'),
    /** Max dispatch deadline (the field the table view's "Expedição" column reads). */
    prazoDespacho: microsSinceEpoch('Prazo de despacho').nullable().default(null),
    dataEntrega: microsSinceEpoch('Data de entrega').nullable().default(null),
    dataPrevisaoEntrega: microsSinceEpoch('Previsão de entrega').nullable().default(null),

    // Insurance + delivery options -----------------------------------------
    valor_assegurado: z.number().nullable().default(null).describe('Valor assegurado'),
    maoPropria: z.boolean().nullable().default(null).describe('Mão própria'),
    avisoRecebimento: z.boolean().nullable().default(null).describe('Aviso de recebimento'),

    // Timestamps — µs since epoch ------------------------------------------
    ultimaModificacao: microsSinceEpoch('Última modificação').nullable().default(null),
    timestamp: microsSinceEpoch('Criação').nullable().default(null),
  })
  .passthrough();
export type FreteDoPedido = z.infer<typeof freteDoPedidoSchema>;

/**
 * A fresh `freteInicial` block for a pedido that has none.
 *
 * Every wire key starts at its schema default, which is Flutter's — with two
 * exceptions. `ehReverso` is direction-aware: an entrada (`ehSaida: false`) is a
 * cliente → loja shipment, so its freight defaults to reverse (legacy parity).
 * And `modalidade` always comes from the caller, so the schema default never
 * applies here — that default deliberately diverges from Flutter's read default
 * (#1090).
 *
 * ⚠️ Lives in `@delfrance/schemas`, beside the schema it seeds, because it has
 * TWO callers that must not disagree: the pedido form's Frete tab, where an
 * operator picks a modalidade, and the Mercado Livre order import, which
 * synthesizes a block for an order sold with no Mercado Envios shipment
 * ("frete a combinar"). A private second copy is the #810 shape.
 */
export function seedFreteInicial(modalidade: ModalidadeFrete, ehSaida: boolean): FreteDoPedido {
  return freteDoPedidoSchema.parse({
    estado: ESTADO_FRETE.iniciado,
    modalidade,
    ehReverso: !ehSaida,
  });
}
