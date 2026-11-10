import { z } from 'zod';
import { categoriaCatalogoLiSchema, marcaCatalogoLiSchema } from './catalogoLojaIntegrada';
import { contaIdLiSchema } from './notificacaoLojaIntegrada';
import {
  produtoLiDetalhadoSchema,
  produtoLiLidoSchema,
  tipoProdutoLiSchema,
} from './produtoImportacaoLi';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `importacoesLojaIntegrada` (TOP-LEVEL) — one Loja Integrada PRODUCT IMPORT run (master plan step
 * 9, #1820): an operator-started, resumable job that reads one store's product catalogue and links
 * the store's products to ERP products and, when asked, completes the ERP side — never
 * overwriting anything, never importing price or stock (the owner's decision of 2026-10-27).
 *
 * ONE document per run, auto id. The start route creates it `pendente` (the route makes no Loja
 * Integrada call); a Firestore trigger enqueues its first task onto the conta's READS queue; each
 * dispatch works for at most {@link ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS} plus a
 * {@link CAUDA_DESPACHO_IMPORTACAO_LI_MS} tail, checkpoints after every unit, and continues through
 * a NAMED task ({@link idTarefaImportacaoLi}), so a duplicate delivery or a lost hand-off can
 * neither run a dispatch twice nor strand the job.
 *
 * ## The phases, in order
 * `catalogo` (the store's category and brand lists, page by page, once per job) → `listagem` (the
 * product list, `removido=false`, a snapshot in `paginas/*`) → `lixeira` (the TRASH list,
 * `removido=true`, read once per job after the listing, so a variation that no listed parent
 * claims and a trashed parent claims is known to be in the trash without a detail read) →
 * `orfaos` (a detail read for every unclaimed variation the trash does not explain, to attach it
 * through its `pai`) → `evidencias` (the exact-SKU claims for unlinked store options) →
 * `aprendizado` (only unanimous claims become option links) → `familias` (family by family: match,
 * plan, write) → `revisao` (the tax-review re-check, `aplicar` only) → `fim`.
 *
 * ## ⚠️ Units
 * Every stamp in this document and its subcollections is MILLISECONDS (`…Ms`). The import writes
 * produtos, whose stamps are ms; the avisos it raises take their µs clocks through the app's own
 * converter, never from a field here.
 *
 * ## ⚠️ Every field carries a `.default()`, from day one
 * A job document written before a field shipped must still parse, or an in-flight import stops
 * resuming the moment a backend is deployed under it (the Shopee importer's retrofit lesson). The
 * only required fields are the three every create writes: `integracaoId`, `status`,
 * `iniciadoEmMs`. Every array default is a FUNCTION, so no two parses share one array. One field
 * also tolerates a stored value it cannot read: `progressoDaFamilia` then reads as `null` and the
 * family is prepared again ({@link progressoDaFamiliaLiSchema}).
 *
 * ## The subcollections
 * Five, all written only by this job, default-denied like the parent (no rules match block):
 * `paginas/{tipo}-{offset}` ({@link paginaListagemLiSchema}), `detalhes/{liId}`
 * ({@link detalheProdutoLiSchema}), `evidencias/{gradeId}_{opcaoId}`
 * ({@link evidenciaOpcaoLiSchema}), `itens/{liId}` ({@link itemImportacaoLiSchema}) and
 * `revisao/{produtoId}` ({@link revisaoFiscalLiSchema}). A page holds only compact ROW views and a
 * detail only the DETAIL view, so no document approaches Firestore's 1 MiB limit.
 *
 * ## Admin-only / default-deny
 * Permissions are `0n` and the schema is deliberately NOT registered in `ALL_DOMAINS` (the
 * `importacaoShopee` shape), so the rules generator emits no match block and no ruleset changes.
 * Only the authed routes of `apps/loja-integrada` and its nested functions codebase (Admin SDK)
 * touch this collection.
 *
 * ⚠️ The start guard and the web's list query `integracaoId == <conta> orderBy iniciadoEmMs desc
 * limit 10`, served by the `(integracaoId ASC, iniciadoEmMs DESC)` composite declared by hand in
 * `firestore.indexes.json` and pinned by `importacaoLojaIntegrada.indexes.test.ts`: there is no
 * `meta.defaultQuery` here, so `delfrance/default-query-needs-index` cannot see it, and on Firestore
 * Enterprise a missing composite does not throw — it full-scans and bills.
 */

/* -------------------------------------------------------------------------- */
/*                                  Constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * The work budget of ONE dispatch: a unit (one Loja Integrada call, one photo, one family with no
 * call) starts only while its worst case still ends inside it.
 */
export const ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS = 70_000;

/**
 * The tail after the budget: the last writes, the end-of-dispatch checkpoint and the continuation
 * enqueue. Budget + tail = 100 s: an order-intake task sharing the reads queue waits at most one
 * such dispatch PER IMPORT RUNNING AT ONCE (one per conta) — its retry ladder fits half the hot
 * sweep's hour with one import, the whole hour with up to seven (`importacao/orcamento.ts` and
 * `functions/src/index.test.ts` in `apps/loja-integrada`).
 */
export const CAUDA_DESPACHO_IMPORTACAO_LI_MS = 30_000;

/** The most store products one "Importar selecionados" may name. */
export const MAX_SELECIONADOS_LI = 1_000;

/** The 60-second pauses after a 429 one job may take before it fails (`limite-de-chamadas`). */
export const MAX_PAUSAS_429_LI = 10;

/**
 * The `limit` every product list page asks for (the listing and the trash list): 100. The owner's
 * read-only capture read `meta.limit` back as 100, and a `limit` of 200, 500 or 1000 was refused
 * with a 400, so the store's ceiling lies between 100 and 199 and the import asks for 100, the
 * largest page measured to work. The client still reads `meta.limit` back (stored as
 * `limiteLido`). The catalogue lists keep their own 50.
 */
export const LIMITE_PAGINA_PRODUTOS_LI = 100;

/** The jobs the start guard and the web's list read, newest first. */
export const LIMITE_IMPORTACOES_LISTADAS_LI = 10;

/** The report items one page of the items route answers. */
export const LIMITE_ITENS_IMPORTACAO_LI = 500;

/** A job's own id (an auto id) as every surface accepts it: it is part of a task name. */
export const ID_IMPORTACAO_LI_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/* -------------------------------------------------------------------------- */
/*                                The options                                  */
/* -------------------------------------------------------------------------- */

/** `simular` reads and decides exactly as `aplicar` does, and writes only the job. */
export const modoImportacaoLiSchema = z.enum(['simular', 'aplicar']);
export type ModoImportacaoLi = z.infer<typeof modoImportacaoLiSchema>;
/** Named members of {@link modoImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MODO_IMPORTACAO_LI = {
  simular: 'simular',
  aplicar: 'aplicar',
} as const satisfies Record<string, ModoImportacaoLi>;

/**
 * Which store products: all; the ones named (from a finished Simular); those not yet in the ERP;
 * those already in the ERP (linked to this store, or found by exactly one SKU).
 */
export const alvoImportacaoLiSchema = z.enum(['todos', 'selecionados', 'naoNoErp', 'jaNoErp']);
export type AlvoImportacaoLi = z.infer<typeof alvoImportacaoLiSchema>;
/** Named members of {@link alvoImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ALVO_IMPORTACAO_LI = {
  todos: 'todos',
  selecionados: 'selecionados',
  naoNoErp: 'naoNoErp',
  jaNoErp: 'jaNoErp',
} as const satisfies Record<string, AlvoImportacaoLi>;

/** `completar` creates what is missing and fills only EMPTY ERP fields; `soVincular` changes nothing. */
export const acaoImportacaoLiSchema = z.enum(['completar', 'soVincular']);
export type AcaoImportacaoLi = z.infer<typeof acaoImportacaoLiSchema>;
/** Named members of {@link acaoImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ACAO_IMPORTACAO_LI = {
  completar: 'completar',
  soVincular: 'soVincular',
} as const satisfies Record<string, AcaoImportacaoLi>;

/** Categories under `completar`: create the missing ones and link them, or only use linked ones. */
export const categoriasImportacaoLiSchema = z.enum(['criarEVincular', 'soVincular']);
export type CategoriasImportacaoLi = z.infer<typeof categoriasImportacaoLiSchema>;
/** Named members of {@link categoriasImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const CATEGORIAS_IMPORTACAO_LI = {
  criarEVincular: 'criarEVincular',
  soVincular: 'soVincular',
} as const satisfies Record<string, CategoriasImportacaoLi>;

/** Photos under `completar`: none, or only onto a produto that has none. */
export const fotosImportacaoLiSchema = z.enum(['naoImportar', 'soSemFotos']);
export type FotosImportacaoLi = z.infer<typeof fotosImportacaoLiSchema>;
/** Named members of {@link fotosImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FOTOS_IMPORTACAO_LI = {
  naoImportar: 'naoImportar',
  soSemFotos: 'soSemFotos',
} as const satisfies Record<string, FotosImportacaoLi>;

/**
 * ONE source of every option default — the job schema's `.default()`s read it. Each default is
 * the option that changes the least: a document missing an option reads as a Simular that links
 * only, with no category created and no photo copied.
 */
export const OPCOES_IMPORTACAO_LI_PADRAO = {
  modo: MODO_IMPORTACAO_LI.simular,
  alvo: ALVO_IMPORTACAO_LI.todos,
  acao: ACAO_IMPORTACAO_LI.soVincular,
  categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
  fotos: FOTOS_IMPORTACAO_LI.naoImportar,
} as const;

/** A Loja Integrada id: a positive safe integer. */
const idLiSchema = z.number().int().positive();

/** A job id as a field: the same grammar as the document id. */
const idImportacaoLiSchema = z.string().regex(ID_IMPORTACAO_LI_REGEX);

/**
 * `POST …/conta/[id]/importacoes` — the start body. STRICT: an unknown key is a 400.
 *
 *  - `modo`, `alvo` and `acao` are required: the operator always says what to do;
 *  - `categorias` and `fotos` default to the option that changes the least, and are refused
 *    unless at that default under `soVincular` (they mean something under `completar` only, and a
 *    body asking otherwise is contradictory, never silently ignored);
 *  - `selecionados` (store PARENT or simple product ids) is required exactly when `alvo` is
 *    `selecionados`, and refused otherwise; at most {@link MAX_SELECIONADOS_LI};
 *  - `simulacaoId` is the finished Simular the selection came from (informational).
 */
export const opcoesImportacaoLiSchema = z
  .strictObject({
    modo: modoImportacaoLiSchema,
    alvo: alvoImportacaoLiSchema,
    acao: acaoImportacaoLiSchema,
    categorias: categoriasImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.categorias),
    fotos: fotosImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.fotos),
    selecionados: z
      .array(idLiSchema)
      .max(MAX_SELECIONADOS_LI)
      .default(() => []),
    simulacaoId: idImportacaoLiSchema.nullable().default(null),
  })
  .superRefine((corpo, ctx) => {
    const comSelecao = corpo.alvo === ALVO_IMPORTACAO_LI.selecionados;
    if (comSelecao && corpo.selecionados.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['selecionados'],
        message: 'nenhum produto selecionado',
      });
    }
    if (!comSelecao && corpo.selecionados.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['selecionados'],
        message: 'produtos selecionados só com o alvo "selecionados"',
      });
    }
    if (corpo.acao === ACAO_IMPORTACAO_LI.soVincular) {
      if (corpo.categorias !== OPCOES_IMPORTACAO_LI_PADRAO.categorias) {
        ctx.addIssue({ code: 'custom', path: ['categorias'], message: 'só com "completar"' });
      }
      if (corpo.fotos !== OPCOES_IMPORTACAO_LI_PADRAO.fotos) {
        ctx.addIssue({ code: 'custom', path: ['fotos'], message: 'só com "completar"' });
      }
    }
  });
export type OpcoesImportacaoLi = z.infer<typeof opcoesImportacaoLiSchema>;

/* -------------------------------------------------------------------------- */
/*                              Status and phases                              */
/* -------------------------------------------------------------------------- */

/**
 * `pendente` (created, no dispatch yet) → `executando` → `concluido` | `falhou` | `cancelado`.
 * Only a document CREATED `pendente` is enqueued by the trigger.
 */
export const statusImportacaoLiSchema = z.enum([
  'pendente',
  'executando',
  'concluido',
  'falhou',
  'cancelado',
]);
export type StatusImportacaoLi = z.infer<typeof statusImportacaoLiSchema>;
/** Named members of {@link statusImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const STATUS_IMPORTACAO_LI = {
  pendente: 'pendente',
  executando: 'executando',
  concluido: 'concluido',
  falhou: 'falhou',
  cancelado: 'cancelado',
} as const satisfies Record<string, StatusImportacaoLi>;

/** The statuses of a job still running: one per conta at a time (the start guard's 409). */
export const STATUS_EM_CURSO_IMPORTACAO_LI: ReadonlySet<StatusImportacaoLi> = new Set([
  STATUS_IMPORTACAO_LI.pendente,
  STATUS_IMPORTACAO_LI.executando,
]);

/** The phases, in order (see the header). */
export const faseImportacaoLiSchema = z.enum([
  'catalogo',
  'listagem',
  'lixeira',
  'orfaos',
  'evidencias',
  'aprendizado',
  'familias',
  'revisao',
  'fim',
]);
export type FaseImportacaoLi = z.infer<typeof faseImportacaoLiSchema>;
/** Named members of {@link faseImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FASE_IMPORTACAO_LI = {
  catalogo: 'catalogo',
  listagem: 'listagem',
  lixeira: 'lixeira',
  orfaos: 'orfaos',
  evidencias: 'evidencias',
  aprendizado: 'aprendizado',
  familias: 'familias',
  revisao: 'revisao',
  fim: 'fim',
} as const satisfies Record<string, FaseImportacaoLi>;

/**
 * Why a job ended `falhou` — a closed CODE the card renders:
 *  - `chamadas-desligadas`: the read switch is off (a restart is safe once it is on);
 *  - `conta-indisponivel`: the conta is gone, inactive, parked or without a usable credential;
 *  - `tentativas-esgotadas`: the queue's last attempt failed;
 *  - `limite-de-chamadas`: more than {@link MAX_PAUSAS_429_LI} pauses after a 429;
 *  - `tarefas-desligadas`: the tasks valve refused the continuation (never a silent stall);
 *  - `catalogo-excede-limite`: a catalogue list needs more pages than its ceiling.
 */
export const motivoFalhaImportacaoLiSchema = z.enum([
  'chamadas-desligadas',
  'conta-indisponivel',
  'tentativas-esgotadas',
  'limite-de-chamadas',
  'tarefas-desligadas',
  'catalogo-excede-limite',
]);
export type MotivoFalhaImportacaoLi = z.infer<typeof motivoFalhaImportacaoLiSchema>;
/** Named members of {@link motivoFalhaImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_FALHA_IMPORTACAO_LI = {
  chamadasDesligadas: 'chamadas-desligadas',
  contaIndisponivel: 'conta-indisponivel',
  tentativasEsgotadas: 'tentativas-esgotadas',
  limiteDeChamadas: 'limite-de-chamadas',
  tarefasDesligadas: 'tarefas-desligadas',
  catalogoExcedeLimite: 'catalogo-excede-limite',
} as const satisfies Record<string, MotivoFalhaImportacaoLi>;

/* -------------------------------------------------------------------------- */
/*                                The pendências                               */
/* -------------------------------------------------------------------------- */

/**
 * The CLOSED vocabulary of what a report item may say needs a person or happened. Two halves:
 *
 * **Actionable** ({@link PENDENCIAS_ACIONAVEIS_LI}) — a person can fix it in the ERP or in the
 * store; they keep the per-conta summary aviso open: `sem-sku`, `sku-ambiguo`, `sku-parecido`,
 * `sku-ja-existe`, `sku-repetido-na-loja`, `sku-parecido-na-loja` (a SKU that another store row
 * shares a probe form with, or that meets another row's derived sole-member SKU: it means the row
 * must not be created or matched by SKU), `vinculo-ambiguo`, `vinculado-a-outro`,
 * `vinculo-pai-ausente`, `vinculo-ilegivel`, `forma-diferente`, `filho-de-outra-familia`,
 * `grade-sem-vinculo`, `opcao-sem-vinculo`, `grade-em-dois-grupos`, `opcao-em-dois-grupos`,
 * `variacao-ambigua`, `variacao-sem-vinculo`, `evidencia-divergente`, `categoria-sem-vinculo`,
 * `categoria-recusada`, `categoria-ambigua`, `descricao-longa`, `dado-invalido`,
 * `conflito-de-escrita`.
 *
 * **Informational** — a fact of the store or of this run; shown in the report, never keeps an
 * aviso open: `orfao`, `na-lixeira` (a variation whose parent is in the store's trash: never
 * linked, never created), `familia-vazia`, `tipo-desconhecido`, `oculto-nao-criado`,
 * `nome-cortado` (a produto this run created, or under Simular would create, whose name was cut at
 * the ERP's 100-character limit), `nao-listado`, `sku-diferente`, `vinculo-atualizado`, `foto-recusada`, `sem-estoque-no-erp`,
 * `sem-preco-no-erp`, `revisao-fiscal`.
 */
export const pendenciaImportacaoLiSchema = z.enum([
  'sem-sku',
  'sku-ambiguo',
  'sku-parecido',
  'sku-ja-existe',
  'sku-repetido-na-loja',
  'sku-parecido-na-loja',
  'vinculo-ambiguo',
  'vinculado-a-outro',
  'vinculo-pai-ausente',
  'vinculo-ilegivel',
  'forma-diferente',
  'filho-de-outra-familia',
  'grade-sem-vinculo',
  'opcao-sem-vinculo',
  'grade-em-dois-grupos',
  'opcao-em-dois-grupos',
  'variacao-ambigua',
  'variacao-sem-vinculo',
  'evidencia-divergente',
  'categoria-sem-vinculo',
  'categoria-recusada',
  'categoria-ambigua',
  'descricao-longa',
  'dado-invalido',
  'conflito-de-escrita',
  'orfao',
  'na-lixeira',
  'familia-vazia',
  'tipo-desconhecido',
  'oculto-nao-criado',
  'nome-cortado',
  'nao-listado',
  'sku-diferente',
  'vinculo-atualizado',
  'foto-recusada',
  'sem-estoque-no-erp',
  'sem-preco-no-erp',
  'revisao-fiscal',
]);
export type PendenciaImportacaoLi = z.infer<typeof pendenciaImportacaoLiSchema>;

/** Named members of {@link pendenciaImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const PENDENCIA_IMPORTACAO_LI = {
  semSku: 'sem-sku',
  skuAmbiguo: 'sku-ambiguo',
  skuParecido: 'sku-parecido',
  skuJaExiste: 'sku-ja-existe',
  skuRepetidoNaLoja: 'sku-repetido-na-loja',
  skuParecidoNaLoja: 'sku-parecido-na-loja',
  vinculoAmbiguo: 'vinculo-ambiguo',
  vinculadoAOutro: 'vinculado-a-outro',
  vinculoPaiAusente: 'vinculo-pai-ausente',
  vinculoIlegivel: 'vinculo-ilegivel',
  formaDiferente: 'forma-diferente',
  filhoDeOutraFamilia: 'filho-de-outra-familia',
  gradeSemVinculo: 'grade-sem-vinculo',
  opcaoSemVinculo: 'opcao-sem-vinculo',
  gradeEmDoisGrupos: 'grade-em-dois-grupos',
  opcaoEmDoisGrupos: 'opcao-em-dois-grupos',
  variacaoAmbigua: 'variacao-ambigua',
  variacaoSemVinculo: 'variacao-sem-vinculo',
  evidenciaDivergente: 'evidencia-divergente',
  categoriaSemVinculo: 'categoria-sem-vinculo',
  categoriaRecusada: 'categoria-recusada',
  categoriaAmbigua: 'categoria-ambigua',
  descricaoLonga: 'descricao-longa',
  dadoInvalido: 'dado-invalido',
  conflitoDeEscrita: 'conflito-de-escrita',
  orfao: 'orfao',
  naLixeira: 'na-lixeira',
  familiaVazia: 'familia-vazia',
  tipoDesconhecido: 'tipo-desconhecido',
  ocultoNaoCriado: 'oculto-nao-criado',
  nomeCortado: 'nome-cortado',
  naoListado: 'nao-listado',
  skuDiferente: 'sku-diferente',
  vinculoAtualizado: 'vinculo-atualizado',
  fotoRecusada: 'foto-recusada',
  semEstoqueNoErp: 'sem-estoque-no-erp',
  semPrecoNoErp: 'sem-preco-no-erp',
  revisaoFiscal: 'revisao-fiscal',
} as const satisfies Record<string, PendenciaImportacaoLi>;

/** The ACTIONABLE half of {@link pendenciaImportacaoLiSchema}: what keeps the summary aviso open. */
export const PENDENCIAS_ACIONAVEIS_LI: ReadonlySet<PendenciaImportacaoLi> = new Set([
  PENDENCIA_IMPORTACAO_LI.semSku,
  PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
  PENDENCIA_IMPORTACAO_LI.skuParecido,
  PENDENCIA_IMPORTACAO_LI.skuJaExiste,
  PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja,
  PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja,
  PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo,
  PENDENCIA_IMPORTACAO_LI.vinculadoAOutro,
  PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente,
  PENDENCIA_IMPORTACAO_LI.vinculoIlegivel,
  PENDENCIA_IMPORTACAO_LI.formaDiferente,
  PENDENCIA_IMPORTACAO_LI.filhoDeOutraFamilia,
  PENDENCIA_IMPORTACAO_LI.gradeSemVinculo,
  PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo,
  PENDENCIA_IMPORTACAO_LI.gradeEmDoisGrupos,
  PENDENCIA_IMPORTACAO_LI.opcaoEmDoisGrupos,
  PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
  PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
  PENDENCIA_IMPORTACAO_LI.evidenciaDivergente,
  PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo,
  PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
  PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
  PENDENCIA_IMPORTACAO_LI.descricaoLonga,
  PENDENCIA_IMPORTACAO_LI.dadoInvalido,
  PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
]);

/** Whether a pendência keeps the summary aviso open. A code this build does not know does not. */
export function ehPendenciaAcionavelLi(codigo: string): boolean {
  const lido = pendenciaImportacaoLiSchema.safeParse(codigo);
  return lido.success && PENDENCIAS_ACIONAVEIS_LI.has(lido.data);
}

/* -------------------------------------------------------------------------- */
/*                               The subcollections                            */
/* -------------------------------------------------------------------------- */

/** The five subcollections of a job document (see the header). */
export const SUBCOLECOES_IMPORTACAO_LI = {
  paginas: 'paginas',
  detalhes: 'detalhes',
  evidencias: 'evidencias',
  itens: 'itens',
  revisao: 'revisao',
} as const;

/** Which product list a snapshot page belongs to: the listing, or the store's trash. */
export const tipoPaginaImportacaoLiSchema = z.enum(['listagem', 'lixeira']);
export type TipoPaginaImportacaoLi = z.infer<typeof tipoPaginaImportacaoLiSchema>;
/** Named members of {@link tipoPaginaImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_PAGINA_IMPORTACAO_LI = {
  listagem: 'listagem',
  lixeira: 'lixeira',
} as const satisfies Record<string, TipoPaginaImportacaoLi>;

/**
 * The doc id of a snapshot page: `<tipo>-<offset>`, the offset zero-padded to 9 digits so the
 * pages of one list sort by offset in document-key order.
 */
export function idPaginaImportacaoLi(tipo: TipoPaginaImportacaoLi, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`idPaginaImportacaoLi: offset inválido (${String(offset)})`);
  }
  return `${tipo}-${String(offset).padStart(9, '0')}`;
}

/**
 * `paginas/{tipo}-{offset}` — one page of a product list as read: the compact ROW views (no
 * description text), never the wire rows.
 */
export const paginaListagemLiSchema = z.object({
  tipo: tipoPaginaImportacaoLiSchema,
  /** The offset this page was asked for. */
  offset: z.number().int().nonnegative(),
  linhas: z.array(produtoLiLidoSchema).default(() => []),
  /** Rows whose `id` is not a positive safe integer: dropped, counted. */
  linhasSemId: z.number().int().nonnegative().default(0),
  /** `meta.limit` as the store answered it. */
  limiteLido: z.number().int().nullable().default(null),
  /** `meta.total_count` as the store answered it. */
  totalLi: z.number().int().nullable().default(null),
  lidaEmMs: millisSinceEpoch(),
});
export type PaginaListagemLi = z.infer<typeof paginaListagemLiSchema>;

/** A detail read's outcome: read, or the store answered 404 (deleted, or never this store's). */
export const estadoDetalheImportacaoLiSchema = z.enum(['lido', 'inexistente']);
export type EstadoDetalheImportacaoLi = z.infer<typeof estadoDetalheImportacaoLiSchema>;
/** Named members of {@link estadoDetalheImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ESTADO_DETALHE_IMPORTACAO_LI = {
  lido: 'lido',
  inexistente: 'inexistente',
} as const satisfies Record<string, EstadoDetalheImportacaoLi>;

/** `detalhes/{liId}` — one product detail read by this job: the DETAIL view only. */
export const detalheProdutoLiSchema = z.object({
  liId: idLiSchema,
  estado: estadoDetalheImportacaoLiSchema,
  /** `null` when `inexistente`. */
  detalhe: produtoLiDetalhadoSchema.nullable().default(null),
  lidoEmMs: millisSinceEpoch(),
});
export type DetalheImportacaoLi = z.infer<typeof detalheProdutoLiSchema>;

/** The doc id of an evidence document: `<gradeId>_<opcaoId>`. */
export function idEvidenciaImportacaoLi(gradeId: number, opcaoId: number): string {
  if (
    !Number.isSafeInteger(gradeId) ||
    gradeId <= 0 ||
    !Number.isSafeInteger(opcaoId) ||
    opcaoId <= 0
  ) {
    throw new RangeError(
      `idEvidenciaImportacaoLi: ids inválidos (${String(gradeId)}, ${String(opcaoId)})`,
    );
  }
  return `${String(gradeId)}_${String(opcaoId)}`;
}

/**
 * One DISTINCT claim of the evidence pass about one store option: "option `(g, v)` of this conta =
 * variante X of grupo G", with how many matched children said so. Stored per distinct pair, never
 * per child, so a popular option cannot grow its document without bound.
 */
export const alegacaoOpcaoLiSchema = z.object({
  grupoId: z.string().min(1),
  varianteId: z.string().min(1),
  ocorrencias: z.number().int().positive(),
  /** Every claim of this pair came from a family with ONE axis on both sides. */
  todasDeEixoUnico: z.boolean(),
  /** One store child and the ERP child it was matched to by exact SKU (for the report). */
  exemploLiFilhoId: idLiSchema,
  exemploErpFilhoId: z.string().min(1),
});
export type AlegacaoOpcaoLi = z.infer<typeof alegacaoOpcaoLiSchema>;

/** `evidencias/{gradeId}_{opcaoId}` — every claim the job collected for one store option. */
export const evidenciaOpcaoLiSchema = z.object({
  gradeId: idLiSchema,
  opcaoId: idLiSchema,
  alegacoes: z.array(alegacaoOpcaoLiSchema).default(() => []),
  /** Labels, when known: a learned link fills them only where the stored ones are empty. */
  nomeGrade: z.string().nullable().default(null),
  nomeOpcao: z.string().nullable().default(null),
});
export type EvidenciaOpcaoLi = z.infer<typeof evidenciaOpcaoLiSchema>;

/**
 * Where a store product stands against the ERP: `vinculado` (its link for this conta exists),
 * `encontrado` (found by exactly one SKU, not linked yet), `ausente` (not in the ERP), `conflito`
 * (two owners, two SKU hits, a shape mismatch, no SKU, or a SKU repeated or nearly repeated in the
 * store: in no target but `todos`/`selecionados`, and reported under every target), `nao-listado`
 * (a selected id the store's listing lacks), `avulso`
 * (a live row that belongs to no family — an orphan variation, a variation of a trashed parent, a
 * row of an unknown `tipo` — never matched against the ERP, reported with its informational code).
 */
export const situacaoErpItemLiSchema = z.enum([
  'vinculado',
  'encontrado',
  'ausente',
  'conflito',
  'nao-listado',
  'avulso',
]);
export type SituacaoErpItemLi = z.infer<typeof situacaoErpItemLiSchema>;
/** Named members of {@link situacaoErpItemLiSchema} — see `delfrance/prefer-schema-enum`. */
export const SITUACAO_ERP_ITEM_LI = {
  vinculado: 'vinculado',
  encontrado: 'encontrado',
  ausente: 'ausente',
  conflito: 'conflito',
  naoListado: 'nao-listado',
  avulso: 'avulso',
} as const satisfies Record<string, SituacaoErpItemLi>;

/** What the run did — or, under Simular, would do — for an item. */
export const acaoItemImportacaoLiSchema = z.enum(['vincular', 'criar', 'completar', 'nenhuma']);
export type AcaoItemImportacaoLi = z.infer<typeof acaoItemImportacaoLiSchema>;
/** Named members of {@link acaoItemImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ACAO_ITEM_IMPORTACAO_LI = {
  vincular: 'vincular',
  criar: 'criar',
  completar: 'completar',
  nenhuma: 'nenhuma',
} as const satisfies Record<string, AcaoItemImportacaoLi>;

/**
 * One pendência of an item. `liId` names the variation it is about (`null` = the item itself);
 * `referencias` carries what the code names — the ERP ids of `sku-ja-existe`, the two SKUs of
 * `sku-diferente`, the FIELD NAMES of `dado-invalido` — never a value from a body.
 */
export const pendenciaItemLiSchema = z.object({
  codigo: pendenciaImportacaoLiSchema,
  acionavel: z.boolean(),
  liId: idLiSchema.nullable().default(null),
  referencias: z.array(z.string()).default(() => []),
});
export type PendenciaItemLi = z.infer<typeof pendenciaItemLiSchema>;

/**
 * `itens/{liId}` — the report row of one store parent or simple product, of a selected id the
 * listing lacks (`nao-listado`), or of a loose row (`avulso`).
 */
export const itemImportacaoLiSchema = z.object({
  liId: idLiSchema,
  tipo: tipoProdutoLiSchema,
  sku: z.string().nullable().default(null),
  nome: z.string().nullable().default(null),
  filhos: z.number().int().nonnegative().default(0),
  situacaoErp: situacaoErpItemLiSchema,
  erpId: z.string().nullable().default(null),
  acao: acaoItemImportacaoLiSchema.default(ACAO_ITEM_IMPORTACAO_LI.nenhuma),
  /** `false` under Simular: `acao` is what an `aplicar` run would do. */
  aplicada: z.boolean().default(false),
  /** The ERP field NAMES filled (or that would be). */
  camposPreenchidos: z.array(z.string()).default(() => []),
  /**
   * The store categories this family's run created and linked (Simular: would), root-most first. A
   * category appears on the item of the family that created it, so the report names every category
   * a create-and-link run created, but for a unit retried over its own landed create or category
   * fill: the retry does not plan that category again, so the item stops naming it (the category
   * stands, and a later family that meets it adopts it and names it there). A later family that
   * uses a category the job already holds as linked names none.
   */
  categoriasCriadas: z.array(idLiSchema).default(() => []),
  pendencias: z.array(pendenciaItemLiSchema).default(() => []),
  atualizadoEmMs: millisSinceEpoch(),
});
export type ItemImportacaoLi = z.infer<typeof itemImportacaoLiSchema>;

/** Why a produto joined the tax-review list (each changes how the NF-e resolves its taxes). */
export const motivoRevisaoFiscalLiSchema = z.enum([
  'produto-criado',
  'categoria-criada',
  'sem-categoria',
  'categoria-preenchida',
]);
export type MotivoRevisaoFiscalLi = z.infer<typeof motivoRevisaoFiscalLiSchema>;
/** Named members of {@link motivoRevisaoFiscalLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_REVISAO_FISCAL_LI = {
  produtoCriado: 'produto-criado',
  categoriaCriada: 'categoria-criada',
  semCategoria: 'sem-categoria',
  categoriaPreenchida: 'categoria-preenchida',
} as const satisfies Record<string, MotivoRevisaoFiscalLi>;

/**
 * `revisao/{produtoId}` — one produto whose taxes need a look. Carried forward from every earlier
 * `aplicar` job back to the newest one that ended `concluido`, skipping Simular jobs (decided
 * 2026-11-06), and re-checked on EVIDENCE at the end of every `aplicar` job: it leaves the list only
 * when the produto has its own tax setting, its category has one, a tax rule names it or its
 * category, or the produto no longer exists (decided 2026-11-06). Nothing else closes it.
 */
export const revisaoFiscalLiSchema = z.object({
  produtoId: z.string().min(1),
  motivos: z.array(motivoRevisaoFiscalLiSchema).default(() => []),
  liId: idLiSchema.nullable().default(null),
  /** The job that first listed it. */
  desdeJobId: z.string().nullable().default(null),
  desdeMs: millisSinceEpoch().nullable().default(null),
});
export type RevisaoFiscalLi = z.infer<typeof revisaoFiscalLiSchema>;

/* -------------------------------------------------------------------------- */
/*                                The job document                             */
/* -------------------------------------------------------------------------- */

/** Which catalogue list the `catalogo` phase is paging. */
export const recursoCatalogoImportacaoLiSchema = z.enum(['categorias', 'marcas']);
export type RecursoCatalogoImportacaoLi = z.infer<typeof recursoCatalogoImportacaoLiSchema>;
/** Named members of {@link recursoCatalogoImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const RECURSO_CATALOGO_IMPORTACAO_LI = {
  categorias: 'categorias',
  marcas: 'marcas',
} as const satisfies Record<string, RecursoCatalogoImportacaoLi>;

/**
 * How a store category stands for this conta: `vinculada` (one link serves it), `sem-vinculo`,
 * `ambigua` (two links serve it: never picked), `simulada` (Simular only: the category a
 * "create and link" run would create — so a later product of the same run sees it, as it would).
 */
export const vinculoCategoriaImportacaoLiSchema = z.enum([
  'vinculada',
  'sem-vinculo',
  'ambigua',
  'simulada',
]);
export type VinculoCategoriaImportacaoLi = z.infer<typeof vinculoCategoriaImportacaoLiSchema>;
/** Named members of {@link vinculoCategoriaImportacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const VINCULO_CATEGORIA_IMPORTACAO_LI = {
  vinculada: 'vinculada',
  semVinculo: 'sem-vinculo',
  ambigua: 'ambigua',
  simulada: 'simulada',
} as const satisfies Record<string, VinculoCategoriaImportacaoLi>;

/** One store category as the job knows it: the store's row plus its ERP side for this conta. */
export const categoriaDoJobLiSchema = categoriaCatalogoLiSchema.extend({
  erpCategoriaId: z.string().min(1).nullable().default(null),
  vinculo: vinculoCategoriaImportacaoLiSchema.default(VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo),
});
export type CategoriaDoJobLi = z.infer<typeof categoriaDoJobLiSchema>;

/** The `catalogo` phase's cursor. `proximoOffset: null` ⇒ that list is exhausted. */
export const cursorCatalogoLiSchema = z.object({
  recurso: recursoCatalogoImportacaoLiSchema.default(RECURSO_CATALOGO_IMPORTACAO_LI.categorias),
  proximoOffset: z.number().int().nonnegative().nullable().default(0),
  paginas: z.number().int().nonnegative().default(0),
});

/**
 * A product list's cursor (the listing, and the trash list): the next offset the store's `next`
 * gave (`null` ⇒ exhausted), the pages and DISTINCT rows read, `meta.limit` read back, the first
 * page's `meta.total_count`, and `divergente` when the distinct rows read differ from that total
 * (offset paging under concurrent edits can repeat or skip a row; the card says so).
 */
export const cursorListaProdutosLiSchema = z.object({
  proximoOffset: z.number().int().nonnegative().nullable().default(0),
  paginas: z.number().int().nonnegative().default(0),
  linhas: z.number().int().nonnegative().default(0),
  limiteLido: z.number().int().nullable().default(null),
  totalLi: z.number().int().nullable().default(null),
  divergente: z.boolean().default(false),
});

/**
 * The `revisao` phase's sub-steps:
 *  - `inicio`: nothing done yet;
 *  - `apos`: every job down to `fonteJobId` (newest first) is handled: find the next source;
 *  - `copiando`: copying source `fonteJobId` after `depoisProdutoId` (`null`: from its start);
 *    `ultimaFonte` marks the walk's last source (it ended `concluido`);
 *  - `conferindo`: re-checking this job's list after `depoisProdutoId` (`null`: from its start),
 *    with `abertos` entries kept so far.
 */
export const etapaRevisaoFiscalLiSchema = z.enum(['inicio', 'apos', 'copiando', 'conferindo']);
export type EtapaRevisaoFiscalLi = z.infer<typeof etapaRevisaoFiscalLiSchema>;
/** Named members of {@link etapaRevisaoFiscalLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ETAPA_REVISAO_FISCAL_LI = {
  inicio: 'inicio',
  apos: 'apos',
  copiando: 'copiando',
  conferindo: 'conferindo',
} as const satisfies Record<string, EtapaRevisaoFiscalLi>;

/** The `revisao` phase's cursor, and the newest earlier `aplicar` job its list was carried from. */
export const cursorRevisaoFiscalLiSchema = z.object({
  etapa: etapaRevisaoFiscalLiSchema.default(ETAPA_REVISAO_FISCAL_LI.inicio),
  fonteJobId: z.string().min(1).nullable().default(null),
  ultimaFonte: z.boolean().default(false),
  depoisProdutoId: z.string().min(1).nullable().default(null),
  abertos: z.number().int().nonnegative().default(0),
  anteriorJobId: z.string().nullable().default(null),
});
export type CursorRevisaoFiscalLi = z.infer<typeof cursorRevisaoFiscalLiSchema>;

/** The run's counters (report totals; the items are the detail). */
export const contadoresImportacaoLiSchema = z.object({
  familias: z.number().int().nonnegative().default(0),
  vinculados: z.number().int().nonnegative().default(0),
  criados: z.number().int().nonnegative().default(0),
  completados: z.number().int().nonnegative().default(0),
  semMudanca: z.number().int().nonnegative().default(0),
  pendenciasAcionaveis: z.number().int().nonnegative().default(0),
  pendenciasInformativas: z.number().int().nonnegative().default(0),
  fotos: z.number().int().nonnegative().default(0),
  falhas: z.number().int().nonnegative().default(0),
});
export type ContadoresImportacaoLi = z.infer<typeof contadoresImportacaoLiSchema>;

/** One option link a Simular would have learned (the overlay its later families resolve against). */
export const aprendizadoSimuladoLiSchema = z.object({
  grupoId: z.string().min(1),
  gradeId: idLiSchema,
  opcaoId: idLiSchema,
  varianteId: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/*                       One family's complete step, in units                  */
/* -------------------------------------------------------------------------- */

/** Why a picture was refused: every CDN outcome but `ok`. */
export const motivoFotoRecusadaLiSchema = z.enum([
  'caminho-invalido',
  'redirecionamento',
  'nao-encontrada',
  'http',
  'muito-grande',
  'nao-e-imagem',
]);
export type MotivoFotoRecusadaLi = z.infer<typeof motivoFotoRecusadaLiSchema>;
/** Named members of {@link motivoFotoRecusadaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_FOTO_RECUSADA_LI = {
  caminhoInvalido: 'caminho-invalido',
  redirecionamento: 'redirecionamento',
  naoEncontrada: 'nao-encontrada',
  http: 'http',
  muitoGrande: 'muito-grande',
  naoEImagem: 'nao-e-imagem',
} as const satisfies Record<string, MotivoFotoRecusadaLi>;

/** How a produto's pictures ended. */
export const desfechoFotosDoProdutoLiSchema = z.enum([
  /** Written (Simular: would be): `fotos` counts them. */
  'importadas',
  /** It had a photo when its pictures started: nothing fetched. */
  'com-fotos',
  /** Another writer's photo arrived before our write: theirs stay, ours are written nowhere. */
  'perdeu',
  /** The produto is gone. */
  'ausente',
  /** Every write lost, and it still has no photo: `conflito-de-escrita`. */
  'conflito',
  /** Every picture was refused: nothing to write. */
  'nenhuma-aceita',
]);
export type DesfechoFotosDoProdutoLi = z.infer<typeof desfechoFotosDoProdutoLiSchema>;
/** Named members of {@link desfechoFotosDoProdutoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const DESFECHO_FOTOS_DO_PRODUTO_LI = {
  importadas: 'importadas',
  comFotos: 'com-fotos',
  perdeu: 'perdeu',
  ausente: 'ausente',
  conflito: 'conflito',
  nenhumaAceita: 'nenhuma-aceita',
} as const satisfies Record<string, DesfechoFotosDoProdutoLi>;

/** A sha-512 digest, in lowercase hex. */
const HASH_SHA512_HEX = /^[0-9a-f]{128}$/;

/**
 * The resumable state of one family's pictures: what the dispatch checkpoints after every unit and
 * hands back to the next.
 */
export const cursorFotosLiSchema = z.object({
  /** The produto whose pictures are under way; `null` once every target is done. */
  produtoId: z.string().min(1).nullable(),
  /** The index, in that produto's pictures, of the next one to fetch. */
  proxima: z.number().int().nonnegative(),
  /** That picture's ORIGINAL came back too large: the next unit fetches its `800x800`. */
  reduzida: z.boolean(),
  /** That produto's pictures already stored, in plan order. */
  enviadas: z.array(z.object({ imagemId: idLiSchema, hash: z.string().regex(HASH_SHA512_HEX) })),
  /** The produtos of the family done so far, in order. */
  feitos: z.array(
    z.object({
      produtoId: z.string().min(1),
      liId: idLiSchema.nullable(),
      desfecho: desfechoFotosDoProdutoLiSchema,
      fotos: z.number().int().nonnegative(),
    }),
  ),
  /** Every picture of the family refused so far. */
  recusadas: z.array(
    z.object({
      liId: idLiSchema.nullable(),
      imagemId: idLiSchema,
      motivo: motivoFotoRecusadaLiSchema,
    }),
  ),
});
export type CursorFotosLi = z.infer<typeof cursorFotosLiSchema>;

/** Which path the preparation took, for a family whose photos are under way. */
export const caminhoDoCompletarLiSchema = z.enum(['existente', 'criada']);
export type CaminhoDoCompletarLi = z.infer<typeof caminhoDoCompletarLiSchema>;
/** Named members of {@link caminhoDoCompletarLiSchema} — see `delfrance/prefer-schema-enum`. */
export const CAMINHO_DO_COMPLETAR_LI = {
  /** A family the ERP has: filled, links still to write. */
  existente: 'existente',
  /** A family this job created (links in the batch). */
  criada: 'criada',
} as const satisfies Record<string, CaminhoDoCompletarLi>;

const pendenciaDoProgressoSchema = z.object({
  codigo: pendenciaImportacaoLiSchema,
  liId: idLiSchema.nullable(),
  referencias: z.array(z.string()),
});

const resultadoFotosDoProgressoSchema = z.object({
  produtos: cursorFotosLiSchema.shape.feitos,
  gravadas: z.number().int().nonnegative(),
  pendencias: z.array(pendenciaDoProgressoSchema),
});

/**
 * One family's complete step between its units: what the preparation decided, the photo targets,
 * the photo cursor and, once every picture is decided, the photos' result. `fotos` goes back to
 * `null` the moment `resultadoFotos` is set, and the schema refuses a progress holding both: nothing
 * reads the cursor after that, and keeping it would add about 150 KB to the worst case.
 *
 * Worst case (a root and 50 variations, the store's cap, each with 50 pictures, every picture
 * refused): about 185 KB while the pictures run, about 230 KB once the result replaces the cursor.
 * Beside a job at its other ceilings (500 categories and 500 brands with 255-character accented
 * names, 1,000 selected ids) the document stays near 855 KB; with 30-character names, near 405 KB.
 * Kept beside the result, the cursor would take that document to about 1 MB, some 45 KB from
 * Firestore's limit. Pinned in `importacaoLojaIntegrada.test.ts`.
 *
 * ⚠️ These figures hold at the store's cap, and nothing in this repo enforces that cap: `filhos` is
 * read with no ceiling. Each variation past it adds about 4.4 KB, so with every other ceiling hit
 * the document passes 1 MiB near 94 variations, and Firestore would then refuse its checkpoint.
 */
export const progressoDaFamiliaLiSchema = z
  .object({
    /** The family's root store id: a progress of any other family is none. */
    raizLiId: idLiSchema,
    caminho: caminhoDoCompletarLiSchema,
    /** The ERP root: matched, or created by this job. */
    erpRaizId: z.string().min(1),
    /** The variations' category (the parent's stored one, else the one resolved for it). */
    categoria: z.object({
      erpId: z.string().min(1).nullable(),
      criadaPelaImportacao: z.boolean(),
    }),
    /** The plan's create was carried out (or met again, landed, by a retried unit). */
    criacaoAplicada: z.boolean(),
    completado: z.boolean(),
    campos: z.array(z.string()),
    pendencias: z.array(pendenciaDoProgressoSchema),
    /** Store categories this family created, carried to the item at its closing. */
    categoriasCriadas: z.array(idLiSchema),
    criados: z.number().int().nonnegative(),
    completados: z.number().int().nonnegative(),
    vinculados: z.number().int().nonnegative(),
    /** ERP produtos the preparation found gone: no link is written for them. */
    sumidos: z.array(z.string().min(1)),
    /** The produtos whose pictures may be copied, in order; their pictures are the details'. */
    alvos: z.array(z.object({ produtoId: z.string().min(1), liId: idLiSchema.nullable() })),
    /** The photo cursor; `null` before the first picture and again once the result is set. */
    fotos: cursorFotosLiSchema.nullable(),
    /** Every picture decided: the photos' result, for the closing; `null` while under way. */
    resultadoFotos: resultadoFotosDoProgressoSchema.nullable(),
  })
  .superRefine((progresso, ctx) => {
    if (progresso.fotos !== null && progresso.resultadoFotos !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['fotos'],
        message: 'the photo cursor must be null once resultadoFotos is set',
      });
    }
  });
export type ProgressoDaFamiliaLi = z.infer<typeof progressoDaFamiliaLiSchema>;

export const importacaoLojaIntegradaSchema = z.object({
  /** The Loja Integrada conta (integração doc id) this job reads. */
  integracaoId: z.string().min(1),
  /** The uid of the operator who started it. */
  iniciadoPor: z.string().nullable().default(null),
  /** ⚠️ MILLISECONDS — see the header. */
  iniciadoEmMs: millisSinceEpoch(),
  /** Every checkpoint bumps it: the card's "no progress for 45 min" reads it. */
  atualizadoEmMs: millisSinceEpoch().nullable().default(null),
  concluidoEmMs: millisSinceEpoch().nullable().default(null),

  modo: modoImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.modo),
  alvo: alvoImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.alvo),
  acao: acaoImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.acao),
  categorias: categoriasImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.categorias),
  fotos: fotosImportacaoLiSchema.default(OPCOES_IMPORTACAO_LI_PADRAO.fotos),
  /** Store PARENT or simple product ids (`alvo: selecionados`). The ceiling is the start body's. */
  selecionados: z.array(idLiSchema).default(() => []),
  /** The finished Simular the selection came from (informational). */
  simulacaoId: z.string().nullable().default(null),

  status: statusImportacaoLiSchema,
  fase: faseImportacaoLiSchema.default(FASE_IMPORTACAO_LI.catalogo),
  /** Set only on `status: 'falhou'`. */
  motivo: motivoFalhaImportacaoLiSchema.nullable().default(null),
  /**
   * The dispatch sequence. Bumped ONLY by a dispatch's LAST checkpoint (never per unit): a task
   * whose `seq` equals it runs; one equal to it − 1 while `executando` only re-enqueues the named
   * successor; any other does nothing.
   */
  seq: z.number().int().nonnegative().default(0),

  catalogo: cursorCatalogoLiSchema.default(() => cursorCatalogoLiSchema.parse({})),
  listagem: cursorListaProdutosLiSchema.default(() => cursorListaProdutosLiSchema.parse({})),
  lixeira: cursorListaProdutosLiSchema.default(() => cursorListaProdutosLiSchema.parse({})),
  /** The `orfaos` phase's cursor: the last unexplained variation detail-read (ascending id). */
  orfaos: z
    .object({ cursorLiId: idLiSchema.nullable().default(null) })
    .default(() => ({ cursorLiId: null })),
  /**
   * The family cursor of the `evidencias` and `familias` phases (reset between them): the last
   * family finished (ascending store parent or simple product id), and the variations of the
   * current family already detail-read.
   */
  familias: z
    .object({
      cursorPaiId: idLiSchema.nullable().default(null),
      filhosLidos: z.array(idLiSchema).default(() => []),
    })
    .default(() => ({ cursorPaiId: null, filhosLidos: [] })),
  /**
   * The `aprendizado` phase's cursor: the last evidence document decided (key order), and the claim
   * document ids (`<gradeId>_<opcaoId>`) whose learning lost its grupo write TWICE — reported
   * `conflito-de-escrita` by the families that carry the option, never forced.
   */
  aprendizado: z
    .object({
      cursorEvidenciaId: z.string().nullable().default(null),
      conflitos: z.array(z.string().min(1)).default(() => []),
    })
    .default(() => ({ cursorEvidenciaId: null, conflitos: [] })),
  /**
   * The family whose complete step spans units: `null` between families and in every other phase.
   * A stored value that does not parse reads as `null`, and the family is prepared again: safe,
   * since every write of a preparation is fill-empty, create-only or tier 0. A writer must validate
   * it through `progressoDaFamiliaLiSchema.parse` BEFORE writing, so this tolerance never hides a
   * bug.
   */
  progressoDaFamilia: progressoDaFamiliaLiSchema.nullable().catch(null).default(null),
  revisao: cursorRevisaoFiscalLiSchema.default(() => cursorRevisaoFiscalLiSchema.parse({})),

  /** The store's categories and their ERP side (at most the catalogue ceiling, 500). */
  mapaCategorias: z.array(categoriaDoJobLiSchema).default(() => []),
  /** The store's brands (at most the catalogue ceiling, 500). */
  marcas: z.array(marcaCatalogoLiSchema).default(() => []),
  /** Simular only: the option links the `aprendizado` phase would have written. */
  aprendizadosSimulados: z.array(aprendizadoSimuladoLiSchema).default(() => []),

  contadores: contadoresImportacaoLiSchema.default(() => contadoresImportacaoLiSchema.parse({})),
  pausas429: z.number().int().nonnegative().default(0),
  /** The default bucket was missing: photos were skipped for the run (shown on the card). */
  fotosIndisponiveis: z.boolean().default(false),
});
export type ImportacaoLojaIntegrada = z.infer<typeof importacaoLojaIntegradaSchema>;

export const importacaoLojaIntegradaMeta: CollectionMetadata = {
  collectionPath: 'importacoesLojaIntegrada',
  // No client domain grants these bits — placeholder values. Deliberately NOT registered in
  // `ALL_DOMAINS`, so the rules generator emits no match block and Firestore default-denies
  // every client read/write. Mirrors `importacaoShopeeMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: two BARE constants (`…Schema` + `…Meta`), never a single `{ schema, meta }` object, and
// NOT in `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` flags only an export carrying both.
//
// ⚠️ The collection name deliberately does not start with `notificacoes`: the notification
// guardrails fire on every admin collection path with that prefix and would demand a pipeline
// consumer and a `(status, processedAt)` index this job doc has neither of.

/* -------------------------------------------------------------------------- */
/*                                  The task                                   */
/* -------------------------------------------------------------------------- */

/**
 * The reads-queue task `tipo` of an import dispatch. Deliberately NOT a member of
 * `tipoTarefaLiSchema` (`notificacaoLojaIntegrada.ts`): that enum is also the PERSISTED
 * notification's field, and an import task is never a notification — it is never persisted,
 * re-driven by the sweep or parked. The functions codebase routes on the raw `tipo` first.
 */
export const TIPO_TAREFA_IMPORTACAO_LI = 'importacao' as const;

/**
 * The payload of one import dispatch: the conta, the job and the dispatch `seq` it was enqueued
 * for. IDS ONLY, and unknown keys are STRIPPED.
 */
export const tarefaImportacaoLiSchema = z.object({
  tipo: z.literal(TIPO_TAREFA_IMPORTACAO_LI),
  contaId: contaIdLiSchema,
  jobId: idImportacaoLiSchema,
  seq: z.number().int().nonnegative(),
});
export type TarefaImportacaoLi = z.infer<typeof tarefaImportacaoLiSchema>;

/**
 * The NAMED task id of dispatch `seq` of job `jobId`: `li-importacao-<jobId>-<seq>`. Cloud Tasks
 * refuses a second task of one name, so a trigger redelivery, a retried continuation and the
 * continuation check all enqueue the SAME task and only one runs. Letters, digits, `-` and `_`
 * only (the task-id grammar), far under its 500-character ceiling.
 *
 * Throws `RangeError` on an id outside {@link ID_IMPORTACAO_LI_REGEX} or a `seq` that is not a
 * non-negative safe integer: both come from a parsed payload, so a throw here is a bug.
 */
export function idTarefaImportacaoLi(jobId: string, seq: number): string {
  if (!ID_IMPORTACAO_LI_REGEX.test(jobId) || !Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError('idTarefaImportacaoLi: jobId ou seq inválido');
  }
  return `li-importacao-${jobId}-${String(seq)}`;
}

/* -------------------------------------------------------------------------- */
/*                               The route answers                             */
/* -------------------------------------------------------------------------- */

/*
 * NON-strict, like every answer of `apps/loja-integrada`: a later step may add a field, and a
 * browser built against this version must keep parsing it (unknown keys are stripped). `fase`,
 * `motivo`, a pendência's `codigo` and a tax-review entry's `motivos` are plain strings in the
 * answers for the same reason — a code a newer backend adds must still parse in an older browser.
 * No answer carries `seq`: the continuation is the backend's own.
 */

/** `POST …/conta/[id]/importacoes` → 202. */
export const respostaInicioImportacaoLiSchema = z.object({
  jobId: z.string().min(1),
});
export type RespostaInicioImportacaoLi = z.infer<typeof respostaInicioImportacaoLiSchema>;

/** `GET …/conta/[id]/importacoes/[jobId]`: one job, projected. */
export const respostaImportacaoLiSchema = z.object({
  jobId: z.string().min(1),
  integracaoId: z.string().min(1),
  status: statusImportacaoLiSchema,
  fase: z.string(),
  motivo: z.string().nullable(),
  modo: modoImportacaoLiSchema,
  alvo: alvoImportacaoLiSchema,
  acao: acaoImportacaoLiSchema,
  categorias: categoriasImportacaoLiSchema,
  fotos: fotosImportacaoLiSchema,
  selecionados: z.number().int().nonnegative(),
  simulacaoId: z.string().nullable(),
  iniciadoEmMs: z.number().int(),
  atualizadoEmMs: z.number().int().nullable(),
  concluidoEmMs: z.number().int().nullable(),
  contadores: contadoresImportacaoLiSchema,
  listagem: z.object({
    paginas: z.number().int().nonnegative(),
    linhas: z.number().int().nonnegative(),
    totalLi: z.number().int().nullable(),
    divergente: z.boolean(),
  }),
  pausas429: z.number().int().nonnegative(),
  fotosIndisponiveis: z.boolean(),
});
export type RespostaImportacaoLi = z.infer<typeof respostaImportacaoLiSchema>;

/** `GET …/conta/[id]/importacoes`: the conta's last {@link LIMITE_IMPORTACOES_LISTADAS_LI} jobs. */
export const respostaImportacoesLiSchema = z.object({
  importacoes: z.array(respostaImportacaoLiSchema),
});
export type RespostaImportacoesLi = z.infer<typeof respostaImportacoesLiSchema>;

/** One report item as answered: a pendência's `codigo` is a plain string (see above). */
export const itemRespostaImportacaoLiSchema = itemImportacaoLiSchema.extend({
  tipo: z.string(),
  situacaoErp: z.string(),
  acao: z.string(),
  pendencias: z.array(
    pendenciaItemLiSchema.extend({
      codigo: z.string(),
    }),
  ),
});
export type ItemRespostaImportacaoLi = z.infer<typeof itemRespostaImportacaoLiSchema>;

/**
 * `GET …/conta/[id]/importacoes/[jobId]/itens?depois=<doc id>`: one page of the report, at most
 * {@link LIMITE_ITENS_IMPORTACAO_LI} items in document-key order; `proximo` is the `depois` of the
 * next page, `null` on the last.
 */
export const respostaItensImportacaoLiSchema = z.object({
  itens: z.array(itemRespostaImportacaoLiSchema),
  proximo: z.string().nullable(),
});
export type RespostaItensImportacaoLi = z.infer<typeof respostaItensImportacaoLiSchema>;

/**
 * One tax-review entry as answered: its `motivos` are plain strings (see above), so a motivo a
 * newer backend adds still parses in an older browser, which shows it generically.
 */
export const entradaRespostaRevisaoFiscalLiSchema = revisaoFiscalLiSchema.extend({
  motivos: z.array(z.string()).default(() => []),
});
export type EntradaRespostaRevisaoFiscalLi = z.infer<typeof entradaRespostaRevisaoFiscalLiSchema>;

/**
 * `GET …/conta/[id]/importacoes/[jobId]/revisao`: the job's tax-review list (`revisao/*`, the list
 * the `lojaIntegradaRevisaoFiscal` aviso names by its job) in the produto ids' code-unit order.
 *
 * `proximo` is the `?depois=` of the next page and `null` on the last, as in the items answer —
 * and this backend always answers `null`: it reads the list WHOLE on every request (unfiltered, so
 * no index) and answers it in one. A page cut in memory would re-read the whole list for every
 * page, the square of the list (root rule 1); a key range would need a `revisao (__name__ ASC)`
 * index, which `firestore.indexes.json` does not declare. The field is there so a later backend that pages for real does not cut the
 * list short in a browser built against this one: a browser follows `proximo` until it is `null`.
 */
export const respostaRevisaoFiscalLiSchema = z.object({
  entradas: z.array(entradaRespostaRevisaoFiscalLiSchema),
  proximo: z.string().nullable(),
});
export type RespostaRevisaoFiscalLi = z.infer<typeof respostaRevisaoFiscalLiSchema>;
