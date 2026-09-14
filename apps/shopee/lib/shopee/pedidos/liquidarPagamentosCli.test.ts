/**
 * The pure half of `liquidar:pagamentos` (#1514, step 6, plan §3.0-S S11).
 *
 * ⚠️ Two of these tests are the only thing standing between a rehearsal and a
 * leak, and neither is a happy path:
 *
 *  - **36** puts SENTINELS in the buyer-shaped fields of the escrow body and
 *    asserts they appear in neither the object nor the rendered lines, with a
 *    FIELD-COUNT pin so a field added to the allow-list has to be looked at;
 *  - **34** pins the date reading as UTC midnight. A local-zone reading would
 *    shift the window by hours depending on which machine ran the rehearsal,
 *    which is exactly what `delfrance/no-ambient-timezone` exists to stop.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shopeeEscrowDetailPayloadSchema } from '@delfrance/integrations-shopee';

import { makePagamentoIdShopee, makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import { preverLiquidacaoShopee } from './liquidarPagamento';
import type { LinhaSimuladaShopee } from './liquidacaoSweep';
import {
  ArgumentoInvalidoError,
  CAMPOS_RESUMO_LIQUIDACAO,
  USO_LIQUIDAR_PAGAMENTOS,
  descreverErroLiquidacao,
  parseArgsLiquidarPagamentos,
  renderResumoLiquidacao,
  resumoDaLinhaSimulada,
} from './liquidarPagamentosCli';

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
/** Sentinels — nothing real, and nothing that may reach the output. */
const SENTINELA_COMPRADOR = 'SENTINELA-NOME-DO-COMPRADOR';
const SENTINELA_CNPJ = 'SENTINELA-CNPJ-DO-PROCESSADOR';

function args(...argv: string[]) {
  const c = parseArgsLiquidarPagamentos(argv);
  if (c.kind !== 'liquidar') throw new Error('esperava o comando liquidar');
  return c.args;
}

/* ========================================================================== */
/*  33 · a matriz de argumentos                                               */
/* ========================================================================== */

describe('parseArgsLiquidarPagamentos', () => {
  it('33. a matriz de recusas', () => {
    // ⚠️ A CLASSE e a MENSAGEM, nas duas asserções: só a classe deixaria passar
    // uma recusa que acontece pelo motivo errado (a mensagem é o que o operador
    // lê), e só a mensagem deixaria passar um `Error` genérico, que o script
    // trata de outro jeito.
    const recusa = (argv: string[], trecho: string): void => {
      expect(() => parseArgsLiquidarPagamentos(argv), argv.join(' ')).toThrowError(
        ArgumentoInvalidoError,
      );
      expect(() => parseArgsLiquidarPagamentos(argv), argv.join(' ')).toThrowError(trecho);
    };

    recusa([], '--integracao');
    recusa(['--integracao'], 'exige um valor');
    recusa(['--integracao', 'int-1', '--sei-la'], 'Opção desconhecida');
    recusa(['--integracao', 'int-1', '--live', '--dry-run'], 'contraditórios');
    recusa(['--integracao', 'int-1', '--cursor'], '--cursor só faz sentido com --live');
    recusa(['--integracao', 'int-1', '--de', '2026-09-01'], '--de e --ate andam juntos');
    recusa(['--integracao', 'int-1', '--ate', '2026-09-01'], '--de e --ate andam juntos');
    recusa(
      ['--integracao', 'int-1', '--de', '2026-09-08', '--ate', '2026-09-01'],
      '--de não pode ser depois de --ate',
    );
    recusa(
      [
        '--integracao',
        'int-1',
        '--order-sn',
        ORDER_SN,
        '--de',
        '2026-09-01',
        '--ate',
        '2026-09-02',
      ],
      'não combina com --de/--ate',
    );
    // ⚠️ Este não é uma limitação do script: a LISTAGEM de escrow é consultada
    // por JANELA e não tem forma por id, então esse caminho nunca conhece
    // `payout_amount` nem `escrow_release_time` — e gravar por ele apagaria um
    // carimbo de liberação que um tick anterior já gravou.
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--live'], 'só para inspeção');
    // ⚠️ O `--` literal: o pnpm repassa esse token PARA o script.
    recusa(['--integracao', 'int-1', '--'], 'Separador "--"');
    recusa(['--integracao', 'int-1', '--de', '2026-13-99', '--ate', '2026-09-02'], 'data ISO');
  });

  it('33b. o caminho feliz, e os padrões que importam', () => {
    const a = args('--integracao', 'int-1');
    expect(a).toEqual({
      integracaoId: 'int-1',
      janela: null,
      orderSn: null,
      // ⚠️ DRY-RUN é o padrão, e `--live` é o único opt-in.
      live: false,
      cursor: false,
      json: false,
      projectId: null,
    });

    const b = args('--integracao=int-2', '--live', '--cursor', '--json', '--project=demo-erp');
    expect(b.live).toBe(true);
    expect(b.cursor).toBe(true);
    expect(b.json).toBe(true);
    expect(b.projectId).toBe('demo-erp');

    // `--dry-run` explícito é aceito sozinho.
    expect(args('--integracao', 'int-1', '--dry-run').live).toBe(false);
    expect(args('--integracao', 'int-1', '--order-sn', ORDER_SN).orderSn).toBe(ORDER_SN);
  });

  it('34. `--de`/`--ate` são MEIA-NOITE UTC, não o fuso da máquina', () => {
    // ⚠️ O runner roda com `TZ=UTC`, então este teste sozinho não distingue as
    // duas leituras — o que o distingue é o número LITERAL, calculado a partir
    // de `Date.UTC` e escrito aqui. Uma leitura local em São Paulo responderia
    // três horas depois.
    const a = args('--integracao', 'int-1', '--de', '2026-09-01', '--ate', '2026-09-08');
    expect(a.janela).toEqual({ deMs: 1_788_220_800_000, ateMs: 1_788_825_600_000 });
    expect(a.janela!.deMs).toBe(Date.UTC(2026, 8, 1));
    expect(a.janela!.ateMs).toBe(Date.UTC(2026, 8, 8));
    // …e o intervalo é exatamente sete dias, o que uma leitura com fuso não
    // garantiria sobre uma virada de horário de verão.
    expect(a.janela!.ateMs - a.janela!.deMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('35. `--help` responde ANTES de qualquer validação', () => {
    // Sozinho, sem `--integracao`, com uma opção desconhecida junto e com um
    // `--de` sem `--ate`: nenhuma dessas recusas pode preceder a ajuda.
    expect(parseArgsLiquidarPagamentos(['--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsLiquidarPagamentos(['-h'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsLiquidarPagamentos(['--sei-la', '--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsLiquidarPagamentos(['--de', '2026-09-01', '-h'])).toEqual({ kind: 'ajuda' });
  });

  it('35b. …e o SCRIPT devolve na ajuda antes do primeiro `await import`', () => {
    // A outra metade do trato, e é ESTRUTURAL: nada abaixo da linha de import
    // dinâmico foi carregado ainda, então nenhuma leitura de env em escopo de
    // módulo, nenhum singleton de admin e nenhum cliente pode rodar no caminho
    // da ajuda. Um teste unitário do parser não consegue ver isso.
    const fonte = readFileSync(
      new URL('../../../scripts/liquidar-pagamentos.ts', import.meta.url),
      'utf8',
    );
    const ajuda = fonte.indexOf("comando.kind === 'ajuda'");
    const primeiroImport = fonte.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(primeiroImport).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('37. o texto de uso NÃO carrega um separador `--` entre flags', () => {
    // Um `pnpm run` com o separador antes das flags repassa o token literal
    // para o script, e todo CLI deste repo parseia `process.argv` sozinho —
    // então o comando documentado morreria no próprio separador.
    // `pnpm-run-args.test.js` derruba a CI na grafia que carrega um, INCLUSIVE
    // dentro desta string (foi o que ele fez com a primeira redação deste
    // comentário, que escrevia o padrão por extenso).
    expect(USO_LIQUIDAR_PAGAMENTOS).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(USO_LIQUIDAR_PAGAMENTOS).toContain('liquidar:pagamentos');
    // A meia-noite UTC é DITA no texto, não só implementada.
    expect(USO_LIQUIDAR_PAGAMENTOS).toContain('MEIA-NOITE UTC');
  });
});

/* ========================================================================== */
/*  36 · a redação                                                            */
/* ========================================================================== */

describe('resumoDaLinhaSimulada', () => {
  /** Um escrow com SENTINELAS em tudo que tem cara de comprador. */
  function linha(): LinhaSimuladaShopee {
    const escrow = shopeeEscrowDetailPayloadSchema.parse({
      order_sn: ORDER_SN,
      buyer_user_name: SENTINELA_COMPRADOR,
      order_income: {
        escrow_amount: 30.7,
        escrow_amount_after_adjustment: 30.7,
        buyer_total_amount: 31.99,
        commission_fee: 0.65,
        service_fee: 0,
        seller_transaction_fee: 0.64,
        buyer_payment_method: SENTINELA_COMPRADOR,
        payment_processor_register: SENTINELA_CNPJ,
      },
      buyer_payment_info: {
        buyer_payment_method: SENTINELA_COMPRADOR,
        buyer_total_amount: 31.99,
      },
    });
    const pedidoId = makePedidoIdShopee(CONTA, ORDER_SN);
    return {
      orderSn: ORDER_SN,
      origem: 'listagem',
      pedidoId,
      pagamentoId: makePagamentoIdShopee(CONTA, ORDER_SN),
      existePedido: true,
      existePagamento: true,
      payoutAmount: 30.7,
      escrowReleaseTimeS: 1_759_000_000,
      escrow,
      motivo: null,
      previsao: preverLiquidacaoShopee(
        { id: ORDER_SN, cartao: { cnpj_instituicao: SENTINELA_CNPJ } },
        {
          orderSn: ORDER_SN,
          escrow,
          escrowReleaseTimeS: 1_759_000_000,
          payoutAmount: 30.7,
          nowMs: 1_700_000_000_000,
        },
      ),
    };
  }

  it('36. os sentinelas não aparecem NEM no objeto NEM na renderização, e a lista é fechada', () => {
    const r = resumoDaLinhaSimulada(linha());

    // (a) a lista de permissão é FECHADA — e o número é fixado, para que um
    // campo novo tenha de ser olhado em vez de entrar de carona.
    expect(Object.keys(r).sort()).toEqual([...CAMPOS_RESUMO_LIQUIDACAO].sort());
    expect(CAMPOS_RESUMO_LIQUIDACAO).toHaveLength(14);

    // (b) nem o objeto…
    const serializado = JSON.stringify(r);
    expect(serializado).not.toContain(SENTINELA_COMPRADOR);
    expect(serializado).not.toContain(SENTINELA_CNPJ);
    expect(serializado).not.toContain('buyer_');

    // (c) …nem as linhas renderizadas.
    const texto = renderResumoLiquidacao(r, null).join('\n');
    expect(texto).not.toContain(SENTINELA_COMPRADOR);
    expect(texto).not.toContain(SENTINELA_CNPJ);

    // (d) ÂNCORA: o negativo não pode ser vazio — o resumo carrega mesmo o que
    // uma rehearsal precisa ver.
    expect(r.escrowAmount).toBe(30.7);
    expect(r.payoutAmount).toBe(30.7);
    expect(r.tarifas).toBe(1.29);
    expect(r.taxas!.comissao).toBe(0.65);
    expect(r.escrowReleaseTimeUs).toBe(microsDeSegundosShopee(1_759_000_000));
    expect(r.acao).toBe('liquidado');
    expect(r.camposQueMudariam).toContain('tarifas');
    expect(texto).toContain(ORDER_SN);
    expect(texto).toContain('liquidado');
  });

  it('36b. uma linha cujo escrow não foi lido rende ação `null` e a renderização diz o MOTIVO', () => {
    const base = linha();
    const semEscrow: LinhaSimuladaShopee = {
      ...base,
      escrow: null,
      motivo: 'order_not_found',
      previsao: null,
    };

    const r = resumoDaLinhaSimulada(semEscrow);

    expect(r.acao).toBeNull();
    expect(r.escrowAmount).toBeNull();
    expect(r.tarifas).toBeNull();
    expect(r.camposQueMudariam).toEqual([]);
    const texto = renderResumoLiquidacao(r, 'order_not_found').join('\n');
    expect(texto).toContain('NÃO LIDO — order_not_found');
    // ⚠️ E nada mais: sem escrow não há dinheiro para imprimir.
    expect(texto).not.toContain('tarifas');
  });
});

/* ========================================================================== */
/*  os erros                                                                  */
/* ========================================================================== */

describe('descreverErroLiquidacao', () => {
  it('um argumento inválido imprime a ajuda DESTE CLI, não a do importador', () => {
    const linhas = descreverErroLiquidacao(new ArgumentoInvalidoError('faltou --integracao'));
    expect(linhas[0]).toContain('faltou --integracao');
    expect(linhas.join('\n')).toContain('liquidar:pagamentos');
    expect(linhas.join('\n')).not.toContain('importar:pedido');
  });

  it('qualquer outra falha cai na tabela COMPARTILHADA do importador', () => {
    // ⚠️ Importada, nunca reimplementada: as duas CLIs enfrentam a mesma
    // taxonomia de erro, e uma segunda cópia dessa tabela é como uma delas
    // começa a imprimir um payload.
    const linhas = descreverErroLiquidacao(new TypeError('x is not a function'));
    expect(linhas[0]).toContain('TypeError');
  });
});
