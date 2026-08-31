import { describe, expect, it } from 'vitest';

import type { MercadoLivreRelatorioEnvioPrecoLinha } from '@/lib/mercado-livre/client';
import {
  ENVIO_PRECO_CSV_HEADER,
  buildEnvioPrecoCsv,
  envioPrecoCsvFilename,
  type EnvioPrecoCsvResumo,
} from './envioPrecoCsv';

function linha(
  over: Partial<MercadoLivreRelatorioEnvioPrecoLinha> = {},
): MercadoLivreRelatorioEnvioPrecoLinha {
  return {
    produtoId: 'p1',
    produtoNome: 'Camiseta',
    sku: 'CAM-1',
    variacaoProdutoId: null,
    anuncioId: 'MLB1',
    linkDocId: 'lnk-1',
    resultado: 'enviado',
    fase: 'envio',
    motivo: null,
    mensagem: null,
    erro: null,
    preco: 50,
    precoAnterior: 40,
    variacoes: null,
    ...over,
  };
}

const RESUMO: EnvioPrecoCsvResumo = {
  status: 'completed',
  relatorioCompleto: true,
  filaRestante: 0,
  planejados: 1,
  enviados: 1,
  pulados: 0,
  falhas: 0,
};

describe('buildEnvioPrecoCsv', () => {
  it('opens with the BOM and a semicolon-delimited header', () => {
    // BOM + `;` + comma decimals is what Excel pt-BR opens without a wizard.
    const csv = buildEnvioPrecoCsv([linha()], RESUMO);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.split('\r\n')[0]).toBe('﻿' + ENVIO_PRECO_CSV_HEADER.join(';'));
  });

  it('⭐ formats money as REAIS with a comma, not as cents', () => {
    // The trap this guards: `centsToBr` (used by the NF-e report next door)
    // would render 50 as "0,50" — these values are reais floats, the same shape
    // `fila` carries.
    const csv = buildEnvioPrecoCsv([linha({ preco: 1234.5, precoAnterior: 999 })], RESUMO);

    expect(csv).toContain('999,00');
    expect(csv).toContain('1.234,50');
  });

  it('computes the difference only when BOTH ends are known', () => {
    const comAmbos = buildEnvioPrecoCsv([linha({ preco: 50, precoAnterior: 40 })], RESUMO);
    expect(comAmbos).toContain('10,00');

    // A plan-time skip never read the listing; a fabricated 0 would read as
    // "the price did not change".
    const semAnterior = buildEnvioPrecoCsv(
      [linha({ preco: 50, precoAnterior: null, resultado: 'pulado' })],
      RESUMO,
    );
    const dados = semAnterior.split('\r\n')[1]!.split(';');
    expect(dados[7]).toBe(''); // Preço anterior
    expect(dados[9]).toBe(''); // Diferença
  });

  it('⭐ shows NO difference for a refused send, however complete the prices look', () => {
    // The trap the schema docblock warns about: `preco` is the price the plan
    // INTENDED, and a refused send carries both ends — listing at 90, wanted 50.
    // Keying the difference off non-null would print a -40,00 movement for a
    // listing that never moved.
    const csv = buildEnvioPrecoCsv(
      [linha({ resultado: 'pulado', motivo: 'PRECO_ANTIGO_MAIOR', preco: 50, precoAnterior: 90 })],
      RESUMO,
    );
    const dados = csv.split('\r\n')[1]!.split(';');

    expect(dados[7]).toBe('90,00'); // Preço anterior — what the listing carries
    expect(dados[8]).toBe('50,00'); // Preço CALCULADO — what we wanted, not what landed
    expect(dados[9]).toBe(''); // Diferença — nothing moved
    expect(csv).not.toContain('-40,00');
  });

  it('⚠️ but DOES show it for a send that landed', () => {
    // The control: the column is not simply always blank.
    const csv = buildEnvioPrecoCsv(
      [linha({ resultado: 'enviado', preco: 50, precoAnterior: 90 })],
      RESUMO,
    );

    expect(csv.split('\r\n')[1]!.split(';')[9]).toBe('-40,00');
  });

  it('names the column "Preço calculado", not "enviado"', () => {
    expect(ENVIO_PRECO_CSV_HEADER).toContain('Preço calculado');
    expect(ENVIO_PRECO_CSV_HEADER).not.toContain('Preço enviado');
  });

  it('⭐ ends with a totals trailer, which is how a truncated file is detectable', () => {
    const csv = buildEnvioPrecoCsv([linha()], {
      ...RESUMO,
      planejados: 9,
      enviados: 3,
      pulados: 5,
      falhas: 1,
    });

    expect(csv).toContain('Total de linhas no arquivo: 1');
    expect(csv).toContain('Planejados: 9');
    expect(csv).toContain('Falhas: 1');
  });

  it('⭐ says RELATORIO INCOMPLETO when the run did not cover everything', () => {
    const csv = buildEnvioPrecoCsv([linha()], {
      ...RESUMO,
      status: 'failed',
      relatorioCompleto: false,
      filaRestante: 42,
    });

    expect(csv).toContain('RELATORIO INCOMPLETO');
    expect(csv).toContain('42 itens não foram tentados');
  });

  it('⚠️ says nothing of the sort on a complete run', () => {
    // The control. Without it the warning could be unconditional and every
    // assertion above would still pass.
    expect(buildEnvioPrecoCsv([linha()], RESUMO)).not.toContain('RELATORIO INCOMPLETO');
  });

  it('flags a client-side truncation separately from an incomplete run', () => {
    // Two different failures: the RUN stopped early vs the DOWNLOAD stopped
    // early. A file that hit the page cap is short even though the run was fine.
    const csv = buildEnvioPrecoCsv([linha()], RESUMO, { truncado: true });

    expect(csv).toContain('DOWNLOAD TRUNCADO');
    expect(csv).not.toContain('RELATORIO INCOMPLETO');
  });

  it('sorts the rows a human acts on first', () => {
    const csv = buildEnvioPrecoCsv(
      [
        linha({ sku: 'Z', resultado: 'enviado' }),
        linha({ sku: 'A', resultado: 'falha', motivo: 'UPDATE_PRECO_ERROR' }),
        linha({ sku: 'M', resultado: 'pulado', motivo: 'PRECO_ANTIGO_IGUAL' }),
      ],
      RESUMO,
    );
    const resultados = csv
      .split('\r\n')
      .slice(1, 4)
      .map((l) => l.split(';')[0]);

    expect(resultados).toEqual(['Falha', 'Pulado', 'Enviado']);
  });

  it('neutralises a formula-injection lead without touching a negative number', () => {
    // `csvCell` owns this; the assertion is that the builder routes through it.
    const csv = buildEnvioPrecoCsv(
      [linha({ produtoNome: '=SOMA(A1:A9)', preco: 10, precoAnterior: 40 })],
      RESUMO,
    );

    expect(csv).toContain("'=SOMA(A1:A9)");
    expect(csv).toContain('-30,00'); // a real negative difference stays numeric
  });

  it('renders the backend message rather than the raw code alone', () => {
    const csv = buildEnvioPrecoCsv(
      [
        linha({
          resultado: 'pulado',
          motivo: 'PRECO_NAO_MODIFICAVEL',
          mensagem: 'Desative a automação no anúncio.',
        }),
      ],
      RESUMO,
    );

    expect(csv).toContain('PRECO_NAO_MODIFICAVEL');
    expect(csv).toContain('Desative a automação no anúncio.');
  });
});

describe('envioPrecoCsvFilename', () => {
  it('carries the conta and the run date', () => {
    const nome = envioPrecoCsvFilename('Conta A', Date.UTC(2026, 7, 28, 15, 30));

    expect(nome).toContain('Conta A');
    expect(nome.endsWith('.csv')).toBe(true);
  });

  it('strips path-hostile characters from the conta name', () => {
    const nome = envioPrecoCsvFilename('A/B:C*?', 0);

    expect(nome).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('degrades rather than producing a nameless file', () => {
    expect(envioPrecoCsvFilename('///', 0)).toContain('conta');
    expect(envioPrecoCsvFilename('Conta A', Number.NaN)).toContain('sem-data');
  });
});
