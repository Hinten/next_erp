import { describe, expect, it } from 'vitest';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_RESULTADO,
  type EnvioPrecoFase,
  type EnvioPrecoResultado,
} from '@delfrance/schemas';

import {
  ENVIO_PRECO_CSV_HEADER,
  buildEnvioPrecoCsv,
  type EnvioPrecoCsvResumo,
} from './envioPrecoCsv';

/**
 * A row of Shopee's relatório PAGE — the key set
 * `apps/shopee/app/api/marketplace/shopee/atualizar-precos/relatorio/route.ts`
 * builds BY NAME, copied from that route. It carries `linkDocId` but no
 * `variacoes` (Mercado Livre's page has both), which is the whole point: the
 * builder is typed on the columns it READS, so a page without the others still
 * builds — and this file stops compiling if the builder starts reading one.
 */
interface LinhaPaginaShopee {
  readonly produtoId: string;
  readonly variacaoProdutoId: string | null;
  readonly anuncioId: string | null;
  readonly linkDocId: string | null;
  readonly resultado: EnvioPrecoResultado;
  readonly fase: EnvioPrecoFase;
  readonly motivo: string | null;
  readonly mensagem: string | null;
  readonly erro: string | null;
  readonly preco: number | null;
  readonly precoAnterior: number | null;
  readonly produtoNome: string | null;
  readonly sku: string | null;
}

function linhaShopee(over: Partial<LinhaPaginaShopee> = {}): LinhaPaginaShopee {
  return {
    produtoId: 'p1',
    variacaoProdutoId: 'p1-v1',
    anuncioId: '1000001',
    linkDocId: 'lnk-1',
    resultado: ENVIO_PRECO_RESULTADO.enviado,
    fase: ENVIO_PRECO_FASE.envio,
    motivo: null,
    mensagem: null,
    erro: null,
    preco: 50,
    precoAnterior: 40,
    produtoNome: 'Camiseta P',
    sku: 'CAM-1-P',
    ...over,
  };
}

const RESUMO: EnvioPrecoCsvResumo = {
  status: 'completed',
  relatorioCompleto: true,
  filaRestante: 0,
  planejados: 2,
  enviados: 1,
  pulados: 1,
  falhas: 0,
};

describe('buildEnvioPrecoCsv over a Shopee page (#1529)', () => {
  it('builds the 13 columns from a row that carries no `variacoes`', () => {
    const csv = buildEnvioPrecoCsv(
      [
        linhaShopee(),
        linhaShopee({
          produtoId: 'p2',
          variacaoProdutoId: null,
          anuncioId: '1000002',
          resultado: ENVIO_PRECO_RESULTADO.pulado,
          fase: ENVIO_PRECO_FASE.plano,
          motivo: 'PRECO_ANTIGO_IGUAL',
          mensagem: 'O preço já está atualizado.',
          preco: 30,
          precoAnterior: 30,
          produtoNome: 'Boné',
          sku: 'BON-1',
        }),
      ],
      RESUMO,
    );
    const linhas = csv.split('\r\n');

    expect(linhas[0]).toBe('﻿' + ENVIO_PRECO_CSV_HEADER.join(';'));
    expect(ENVIO_PRECO_CSV_HEADER).toHaveLength(13);
    // The row a human acts on first (pulado before enviado), every column placed.
    expect(linhas[1]!.split(';')).toEqual([
      'Pulado',
      'Planejamento',
      'BON-1',
      'Boné',
      'p2',
      '',
      '1000002',
      '30,00',
      '30,00',
      '',
      'PRECO_ANTIGO_IGUAL',
      'O preço já está atualizado.',
      '',
    ]);
    expect(linhas[2]!.split(';')).toEqual([
      'Enviado',
      'Envio',
      'CAM-1-P',
      'Camiseta P',
      'p1',
      'p1-v1',
      '1000001',
      '40,00',
      '50,00',
      '10,00',
      '',
      '',
      '',
    ]);
  });

  it('takes the trailer counters from the resumo, never from the rows', () => {
    // Two rows on the page, a run that planned forty: the trailer must say forty.
    // A builder that re-counted its rows would print the page's numbers, which
    // is exactly the short report the trailer exists to expose.
    const csv = buildEnvioPrecoCsv([linhaShopee(), linhaShopee({ produtoId: 'p2' })], {
      status: 'failed',
      relatorioCompleto: false,
      filaRestante: 7,
      planejados: 40,
      enviados: 31,
      pulados: 2,
      falhas: 0,
    });

    expect(csv).toContain('Total de linhas no arquivo: 2');
    expect(csv).toContain('Planejados: 40');
    expect(csv).toContain('Enviados: 31');
    expect(csv).toContain('Pulados: 2');
    expect(csv).toContain('Falhas: 0');
    expect(csv).toContain('o envio terminou em ""failed""; 7 itens não foram tentados.');
  });
});
