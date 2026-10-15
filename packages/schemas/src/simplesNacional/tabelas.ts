/**
 * Simples Nacional — tabelas de alíquotas da LC 123/2006 (redação da LC
 * 155/2016) e a fórmula da alíquota efetiva.
 *
 * ```
 * aliquotaEfetiva = [(RBT12 × aliquotaNominal) − parcelaDeduzir] / RBT12
 * ```
 *
 * `RBT12` é a receita bruta acumulada dos **12 meses anteriores** ao período de
 * apuração. A parcela a deduzir é o que suaviza o degrau entre faixas — por
 * isso a alíquota efetiva é sempre MENOR que a nominal, e é sobre ela que o
 * imposto do mês é calculado.
 *
 * ## Só Anexos I e II moram aqui, de propósito
 *
 * A receita que este repositório consegue medir vem da NF-e **modelo 55**, que
 * é documento de MERCADORIA. Isso alcança exatamente dois anexos:
 *
 * - **Anexo I** — comércio (revenda);
 * - **Anexo II** — indústria (fabricação, beneficiamento, transformação).
 *
 * Os Anexos III, IV e V são receita de SERVIÇO, cujo documento é a NFS-e — que
 * este ERP não emite nem armazena. Declará-los aqui seria publicar três tabelas
 * fiscais que nada alimenta e ninguém confere; uma empresa que passe a ter
 * receita de serviço precisa primeiro de uma FONTE para essa receita, e aí a
 * tabela é a parte fácil.
 *
 * ⚠️ Os valores são normativos, não configuráveis. Se a lei mudar, muda aqui —
 * e os testes de fronteira ao lado são o que impede uma faixa de escorregar sem
 * ninguém ver.
 */

/** Uma faixa: o teto de RBT12 que ela cobre, a alíquota nominal e a dedução. */
export interface FaixaSimples {
  /** Número da faixa, 1..6 — como a Receita a nomeia. */
  readonly faixa: 1 | 2 | 3 | 4 | 5 | 6;
  /** Teto INCLUSIVO de RBT12, em reais. */
  readonly ate: number;
  /** Alíquota nominal como FRAÇÃO (0.04 = 4,00%). */
  readonly nominal: number;
  /** Parcela a deduzir, em reais. */
  readonly deduzir: number;
}

/**
 * Teto anual do Simples Nacional para EPP. Acima disto há exclusão do regime —
 * um caso que este módulo sinaliza em vez de extrapolar a 6ª faixa.
 */
export const TETO_SIMPLES_NACIONAL = 4_800_000;

/** ANEXO I — Comércio. */
export const ANEXO_I = [
  { faixa: 1, ate: 180_000, nominal: 0.04, deduzir: 0 },
  { faixa: 2, ate: 360_000, nominal: 0.073, deduzir: 5_940 },
  { faixa: 3, ate: 720_000, nominal: 0.095, deduzir: 13_860 },
  { faixa: 4, ate: 1_800_000, nominal: 0.107, deduzir: 22_500 },
  { faixa: 5, ate: 3_600_000, nominal: 0.143, deduzir: 87_300 },
  { faixa: 6, ate: 4_800_000, nominal: 0.19, deduzir: 378_000 },
] as const satisfies readonly FaixaSimples[];

/** ANEXO II — Indústria. */
export const ANEXO_II = [
  { faixa: 1, ate: 180_000, nominal: 0.045, deduzir: 0 },
  { faixa: 2, ate: 360_000, nominal: 0.078, deduzir: 5_940 },
  { faixa: 3, ate: 720_000, nominal: 0.1, deduzir: 13_860 },
  { faixa: 4, ate: 1_800_000, nominal: 0.112, deduzir: 22_500 },
  { faixa: 5, ate: 3_600_000, nominal: 0.147, deduzir: 85_500 },
  { faixa: 6, ate: 4_800_000, nominal: 0.3, deduzir: 720_000 },
] as const satisfies readonly FaixaSimples[];

/** Os anexos alcançáveis por receita de mercadoria (NF-e modelo 55). */
export const TABELAS_SIMPLES = {
  I: ANEXO_I,
  II: ANEXO_II,
} as const;

/** `'I'` comércio · `'II'` indústria. */
export type AnexoSimples = keyof typeof TABELAS_SIMPLES;
