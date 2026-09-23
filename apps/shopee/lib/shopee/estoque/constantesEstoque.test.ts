import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_MODEL_MAX_PER_ITEM,
  SHOPEE_UPDATE_STOCK_MAX_MODELS,
} from '@delfrance/integrations-shopee';
import {
  STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
  STOCK_TASK_ENCODED_BODY_WARN_BYTES,
} from '@delfrance/data/admin/estoque';

import * as constantes from './constantesEstoque';
import {
  ENVIO_MANUAL_MAX_TENTATIVAS,
  ENVIO_MANUAL_RETRY_DELAY_MS,
  MAX_MODELOS_POR_TASK,
  MAX_PAGES_PER_SWEEP,
  MOTIVOS_DE_PAUSA,
  PAUSA_FERIAS_H,
  PAUSA_LOJA_H,
  PAUSE_REENQUEUE_JITTER_MAX_S,
  SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
  SHOPEE_STOCK_SEND_QUEUE,
  SHOPEE_STOCK_SYNC_FLAG_ENV,
  STOCK_SEND_MAX_ATTEMPTS,
  anchorPageLimit,
  concurrentDispatches,
  cursorMaxLookbackHours,
  dailyWindowHours,
  dispatchesPerSecond,
  incrementalWindowMin,
  isShopeeStockSyncEnabled,
  kitIncluiEstoqueProprio,
  limiarEstoqueAlto,
  manualConcurrencyRaw,
  manualDeadlineMs,
  maxPauseReenqueues,
  maxTasksPerSweep,
  pausaFeriasH,
  pausaLojaH,
  promocaoRetryMin,
  ratePauseMin,
  windowOverlapSec,
} from './constantesEstoque';

/** This module's own raw TEXT — three properties below are measured on it. */
const FONTE = readFileSync(
  fileURLToPath(new URL('./constantesEstoque.ts', import.meta.url)),
  'utf8',
);

/** One hour in milliseconds, spelled from its factors (see test 9's comment). */
const UMA_HORA_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a superfície do módulo', () => {
  it('1 — exporta EXATAMENTE estes trinta e três nomes', () => {
    // O conjunto é o pino: `constantesEstoque.ts` é lido POR CAMINHO pelo
    // preflight do deploy e importado por doze módulos desta pasta, então um
    // nome que aparece ou some sem que ninguém decida é exatamente o que se
    // quer ver vermelho. (Um `export type` não entra aqui — `MotivoDePausa` não
    // existe em tempo de execução.)
    expect(Object.keys(constantes).sort()).toEqual([
      'ENVIO_MANUAL_MAX_TENTATIVAS',
      'ENVIO_MANUAL_RETRY_DELAY_MS',
      'MAX_MODELOS_POR_TASK',
      'MAX_PAGES_PER_SWEEP',
      'MOTIVOS_DE_PAUSA',
      'PAUSA_FERIAS_H',
      'PAUSA_LOJA_H',
      'PAUSE_REENQUEUE_JITTER_MAX_S',
      'SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS',
      'SHOPEE_STOCK_SEND_QUEUE',
      'SHOPEE_STOCK_SYNC_FLAG_ENV',
      'STOCK_SEND_MAX_ATTEMPTS',
      'STOCK_TASK_ENCODED_BODY_BUDGET_BYTES',
      'STOCK_TASK_ENCODED_BODY_WARN_BYTES',
      'anchorPageLimit',
      'concurrentDispatches',
      'cursorMaxLookbackHours',
      'dailyWindowHours',
      'dispatchesPerSecond',
      'incrementalWindowMin',
      'isShopeeStockSyncEnabled',
      'kitIncluiEstoqueProprio',
      'limiarEstoqueAlto',
      'manualConcurrencyRaw',
      'manualDeadlineMs',
      'maxPauseReenqueues',
      'maxTasksPerSweep',
      'pausaFeriasH',
      'pausaLojaH',
      'promocaoRetryMin',
      'ratePauseMin',
      'stockTaskEncodedBodyBytes',
      'windowOverlapSec',
    ]);
  });

  it('2 — o trio de tamanho de tarefa é REEXPORTADO do núcleo, não recriado', () => {
    // Uma cópia local do orçamento compilaria, passaria em tudo e divergiria no
    // dia em que o limite do Cloud Tasks fosse revisto num arquivo só — e a
    // falha seria uma tarefa RECUSADA na enfileiração, isto é, uma página
    // inteira de anúncios que nunca sai.
    expect(constantes.STOCK_TASK_ENCODED_BODY_BUDGET_BYTES).toBe(
      STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
    );
    expect(constantes.STOCK_TASK_ENCODED_BODY_WARN_BYTES).toBe(STOCK_TASK_ENCODED_BODY_WARN_BYTES);
    expect(FONTE).toContain("} from '@delfrance/data/admin/estoque';");
  });
});

describe('a fila e a válvula mestra', () => {
  it('3 — o nome da fila é `sendShopeeStock`, a string que a função exportada precisa repetir', () => {
    // A tarefa é enfileirada POR NOME. Renomear um lado só enfileira numa fila
    // que ninguém serve: as tarefas acumulam e expiram em silêncio enquanto
    // toda superfície reporta sucesso. A asserção de renome mora em
    // `functions/src/index.ts`; esta fixa a string dos dois lados do combinado.
    expect(SHOPEE_STOCK_SEND_QUEUE).toBe('sendShopeeStock');
    expect(STOCK_SEND_MAX_ATTEMPTS).toBe(3);
    expect(PAUSE_REENQUEUE_JITTER_MAX_S).toBe(30);
  });

  it('4 — PAR: só o literal `1` liga a sincronização', () => {
    expect(SHOPEE_STOCK_SYNC_FLAG_ENV).toBe('SHOPEE_STOCK_SYNC_ENABLED');
    expect(isShopeeStockSyncEnabled()).toBe(false); // ausente ⇒ DESLIGADO
    vi.stubEnv(SHOPEE_STOCK_SYNC_FLAG_ENV, '1');
    expect(isShopeeStockSyncEnabled()).toBe(true);
  });

  it('5 — ⛔ NEAR-MISS: `true`, `0`, vazio e `01` NÃO ligam nada', () => {
    // O par que dá sentido ao teste 4. Esta é a chave que passa a ESCREVER num
    // marketplace ao vivo, então qualquer leitura "quase verdadeira" — um `??`
    // que só protege `undefined`, um `Boolean(raw)` que aceita `'0'`, um
    // `startsWith('1')` que aceita `'01'` — liga o canal sem que ninguém tenha
    // digitado o único valor combinado.
    for (const nao of ['', ' ', '0', '1 ', '01', 'true', 'TRUE', 'yes', 'on']) {
      vi.stubEnv(SHOPEE_STOCK_SYNC_FLAG_ENV, nao);
      expect(isShopeeStockSyncEnabled(), JSON.stringify(nao)).toBe(false);
    }
  });
});

describe('os ajustáveis', () => {
  it('6 — cada leitor tem o padrão do bloco de ambiente', () => {
    expect(incrementalWindowMin()).toBe(15);
    expect(windowOverlapSec()).toBe(20);
    expect(cursorMaxLookbackHours()).toBe(24);
    expect(dailyWindowHours()).toBe(24);
    expect(limiarEstoqueAlto()).toBe(100);
    expect(anchorPageLimit()).toBe(250);
    expect(maxTasksPerSweep()).toBe(2000);
    expect(ratePauseMin()).toBe(5);
    expect(maxPauseReenqueues()).toBe(10);
    expect(promocaoRetryMin()).toBe(60);
    expect(manualDeadlineMs()).toBe(120000);
    expect(manualConcurrencyRaw()).toBe(2);
    expect(dispatchesPerSecond()).toBe(2);
    expect(concurrentDispatches()).toBe(2);
    expect(kitIncluiEstoqueProprio()).toBe(false);
  });

  it('7 — a leitura é PREGUIÇOSA: o valor vem da chamada, não da importação', () => {
    // O que a preguiça compra: um reensaio retempera com um redeploy em vez de
    // um patch, e um teste consegue mexer no ambiente depois que o módulo já
    // está carregado. Um `const X = envInt(...)` no topo do arquivo passaria no
    // teste 6 e em nada mais disto.
    vi.stubEnv('SHOPEE_STOCK_LIMIAR_ALTO', '9');
    expect(limiarEstoqueAlto()).toBe(9);
    vi.stubEnv('SHOPEE_STOCK_MAX_TASKS_PER_SWEEP', '50');
    expect(maxTasksPerSweep()).toBe(50);
    vi.stubEnv('SHOPEE_STOCK_MANUAL_CONCURRENCY', '4');
    expect(manualConcurrencyRaw()).toBe(4);
    vi.stubEnv('SHOPEE_STOCK_KIT_INCLUI_PROPRIO', '1');
    expect(kitIncluiEstoqueProprio()).toBe(true);
  });

  it('8 — os DOIS botões do shell de deploy casam com a regex do preflight', () => {
    // `tools/deploy-env/preflight.mjs` lê ESTE arquivo por caminho e extrai o
    // padrão com exatamente esta forma. Uma indireção (uma constante, um nome
    // montado, um default movido para variável) lê como "não há envInt para
    // NAME" e derruba o portão do deploy — sem que nada mais aqui mude de
    // comportamento, que é o que torna a propriedade invisível fora do texto.
    for (const nome of [
      'SHOPEE_STOCK_CONCURRENT_DISPATCHES',
      'SHOPEE_STOCK_DISPATCHES_PER_SECOND',
    ]) {
      const achado = new RegExp(`envInt\\(\\s*'${nome}'\\s*,\\s*(\\d+)\\s*\\)`).exec(FONTE);
      expect(achado, `sem envInt para ${nome}`).not.toBeNull();
      expect(achado?.[1], `o padrão de ${nome} mudou`).toBe('2');
    }
  });
});

describe('os limites', () => {
  it('9 — PAR: as duas pausas são HORAS na constante e MILISSEGUNDOS no acessor', () => {
    // Todo carimbo desta pasta é em milissegundos, e o chamador escreve
    // `nowMs + pausaFeriasH()`. Devolver a hora crua ali seria uma pausa de seis
    // milésimos de segundo — que ninguém jamais notaria, porque o campo
    // continua sendo um número plausível e a conta simplesmente nunca pausa.
    expect(PAUSA_LOJA_H).toBe(24);
    expect(PAUSA_FERIAS_H).toBe(6);
    expect(pausaLojaH()).toBe(PAUSA_LOJA_H * UMA_HORA_MS);
    expect(pausaFeriasH()).toBe(PAUSA_FERIAS_H * UMA_HORA_MS);
  });

  it('10 — ⛔ NEAR-MISS: o acessor NÃO devolve a hora crua, nem segundos, nem minutos', () => {
    expect(pausaFeriasH()).not.toBe(PAUSA_FERIAS_H);
    expect(pausaFeriasH()).not.toBe(PAUSA_FERIAS_H * 3600);
    expect(pausaFeriasH()).not.toBe(PAUSA_FERIAS_H * 60);
    expect(pausaLojaH()).toBeGreaterThan(pausaFeriasH());
  });

  it('11 — MAX_MODELOS_POR_TASK É a constante do PACOTE, não um 50 digitado aqui', () => {
    // Os dois limites do pacote valem 50 hoje e são constantes SEPARADAS de
    // propósito: um diz quantos modelos cabem numa chamada de estoque, o outro
    // quantos modelos um anúncio pode ter. Igualdade de VALOR não distingue os
    // dois enquanto o número coincidir — por isso a propriedade que importa é
    // medida no texto: a atribuição vem do nome importado.
    expect(MAX_MODELOS_POR_TASK).toBe(SHOPEE_UPDATE_STOCK_MAX_MODELS);
    expect(MAX_MODELOS_POR_TASK).toBe(50);
    expect(FONTE).toContain('export const MAX_MODELOS_POR_TASK = SHOPEE_UPDATE_STOCK_MAX_MODELS;');
    expect(FONTE).not.toContain('SHOPEE_MODEL_MAX_PER_ITEM');
    expect(SHOPEE_UPDATE_STOCK_MAX_MODELS).toBe(SHOPEE_MODEL_MAX_PER_ITEM); // hoje coincidem
  });

  it('12 — ⛔ o texto deste módulo NUNCA nomeia o limite de lote da DESLISTAGEM', () => {
    // O quarto "50" do canal é do passo 11 e pertence a outra superfície.
    // Montado em tempo de execução de propósito: o grep de disciplina da pasta
    // procura essa string CRUA e não exclui arquivos de teste, então soletrá-la
    // aqui tornaria a própria verificação a primeira violação.
    const banido = ['SHOPEE', 'UNLIST', 'MAX', 'ITEMS'].join('_');
    expect(FONTE.includes(banido)).toBe(false);
    expect(SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS).toBe(50);
    expect(MAX_PAGES_PER_SWEEP).toBe(10);
  });

  it('13 — a escada manual nunca passa da escada da fila', () => {
    // O manipulador decide "esta é a última tentativa?" pelo teto da FILA. Uma
    // escada manual mais longa faria o envio manual alcançar um estado terminal
    // que a fila nunca alcança — dois caminhos, dois finais, um deles nunca
    // exercitado.
    expect(ENVIO_MANUAL_MAX_TENTATIVAS).toBe(2);
    expect(ENVIO_MANUAL_MAX_TENTATIVAS).toBeLessThanOrEqual(STOCK_SEND_MAX_ATTEMPTS);
    expect(ENVIO_MANUAL_RETRY_DELAY_MS).toBe(1_500);
  });
});

describe('MOTIVOS_DE_PAUSA', () => {
  it('14 — o vocabulário de pausa é EXATAMENTE estes quatro slugs', () => {
    // PERSISTIDO em `estoqueShopeeSync.pausaMotivo`: acrescentar é barato,
    // renomear órfã toda linha já escrita.
    expect([...Object.values(MOTIVOS_DE_PAUSA)].sort()).toEqual([
      'burst',
      'cota-diaria',
      'loja-bloqueada',
      'loja-em-ferias',
    ]);
  });

  it('15 — as CHAVES casam com os slugs em camelCase', () => {
    for (const [chave, slug] of Object.entries(MOTIVOS_DE_PAUSA)) {
      const emCamel = slug.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(chave, slug).toBe(emCamel);
      expect(slug, slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });
});
