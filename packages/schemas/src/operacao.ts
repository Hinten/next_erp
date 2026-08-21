import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';
import { ufSchema } from './endereco';
import { taxConfigFields } from './imposto/tribute';

// Mirror `PERM.fiscal` (byte 9, bits 72-74) from @delfrance/auth.
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

/**
 * tipoNFe — int-coded (entrada=0, saida=1).
 */
export const tipoNFeSchema = z.union([z.literal(0), z.literal(1)]);
export type TipoNFe = z.infer<typeof tipoNFeSchema>;

export const TIPO_NFE = { entrada: 0, saida: 1 } as const satisfies Record<string, TipoNFe>;

export const TIPO_NFE_LABELS: Record<TipoNFe, string> = {
  0: 'Entrada',
  1: 'Saída',
};

/**
 * finNFeOperacaoEnum — int-coded finality of NF-e (1..4).
 */
export const finNFeOperacaoSchema = z.union([
  z.literal(1), // normal
  z.literal(2), // complementar
  z.literal(3), // ajuste
  z.literal(4), // devolucao
]);
export type FinNFeOperacao = z.infer<typeof finNFeOperacaoSchema>;

export const FIN_NFE_OPERACAO_LABELS: Record<FinNFeOperacao, string> = {
  1: 'Normal',
  2: 'Complementar',
  3: 'Ajuste',
  4: 'Devolução',
};

/**
 * indPresOperacaoEnum — string-coded buyer-presence indicator.
 */
export const indPresOperacaoSchema = z.enum(['0', '1', '2', '3', '4', '5', '9']);
export type IndPresOperacao = z.infer<typeof indPresOperacaoSchema>;

/**
 * Named members of {@link indPresOperacaoSchema}; names from
 * {@link IND_PRES_OPERACAO_LABELS}.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const IND_PRES_OPERACAO = {
  naoSeAplica: '0',
  presencial: '1',
  naoPresencialInternet: '2',
  naoPresencialTeleatendimento: '3',
  nfceConsumidorFinal: '4',
  presencialForaEstabelecimento: '5',
  naoPresencialOutros: '9',
} as const satisfies Record<string, IndPresOperacao>;

export const IND_PRES_OPERACAO_LABELS: Record<IndPresOperacao, string> = {
  '0': 'Não se aplica',
  '1': 'Operação presencial',
  '2': 'Operação não presencial pela internet',
  '3': 'Operação não presencial por teleatendimento',
  '4': 'NFC-e em operação com consumidor final',
  '5': 'Operação presencial fora do estabelecimento',
  '9': 'Operação não presencial — outros',
};

/**
 * indIntermedOperacaoEnum — string-coded intermediator indicator.
 */
export const indIntermedOperacaoSchema = z.enum(['0', '1']);
export type IndIntermedOperacao = z.infer<typeof indIntermedOperacaoSchema>;

/**
 * Named members of {@link indIntermedOperacaoSchema}; names from
 * {@link IND_INTERMED_OPERACAO_LABELS}.
 */
export const IND_INTERMED_OPERACAO = {
  semIntermediador: '0',
  plataformaTerceiros: '1',
} as const satisfies Record<string, IndIntermedOperacao>;

export const IND_INTERMED_OPERACAO_LABELS: Record<IndIntermedOperacao, string> = {
  '0': 'Operação sem intermediador',
  '1': 'Operação em site/plataforma de terceiros',
};

/**
 * origemProdutoImposto — string-coded ('0'..'8').
 */
export const origemProdutoImpostoSchema = z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
export type OrigemProdutoImposto = z.infer<typeof origemProdutoImpostoSchema>;

/**
 * Named members of {@link origemProdutoImpostoSchema} — the SEFAZ "origem da
 * mercadoria" table, same names as `ORIGEM` in `imposto/tribute.ts`.
 *
 * This enum and `Origem` are the same concept declared twice, with an identical
 * member set. `prefer-schema-enum` keeps them straight by name — `imposto.origem`
 * resolves to `ORIGEM`, this field to `ORIGEM_PRODUTO_IMPOSTO` — so both are
 * enforced. Collapsing the duplicate is still worth doing on its own merits.
 */
export const ORIGEM_PRODUTO_IMPOSTO = {
  nacional: '0',
  estrangeiraImportacaoDireta: '1',
  estrangeiraMercadoInterno: '2',
  nacionalConteudoImportacaoAte70: '3',
  nacionalProcessoProdutivoBasico: '4',
  nacionalConteudoImportacaoAte40: '5',
  estrangeiraImportacaoDiretaSemSimilar: '6',
  estrangeiraMercadoInternoSemSimilar: '7',
  nacionalConteudoImportacaoAcima70: '8',
} as const satisfies Record<string, OrigemProdutoImposto>;

/**
 * Operacao — operação fiscal (CFOPs, configurações tributárias). Mirrors
 * `Operacao` em `.old/packages/operacao_fiscal/lib/src/models.dart`.
 *
 * As configurações tributárias agora são **tipadas** (`taxConfigFields`,
 * compartilhadas com a engine NF-e via `@delfrance/schemas`): ICMS (Simples
 * Nacional + Regime Normal, lossless), IPI, PIS/COFINS, PIS-ST, ISSQN, retenção
 * e a Reforma Tributária (`configuracaoIBSCBS`, lenient). Servem de **default
 * tier** do resolver de imposto (item → produto → categoria → regra → operação).
 */
export const operacaoSchema = z.object({
  nome: z.string().min(1),
  naturezaDaOperacao: z.string().min(1).max(60),
  tipo: tipoNFeSchema,
  ehServico: z.boolean(),
  ehExterior: z.boolean(),
  ehConsumidorFinal: z.boolean(),
  padrao: z.boolean().default(false),
  ativo: z.boolean().default(true),
  movimentaEstoque: z.boolean().default(true),
  movimentaIndisponivelEstoque: z.boolean().default(true),
  ehFiscal: z.boolean().default(true),

  finNFe: finNFeOperacaoSchema.nullable().optional(),
  indPres: indPresOperacaoSchema.default(IND_PRES_OPERACAO.naoPresencialInternet),
  indIntermed: indIntermedOperacaoSchema.default(IND_INTERMED_OPERACAO.plataformaTerceiros),

  cfop: z.string().nullable(),
  cfopInterestadual: z.string().nullable(),
  origem: origemProdutoImpostoSchema.nullable().optional(),

  NCM: z.string().max(8).nullable(),
  CEST: z.string().max(7).nullable(),
  unidade: z.string().max(6).nullable(),

  estadosDestino: z.array(ufSchema).nullable().optional(),
  estados: z.array(ufSchema).nullable().optional(),

  // Sub-objetos fiscais — tipados (default tier do resolver de imposto).
  ...taxConfigFields,

  infCpl: z.string().max(5000).nullable(),

  // System stamps — create-only `timestamp` (nullish coalesce) and
  // `ultimaModificacao` on every write; both stamped by `saveRecord`.
  timestamp: millisSinceEpoch().nullable().optional(),
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
});

export type Operacao = z.infer<typeof operacaoSchema>;

export const operacaoMeta: CollectionMetadata = {
  collectionPath: 'operacao',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: [
      'nome',
      'tipo',
      'movimentaEstoque',
      'padrao',
      'cfop',
      'cfopInterestadual',
      'timestamp',
    ],
  },
};

export const operacao = { schema: operacaoSchema, meta: operacaoMeta };
