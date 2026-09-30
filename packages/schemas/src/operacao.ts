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
 * finNFeOperacaoEnum — int-coded finality of NF-e (1..6). 5 (nota de crédito)
 * and 6 (nota de débito) are NT 2025.002 (Reforma Tributária); each needs its
 * `tpNFCredito` / `tpNFDebito` below, and both are IBS/CBS adjustments — see
 * `regrasDoDocumento.ts` for what SEFAZ requires of them.
 */
export const finNFeOperacaoSchema = z.union([
  z.literal(1), // normal
  z.literal(2), // complementar
  z.literal(3), // ajuste
  z.literal(4), // devolucao
  z.literal(5), // nota de crédito (NT 2025.002)
  z.literal(6), // nota de débito (NT 2025.002)
]);
export type FinNFeOperacao = z.infer<typeof finNFeOperacaoSchema>;

/** Named members of {@link finNFeOperacaoSchema}. */
export const FIN_NFE_OPERACAO = {
  normal: 1,
  complementar: 2,
  ajuste: 3,
  devolucao: 4,
  credito: 5,
  debito: 6,
} as const satisfies Record<string, FinNFeOperacao>;

export const FIN_NFE_OPERACAO_LABELS: Record<FinNFeOperacao, string> = {
  1: 'Normal',
  2: 'Complementar',
  3: 'Ajuste',
  4: 'Devolução',
  5: 'Nota de crédito',
  6: 'Nota de débito',
};

/** `ide/tpNFDebito` (B25.1) — the kind of nota de débito (finNFe 6), NT 2025.002. */
export const tpNFDebitoSchema = z.enum(['01', '02', '03', '04', '05', '06', '07', '08']);
export type TpNFDebito = z.infer<typeof tpNFDebitoSchema>;

/** Named members of {@link tpNFDebitoSchema}. */
export const TP_NF_DEBITO = {
  transferenciaCreditoCooperativa: '01',
  anulacaoCreditoSaidaImuneIsenta: '02',
  debitoNotaNaoProcessada: '03',
  multaJuros: '04',
  transferenciaCreditoSucessao: '05',
  pagamentoAntecipado: '06',
  perdaEstoque: '07',
  desenquadramentoSimples: '08',
} as const satisfies Record<string, TpNFDebito>;

export const TP_NF_DEBITO_LABELS: Record<TpNFDebito, string> = {
  '01': 'Transferência de créditos para cooperativas',
  '02': 'Anulação de crédito por saídas imunes/isentas',
  '03': 'Débitos de notas fiscais não processadas na apuração',
  '04': 'Multa e juros',
  '05': 'Transferência de crédito na sucessão',
  '06': 'Pagamento antecipado',
  '07': 'Perda em estoque',
  '08': 'Desenquadramento do Simples Nacional',
};

/**
 * `ide/tpNFCredito` (B25.2) — the kind of nota de crédito (finNFe 5), NT 2025.002.
 * `'06'` (retorno por recusa parcial na entrega) arrived with the PL_010f pack.
 */
export const tpNFCreditoSchema = z.enum(['01', '02', '03', '04', '05', '06']);
export type TpNFCredito = z.infer<typeof tpNFCreditoSchema>;

/** Named members of {@link tpNFCreditoSchema}. */
export const TP_NF_CREDITO = {
  multaJuros: '01',
  creditoPresumidoZfm: '02',
  retornoRecusaTotal: '03',
  reducaoValores: '04',
  transferenciaCreditoSucessao: '05',
  retornoRecusaParcial: '06',
} as const satisfies Record<string, TpNFCredito>;

export const TP_NF_CREDITO_LABELS: Record<TpNFCredito, string> = {
  '01': 'Multa e juros',
  '02': 'Apropriação de crédito presumido de IBS sobre o saldo devedor na ZFM',
  '03': 'Retorno por recusa total na entrega ou destinatário não localizado',
  '04': 'Redução de valores',
  '05': 'Transferência de crédito na sucessão',
  '06': 'Retorno por recusa parcial na entrega',
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
  // NT 2025.002 — exactly one of them, and only with finNFe 6 / 5 respectively
  // (rules B25.1 / B25.2). New fields: absent on every migrated operação.
  tpNFDebito: tpNFDebitoSchema.nullable().default(null),
  tpNFCredito: tpNFCreditoSchema.nullable().default(null),
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
  // `.default(null)`, never a bare `.optional()`: the TableView update-
  // monitor runs a CLASSIC `orderBy(ultimaModificacao, 'desc').limit(1)`,
  // which EXCLUDES documents missing the key — so a dropped key hides the
  // row from the staleness check, silently. Pinned by
  // `defaultQuery.sortKeyPresence.test.ts`.
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().default(null),
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
