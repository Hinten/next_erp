/**
 * A aritmética do Simples Nacional: RBT12 → faixa → alíquota efetiva, e a
 * redução de uma NF-e a receita bruta.
 *
 * **Puro e total** — sem relógio, sem rede, sem Firestore. É o que permite que
 * o runner mensal, o backfill e a tela da filial usem a MESMA conta em vez de
 * três cópias que divergem devagar. Ver a regra de extração em
 * `packages/schemas` no CLAUDE.md da raiz.
 */
import { roundReais } from '@delfrance/core/money';

import type { NFeTotais } from '../nfe';
import {
  TABELAS_SIMPLES,
  TETO_SIMPLES_NACIONAL,
  type AnexoSimples,
  type FaixaSimples,
} from './tabelas';

/** Por que não há alíquota para uma RBT12. */
export const SEM_ALIQUOTA = {
  /** RBT12 zero — empresa sem receita nos 12 meses; não há o que dividir. */
  semReceita: 'semReceita',
  /** Acima de R$ 4.800.000 — fora do Simples; a conta não se aplica. */
  acimaDoTeto: 'acimaDoTeto',
  /** RBT12 negativa (devoluções > vendas no acumulado) — não é uma receita. */
  negativa: 'negativa',
} as const;

export type SemAliquota = (typeof SEM_ALIQUOTA)[keyof typeof SEM_ALIQUOTA];

/** Resultado da apuração de uma alíquota. */
export type ResultadoAliquota =
  | { readonly ok: true; readonly faixa: FaixaSimples; readonly aliquotaEfetiva: number }
  | { readonly ok: false; readonly motivo: SemAliquota };

/**
 * A faixa que cobre uma RBT12, ou `null` acima do teto.
 *
 * ⚠️ O teto de cada faixa é **inclusivo**: R$ 180.000,00 exatos ainda é 1ª
 * faixa; R$ 180.000,01 já é a 2ª. Errar essa borda troca a alíquota inteira, e
 * é a única coisa que os testes de fronteira ao lado existem para travar.
 */
export function faixaDoRbt12(anexo: AnexoSimples, rbt12: number): FaixaSimples | null {
  return TABELAS_SIMPLES[anexo].find((f) => rbt12 <= f.ate) ?? null;
}

/**
 * `[(RBT12 × nominal) − parcelaDeduzir] / RBT12`.
 *
 * ⚠️ **Não arredondada.** A alíquota não é dinheiro; arredondá-la a 2 casas
 * moveria o imposto de cada nota. `roundReais` entra só quando o resultado
 * vira reais, em {@link impostoDaReceita}.
 */
export function aliquotaEfetiva(anexo: AnexoSimples, rbt12: number): ResultadoAliquota {
  if (rbt12 < 0) return { ok: false, motivo: SEM_ALIQUOTA.negativa };
  if (rbt12 === 0) return { ok: false, motivo: SEM_ALIQUOTA.semReceita };
  if (rbt12 > TETO_SIMPLES_NACIONAL) return { ok: false, motivo: SEM_ALIQUOTA.acimaDoTeto };

  const faixa = faixaDoRbt12(anexo, rbt12);
  // Inalcançável enquanto a última faixa terminar no teto — mas a tabela é
  // dado, e um dado editado não deve virar `undefined` silencioso.
  if (faixa === null) return { ok: false, motivo: SEM_ALIQUOTA.acimaDoTeto };

  return { ok: true, faixa, aliquotaEfetiva: (rbt12 * faixa.nominal - faixa.deduzir) / rbt12 };
}

/** O imposto atribuído a uma receita, em reais. */
export function impostoDaReceita(receita: number, aliquota: number): number {
  return roundReais(receita * aliquota);
}

/**
 * RBT12 para empresa em início de atividade (Resolução CGSN 140, art. 24).
 *
 * - **1º mês**: a receita do próprio mês × 12;
 * - **2º ao 12º**: a média aritmética dos meses ANTERIORES × 12;
 * - **13º em diante**: a regra geral (soma dos 12 anteriores) — que este
 *   helper não cobre, porque aí não há proporcionalização a fazer.
 *
 * `receitasAnteriores` são os meses já fechados, do mais antigo ao mais
 * recente, sem o mês corrente. `receitaDoMes` é o mês de apuração.
 */
export function rbt12Proporcional(args: {
  readonly receitasAnteriores: readonly number[];
  readonly receitaDoMes: number;
}): number {
  const { receitasAnteriores, receitaDoMes } = args;
  if (receitasAnteriores.length === 0) return receitaDoMes * 12;
  const soma = receitasAnteriores.reduce((a, b) => a + b, 0);
  return (soma / receitasAnteriores.length) * 12;
}

/**
 * Uma NF-e reduzida a receita bruta, em reais e SEM sinal.
 *
 * Receita bruta é o preço da operação: produtos menos descontos
 * incondicionais, mais o que for cobrado do adquirente a título de frete,
 * seguro e demais despesas acessórias.
 *
 * ⚠️ **ICMS-ST e IPI ficam de fora** (LC 123 art. 3º §1º), e é por isso que a
 * conta é montada a partir das PARTES em vez de partir do `vNF` — `vNF` já
 * carrega ambos. Pelo mesmo motivo IBS/CBS/IS não entram: são "por fora" e
 * vivem em `totais.rtc`, que esta soma nunca toca.
 */
export function receitaBrutaDeNota(totais: NFeTotais): number {
  return roundReais(totais.vProd - totais.vDesc + totais.vFrete + totais.vSeg + totais.vOutro);
}

/**
 * O sinal com que uma nota entra na receita bruta do mês: `+1` soma, `-1`
 * subtrai, `0` não é receita.
 *
 * ⚠️ **`tpNF` sozinho não decide.** Uma devolução pode ser entrada (o cliente
 * nos devolveu — receita negativa) ou saída (nós devolvemos ao fornecedor —
 * não é receita nenhuma), e as duas carregam `finNFe = 4`. A tabela:
 *
 * | tpNF | finNFe | sinal | por quê |
 * |---|---|---|---|
 * | 1 saída | 1 normal | `+1` | a venda |
 * | 1 saída | 2 complementar | `+1` | complementa o valor de uma venda anterior |
 * | 1 saída | 3 ajuste | `0` | corrige informação, não movimenta preço |
 * | 1 saída | 4 devolução | `0` | devolução de COMPRA — nunca foi nossa receita |
 * | 0 entrada | 4 devolução | `-1` | o cliente devolveu: receita negativa no mês |
 * | 0 entrada | 1,2,3 | `0` | compra, não venda |
 *
 * ⚠️ O `0` de "saída + ajuste" é deliberadamente conservador: uma NF-e de
 * ajuste PODE carregar valor, e nesse caso a receita fica subestimada. Preferir
 * subestimar aqui seria errado se fosse silencioso — por isso o runner conta
 * essas notas à parte, para que a contabilidade veja quantas foram ignoradas em
 * vez de descobrir a diferença no PGDAS-D.
 */
export function sinalDaReceita(totais: NFeTotais): -1 | 0 | 1 {
  return sinalDe(totais.tpNF, totais.finNFe);
}

/**
 * O mesmo julgamento a partir do PAR de códigos, sem a nota inteira.
 *
 * Existe porque o agregado mensal recebe do Firestore grupos `(tpNF, finNFe)`
 * com as somas já feitas — nunca notas individuais. Sem isto a regra seria
 * reescrita lá, e duas cópias de uma tabela de sinais divergem em silêncio:
 * a soma continua saindo, só sai errada.
 */
export function sinalDe(tpNF: NFeTotais['tpNF'], finNFe: NFeTotais['finNFe']): -1 | 0 | 1 {
  if (tpNF === 1) return finNFe === 1 || finNFe === 2 ? 1 : 0;
  return finNFe === 4 ? -1 : 0;
}

/** A contribuição assinada de uma nota para a receita bruta do mês. */
export function contribuicaoDaNota(totais: NFeTotais): number {
  return roundReais(receitaBrutaDeNota(totais) * sinalDaReceita(totais));
}
