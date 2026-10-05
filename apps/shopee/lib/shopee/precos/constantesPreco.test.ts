import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
  concurrentDispatches,
} from '../estoque/constantesEstoque';
import * as constantes from './constantesPreco';
import {
  ENVIO_PRECO_MANUAL_MAX_TENTATIVAS,
  ENVIO_PRECO_MANUAL_RETRY_DELAY_MS,
  FONTE_DE_VERIFICACAO_PRECO,
  PRICE_LIST_SO_A_DIFERENCA,
  SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
  SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
  concorrenciaEnvioPrecoManual,
  manualDeadlineMsPreco,
} from './constantesPreco';

/** A pasta do seam de preço. */
const RAIZ_PRECOS = new URL('./', import.meta.url);

/** O TEXTO cru deste módulo — várias propriedades abaixo são medidas nele. */
const FONTE = readFileSync(fileURLToPath(new URL('./constantesPreco.ts', RAIZ_PRECOS)), 'utf8');

/** Os dois botões de ambiente do envio manual de preço. */
const PRAZO = 'SHOPEE_PRICE_MANUAL_DEADLINE_MS';
const CONCORRENCIA = 'SHOPEE_PRICE_MANUAL_CONCURRENCY';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a superfície do módulo', () => {
  it('1 — exporta EXATAMENTE estes dezoito nomes (os oito do PR 1 + os dez do job)', () => {
    // O conjunto é o pino: vários agentes importam este módulo, e um nome que
    // aparece ou some sem decisão é o que se quer ver vermelho. As constantes do
    // job (a fila, os limites, os dois botões) chegaram com o seu consumidor,
    // `atualizarPrecos.ts`.
    expect(Object.keys(constantes).sort()).toEqual([
      'AMOSTRA_FALHAS_CAP',
      'AMOSTRA_PULOS_CAP',
      'ENVIO_PRECO_MANUAL_MAX_TENTATIVAS',
      'ENVIO_PRECO_MANUAL_RETRY_DELAY_MS',
      'ENVIO_PRECO_MAX_PARQUES',
      'ENVIO_PRECO_MAX_PAUSAS',
      'ENVIO_PRECO_MAX_TENTATIVAS',
      'ENVIO_PRECO_ORFAO_MS',
      'FONTE_DE_VERIFICACAO_PRECO',
      'PARQUE_JITTER_MAX_S',
      'PRICE_LIST_SO_A_DIFERENCA',
      'SHOPEE_ENVIO_PRECO_MAX_PRODUTOS',
      'SHOPEE_PRECO_MODEL_ID_SEM_MODELO',
      'SHOPEE_PRICE_SYNC_QUEUE',
      'concorrenciaEnvioPrecoManual',
      'itensPorDespachoPreco',
      'manualDeadlineMsPreco',
      'pageLimitPreco',
    ]);
  });

  it('2 — PAR: os nomes do job do PR 2 chegaram, junto com o seu consumidor', () => {
    const nomes: readonly string[] = Object.keys(constantes);
    for (const doJob of [
      'SHOPEE_PRICE_SYNC_QUEUE',
      'ENVIO_PRECO_MAX_TENTATIVAS',
      'ENVIO_PRECO_MAX_PAUSAS',
      'ENVIO_PRECO_ORFAO_MS',
      'pageLimitPreco',
      'itensPorDespachoPreco',
    ]) {
      expect(nomes, doJob).toContain(doJob);
    }
  });
});

describe('as três decisões de fio (a sonda SG de 2026-09-24)', () => {
  it('3 — PAR: o valor de cada uma é o que a sonda mediu', () => {
    // P4/P6: `0` e a omissão funcionam num item sem modelo — fica o `0`.
    expect(SHOPEE_PRECO_MODEL_ID_SEM_MODELO).toBe(0);
    // P8: o irmão NÃO enviado manteve o preço — o corpo pode ser só a diferença.
    expect(PRICE_LIST_SO_A_DIFERENCA).toBe(true);
    // P4/P8: eco == pedido == releitura em toda escrita aceita.
    expect(FONTE_DE_VERIFICACAO_PRECO).toBe('eco');
  });

  it('4 — ⛔ NEAR-MISS: o id sem modelo é o NÚMERO zero, não um falsy qualquer', () => {
    // Um `null`, um `undefined` ou uma string `'0'` passariam num teste de
    // verdade/falsidade e mudariam o corpo que vai ao fio: o validador do
    // pacote aceita `model_id: 0` sozinho e recusa qualquer outra grafia.
    expect(Object.is(SHOPEE_PRECO_MODEL_ID_SEM_MODELO, 0)).toBe(true);
    expect(typeof SHOPEE_PRECO_MODEL_ID_SEM_MODELO).toBe('number');
    expect(FONTE_DE_VERIFICACAO_PRECO).not.toBe('releitura');
  });

  it('5 — cada docblock CITA a linha da sonda que o decidiu', () => {
    // A troca de qualquer um destes literais muda o que é ESCRITO num
    // marketplace ao vivo. A citação é o que obriga quem troca a reabrir o
    // resultado medido, em vez de "melhorar" um valor por intuição.
    const bloco = (nome: string): string => {
      const fim = FONTE.indexOf(`export const ${nome}`);
      expect(fim, nome).toBeGreaterThan(0);
      const inicio = FONTE.lastIndexOf('/**', fim);
      return FONTE.slice(inicio, fim);
    };
    expect(bloco('SHOPEE_PRECO_MODEL_ID_SEM_MODELO')).toContain('**P4/P6**');
    expect(bloco('PRICE_LIST_SO_A_DIFERENCA')).toContain('**P8**');
    expect(bloco('FONTE_DE_VERIFICACAO_PRECO')).toContain('**P4/P8**');
  });
});

describe('os limites do envio manual', () => {
  it('6 — PAR: cinquenta produtos por pedido, duas tentativas, 1,5 s entre elas', () => {
    expect(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS).toBe(50);
    expect(ENVIO_PRECO_MANUAL_MAX_TENTATIVAS).toBe(2);
    expect(ENVIO_PRECO_MANUAL_RETRY_DELAY_MS).toBe(1_500);
  });

  it('7 — ⛔ NEAR-MISS: o limite de preço é uma constante PRÓPRIA, não a do estoque', () => {
    // Os dois valem 50 hoje por coincidência. Igualdade de VALOR não distingue
    // uma cópia de uma referência — por isso a propriedade é medida no texto: a
    // atribuição é um literal nosso e o nome do estoque não aparece.
    expect(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS).toBe(SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS); // hoje coincidem
    expect(FONTE).toContain('export const SHOPEE_ENVIO_PRECO_MAX_PRODUTOS = 50;');
    expect(FONTE.includes('SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS')).toBe(false);
  });
});

describe('manualDeadlineMsPreco', () => {
  it('8 — PAR: o padrão é 120 000 ms, e um valor válido é lido como está', () => {
    expect(manualDeadlineMsPreco()).toBe(120000);
    vi.stubEnv(PRAZO, '5000');
    expect(manualDeadlineMsPreco()).toBe(5000);
  });

  it('9 — ⛔ abaixo do piso é elevado a 1 000 ms; o piso exato e um acima passam intactos', () => {
    // `envInt` aceita `0` como inteiro válido, e um orçamento zero responderia
    // TODO item `tempo-esgotado` sem uma única chamada — uma configuração
    // errada que chega ao operador como "a Shopee estava lenta".
    for (const [bruto, esperado] of [
      ['0', 1000],
      ['1', 1000],
      ['999', 1000],
      ['1000', 1000],
      ['1001', 1001],
    ] as const) {
      vi.stubEnv(PRAZO, bruto);
      expect(manualDeadlineMsPreco(), bruto).toBe(esperado);
    }
  });

  it('10 — vazio, não inteiro e negativo caem no PADRÃO, não no piso', () => {
    for (const bruto of ['', '   ', 'abc', '1.5', '-5']) {
      vi.stubEnv(PRAZO, bruto);
      expect(manualDeadlineMsPreco(), JSON.stringify(bruto)).toBe(120000);
    }
  });

  it('11 — ⛔ NEAR-MISS: o botão do ESTOQUE não mexe no prazo do preço', () => {
    // Dois botões de propósito: as duas rotas se reajustam separadamente.
    vi.stubEnv('SHOPEE_STOCK_MANUAL_DEADLINE_MS', '5000');
    expect(manualDeadlineMsPreco()).toBe(120000);
  });
});

describe('concorrenciaEnvioPrecoManual', () => {
  it('12 — PAR: o padrão é 2 (e a fila de estoque também vale 2 sem configuração)', () => {
    expect(concurrentDispatches()).toBe(2);
    expect(concorrenciaEnvioPrecoManual()).toBe(2);
    vi.stubEnv(CONCORRENCIA, '1');
    expect(concorrenciaEnvioPrecoManual()).toBe(1);
  });

  it('13 — ⛔ ACIMA do teto é servido na largura da fila de estoque (a cota é da APLICAÇÃO)', () => {
    // O mutante D2-M17: uma largura não presa ao teto deixaria um envio
    // disparado por um operador gastar mais da cota compartilhada do que a
    // fila que roda ao lado — a única largura que o canal já ensaiou.
    vi.stubEnv(CONCORRENCIA, '99');
    expect(concorrenciaEnvioPrecoManual()).toBe(concurrentDispatches());
    expect(concorrenciaEnvioPrecoManual()).toBe(2);
  });

  it('14 — o teto ACOMPANHA a fila: 4 na fila serve 3 pedidos como 3 e 99 como 4', () => {
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '4');
    vi.stubEnv(CONCORRENCIA, '3');
    expect(concorrenciaEnvioPrecoManual()).toBe(3);
    vi.stubEnv(CONCORRENCIA, '99');
    expect(concorrenciaEnvioPrecoManual()).toBe(4);
  });

  it('15 — ⛔ ABAIXO do piso é 1: largura zero não rodaria nada e responderia como se tivesse tentado', () => {
    vi.stubEnv(CONCORRENCIA, '0');
    expect(concorrenciaEnvioPrecoManual()).toBe(1);
    vi.stubEnv(CONCORRENCIA, '2');
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '0');
    expect(concorrenciaEnvioPrecoManual()).toBe(1);
  });

  it('16 — ⛔ NEAR-MISS: o botão manual do ESTOQUE não mexe na largura do preço', () => {
    vi.stubEnv('SHOPEE_STOCK_MANUAL_CONCURRENCY', '1');
    expect(concorrenciaEnvioPrecoManual()).toBe(2);
  });
});

describe('a família leitora de ambiente', () => {
  it('17 — a leitura é PREGUIÇOSA e soletra o literal `envInt(NOME, padrão)`', () => {
    // Um `const X = envInt(...)` no topo passaria no teste 8 e em nada mais —
    // o ambiente mexido depois da importação seria ignorado. E a grafia literal
    // mantém o padrão legível por quem audita o arquivo pelo texto.
    expect(FONTE).toContain(`envInt('${PRAZO}', 120000)`);
    expect(FONTE).toContain(`envInt('${CONCORRENCIA}', 2)`);
    expect(FONTE).toContain("import { envInt } from '@delfrance/data/admin/estoque';");
  });

  it('18 — o teto é a função do ESTOQUE importada, nunca a variável relida aqui', () => {
    // Reler `SHOPEE_STOCK_CONCURRENT_DISPATCHES` aqui funcionaria hoje e
    // divergiria no dia em que o padrão da fila mudasse num arquivo só.
    expect(FONTE).toContain("import { concurrentDispatches } from '../estoque/constantesEstoque';");
    expect(FONTE.includes('SHOPEE_STOCK_CONCURRENT_DISPATCHES')).toBe(false);
  });

  it('19 — ⛔ nenhum OUTRO fonte de `precos/` lê o ambiente', () => {
    // Este módulo é a ÚNICA família leitora da pasta. Montado em tempo de
    // execução: o grep de disciplina da pasta procura a grafia crua, e
    // soletrá-la aqui não é violação só porque aquele grep exclui testes.
    const lerAmbiente = ['process', 'env'].join('.');
    const outros = readdirSync(RAIZ_PRECOS).filter(
      (nome) => nome.endsWith('.ts') && !nome.endsWith('.test.ts') && nome !== 'constantesPreco.ts',
    );
    for (const nome of outros) {
      const texto = readFileSync(fileURLToPath(new URL(nome, RAIZ_PRECOS)), 'utf8');
      expect(texto.includes(lerAmbiente), nome).toBe(false);
      expect(/\benv(?:Int|Flag)\(/.test(texto), nome).toBe(false);
    }
    // Âncora: a pasta foi lida (sem ela o laço acima passaria vazio).
    expect(outros).toContain('errosPreco.ts');
  });
});
