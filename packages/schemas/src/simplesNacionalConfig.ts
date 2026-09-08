import { z } from 'zod';

import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

// Mirror `PERM.fiscal` (byte 9, bits 72-74) from @delfrance/auth.
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

/** Anexo do Simples aplicável à receita de mercadoria da filial. */
export const anexoSimplesSchema = z.enum(['I', 'II']);
export type AnexoSimplesWire = z.infer<typeof anexoSimplesSchema>;

/**
 * Named members of {@link anexoSimplesSchema}. Required by the
 * `delfrance/prefer-schema-enum` rule, and `'I'`/`'II'` on their own read as
 * roman numerals with no hint of which is which.
 */
export const ANEXO_SIMPLES = {
  comercio: 'I',
  industria: 'II',
} as const satisfies Record<string, AnexoSimplesWire>;

export const ANEXO_SIMPLES_LABELS: Record<AnexoSimplesWire, string> = {
  I: 'Anexo I — Comércio',
  II: 'Anexo II — Indústria',
};

/** Por que uma apuração não virou alíquota vigente. */
export const APURACAO_ESTADO = {
  /** Publicada: é a alíquota que a emissão vai carimbar. */
  vigente: 'vigente',
  /** Havia notas ilegíveis na janela — a RBT12 está incompleta. */
  incompleta: 'incompleta',
  /** Calculada, mas o recálculo automático está desligado. */
  aguardandoAutorizacao: 'aguardandoAutorizacao',
  /** RBT12 fora do regime (zero, negativa ou acima do teto). */
  foraDoRegime: 'foraDoRegime',
} as const;

export const apuracaoEstadoSchema = z.enum([
  APURACAO_ESTADO.vigente,
  APURACAO_ESTADO.incompleta,
  APURACAO_ESTADO.aguardandoAutorizacao,
  APURACAO_ESTADO.foraDoRegime,
]);
export type ApuracaoEstado = z.infer<typeof apuracaoEstadoSchema>;

/** `YYYY-MM`. */
const competenciaSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'competência deve ser YYYY-MM');

/**
 * Configuração do Simples Nacional por filial —
 * `filiais/{filialId}/simplesnacional/default`.
 *
 * ## Por que não é um campo do `nfeConfig`
 *
 * `nfeConfig` é um documento CONTADOR: `numeracao_atual` e `idLote` avançam
 * numa transação a cada emissão. Regime tributário é configuração de mudança
 * lenta, e colocá-la naquele documento a poria no caminho de contenção de toda
 * NF-e emitida, sem nenhum ganho.
 *
 * ## Dois grupos de campos, dois escritores
 *
 * Os campos HUMANOS (`anexo`, `aliquotaDeclarada`, `recalculoAutomatico`) são
 * editados na aba da filial. Os campos CALCULADOS têm um escritor só — o runner
 * mensal — e ninguém mais os escreve.
 *
 * ⚠️ **A RBT12 consolida por CNPJ, não por filial.** A Receita apura o Simples
 * pela empresa inteira (matriz + filiais, um DAS só, recolhido pela matriz).
 * O documento é por filial porque é onde se edita, mas o runner agrupa a
 * receita pela RAIZ do CNPJ e grava o MESMO número em todas as filiais
 * irmãs — por isso os campos calculados têm um escritor único, e por isso
 * `filiaisConsolidadas` registra quais entraram na conta. Filiais irmãs não
 * podem divergir num número que só um processo escreve.
 */
export const simplesNacionalConfigSchema = z.object({
  // ── Humano ──────────────────────────────────────────────────────────────
  anexo: anexoSimplesSchema.default(ANEXO_SIMPLES.comercio).describe('Anexo'),
  /**
   * Alíquota efetiva informada pela contabilidade, como FRAÇÃO (0.06728 =
   * 6,728%). Serve de fallback quando não há 12 meses de histórico apurável, e
   * de conferência contra o valor calculado.
   */
  aliquotaDeclarada: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .default(null)
    .describe('Alíquota informada'),
  /**
   * Autoriza o runner a PUBLICAR o que calculou. Desligado, ele ainda apura e
   * registra tudo — só não promove a alíquota vigente. Ligar isto é uma decisão
   * do humano que responde pela apuração.
   */
  recalculoAutomatico: z.boolean().default(false).describe('Recalcular automaticamente'),

  // ── Calculado (escritor único: o runner mensal) ─────────────────────────
  /** Receita bruta dos 12 meses anteriores, consolidada por raiz de CNPJ. */
  rbt12: z.number().nullable().default(null),
  /** Alíquota efetiva vigente, como fração. `null` até a primeira apuração. */
  aliquotaEfetiva: z.number().nullable().default(null),
  /** Faixa 1..6 correspondente à `rbt12`. */
  faixa: z.number().int().min(1).max(6).nullable().default(null),
  /** Competência `YYYY-MM` a que a alíquota vigente se refere. */
  competencia: competenciaSchema.nullable().default(null),
  /** Estado da última apuração — ver {@link APURACAO_ESTADO}. */
  estadoApuracao: apuracaoEstadoSchema.nullable().default(null),
  calculadoEm: millisSinceEpoch().nullable().default(null),
  /**
   * Notas aprovadas da janela que NÃO entraram nesta RBT12 e deveriam ter
   * entrado — por qualquer motivo.
   *
   * ⚠️ **É o guarda de segurança do recurso inteiro.** O `sum()` do Firestore
   * ignora documento sem o campo, EM SILÊNCIO — uma nota fora da conta faz a
   * receita parecer menor, a faixa cair e o imposto sair subdeclarado com todo
   * job reportando sucesso. Enquanto isto for > 0 a apuração é `incompleta` e
   * não vira alíquota vigente.
   *
   * ⚠️ O nome diz "ilegíveis" por causa do primeiro caso, mas o contador é mais
   * largo do que isso, e essa largura foi comprada caro (revisão do #1546): um
   * guarda que só olhava o `totais` ausente **entre as linhas que o filtro já
   * tinha devolvido** não via nada que o próprio filtro derrubasse. Hoje soma
   * quatro coisas: nota sem `totais.receitaBruta`; nota de filial não
   * configurada (a RBT12 é da EMPRESA — matriz mais filiais, um DAS só);
   * nota que o agregado não soube atribuir (sem `filialId`, que o `nfeSchema`
   * admite por tolerância a documento legado); e a diferença contra um agregado
   * de CONTROLE, que pega o documento que o índice composto pode nem conter.
   * Notas neutras (ajuste, devolução de compra) ficam de fora dos três últimos:
   * não são receita de ninguém, e contá-las seria um bloqueio que nada resolve.
   */
  notasIlegiveis: z.number().int().min(0).nullable().default(null),
  /**
   * Notas deliberadamente contadas como zero (ajuste, devolução de compra).
   * Registradas para que a contabilidade veja o que foi ignorado em vez de
   * descobrir a diferença no PGDAS-D.
   */
  notasNeutras: z.number().int().min(0).nullable().default(null),
  /** Ids das filiais cuja receita entrou nesta RBT12 (mesma raiz de CNPJ). */
  filiaisConsolidadas: z.array(z.string().min(1)).default([]),

  ultimaModificacao: millisSinceEpoch().nullable().default(null),
});

export type SimplesNacionalConfig = z.infer<typeof simplesNacionalConfigSchema>;

export const SIMPLES_NACIONAL_CONFIG_DOC_ID = 'default';

export const simplesNacionalConfigMeta: CollectionMetadata = {
  collectionPath: 'filiais/{filialId}/simplesnacional',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
};

export const simplesNacionalConfig = {
  schema: simplesNacionalConfigSchema,
  meta: simplesNacionalConfigMeta,
};

/**
 * Uma apuração mensal — `filiais/{filialId}/simplesnacional/default/apuracoes/{YYYY-MM}`.
 *
 * Registro append-only, um por competência, com o id sendo a própria
 * competência. É o que torna a alíquota EXPLICÁVEL meses depois ("por que esta
 * nota levou 6,728%?") e o que permite ao backfill histórico reconstruir a
 * taxa mês a mês em vez de aplicar a de hoje ao passado inteiro.
 */
export const apuracaoSimplesSchema = z.object({
  competencia: competenciaSchema,
  rbt12: z.number(),
  receitaDoMes: z.number(),
  aliquotaEfetiva: z.number().nullable().default(null),
  faixa: z.number().int().min(1).max(6).nullable().default(null),
  anexo: anexoSimplesSchema,
  estado: apuracaoEstadoSchema,
  /** `true` quando a RBT12 veio da regra proporcional (empresa < 12 meses). */
  proporcional: z.boolean().default(false),
  notasContadas: z.number().int().min(0).default(0),
  notasIlegiveis: z.number().int().min(0).default(0),
  notasNeutras: z.number().int().min(0).default(0),
  filiaisConsolidadas: z.array(z.string().min(1)).default([]),
  calculadoEm: millisSinceEpoch().nullable().default(null),
});

export type ApuracaoSimples = z.infer<typeof apuracaoSimplesSchema>;

export const apuracaoSimplesMeta: CollectionMetadata = {
  collectionPath: 'filiais/{filialId}/simplesnacional/default/apuracoes',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
};

export const apuracaoSimples = {
  schema: apuracaoSimplesSchema,
  meta: apuracaoSimplesMeta,
};
