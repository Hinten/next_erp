/**
 * Pure-unit tests for the classifiers of `reconcileByRecibo`'s
 * 104-without-our-protNFe branch (#513).
 *
 * No mocks: `classifyCStat` runs REAL, so these tables pin the library's
 * categories as each classifier sees them. Besides the named tables, a sweep
 * over the whole 3/4-digit cStat space (NT 2025.002 widened `cStat` to 3 or 4
 * digits) proves each non-default answer is given for exactly the listed codes
 * and for nothing else.
 */
import { describe, expect, it } from 'vitest';

import type { TRetConsReciNFe } from '@delfrance/integrations-nfe';

import {
  classificarConsSitDeRecuperacao,
  isLoteProcessadoSemProtocolo,
  loteSemRespostaParaAChave,
} from '../../../lib/nfe/orchestrator/lote-sem-protocolo';

type ProtNFe = NonNullable<TRetConsReciNFe['protNFe']>[number];

// cUF + AAMM + zeroed CNPJ + mod + série + nNF + tpEmis + cNF + cDV — 44 digits.
const CHAVE =
  '35' + '2609' + '00000000000000' + '55' + '001' + '000000001' + '1' + '00000001' + '0';

function prot(cStat: string): ProtNFe {
  return {
    versao: '4.00',
    infProt: {
      tpAmb: '2',
      verAplic: 'TEST',
      chNFe: CHAVE,
      dhRecbto: '2026-09-24T10:00:00-03:00',
      nProt: '135260000000001',
      cStat,
      xMotivo: 'motivo',
    },
  };
}

/** Every cStat of width 3 or 4: '000'..'999' and '1000'..'9999'. */
const TODOS_OS_CSTAT = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(3, '0'));

describe('classificarConsSitDeRecuperacao', () => {
  it.each(['100', '150', '101', '151', '102', '110', '301', '302', '217'])(
    'cStat %s → resolvida',
    (cStat) => {
      expect(classificarConsSitDeRecuperacao(cStat)).toBe('resolvida');
    },
  );

  it.each(['108', '109', '113', '114'])('cStat %s → indisponivel', (cStat) => {
    expect(classificarConsSitDeRecuperacao(cStat)).toBe('indisponivel');
  });

  it.each([
    // J04–J06: the número exists at SEFAZ under another chave.
    '561',
    '562',
    '613',
    // rejeitada-ambiente / -schema / -certificado.
    '252',
    '215',
    '225',
    '280',
    '297',
    // duplicidade.
    '204',
    '205',
    '218',
    '539',
    '635',
    // consumo indevido.
    '656',
    // lote-level codes have no business in a consSit reply.
    '103',
    '104',
    '105',
    '106',
    '107',
  ])('cStat %s → sem-resolucao', (cStat) => {
    expect(classificarConsSitDeRecuperacao(cStat)).toBe('sem-resolucao');
  });

  // Near-misses of the one rejection that resolves: 217 must stay the ONLY one.
  it.each([
    ['216', 'the rejection just below'],
    ['218', 'the neighbour above — duplicidade (já cancelada)'],
    ['2170', 'the 4-digit width NT 2025.002 allows'],
  ])('cStat %s (%s) → sem-resolucao, unlike 217', (cStat) => {
    expect(classificarConsSitDeRecuperacao('217')).toBe('resolvida');
    expect(classificarConsSitDeRecuperacao(cStat)).toBe('sem-resolucao');
  });

  it('over the whole 3/4-digit space, resolvida and indisponivel are exactly the listed codes', () => {
    const resolvida = TODOS_OS_CSTAT.filter(
      (c) => classificarConsSitDeRecuperacao(c) === 'resolvida',
    );
    const indisponivel = TODOS_OS_CSTAT.filter(
      (c) => classificarConsSitDeRecuperacao(c) === 'indisponivel',
    );
    expect(resolvida).toEqual(['100', '101', '102', '110', '150', '151', '217', '301', '302']);
    expect(indisponivel).toEqual(['108', '109', '113', '114']);
  });
});

describe('loteSemRespostaParaAChave', () => {
  it.each(['103', '106', '107', '108', '109', '113', '114'])(
    'lote cStat %s → true (keeps the counter)',
    (cStat) => {
      expect(loteSemRespostaParaAChave(cStat)).toBe(true);
    },
  );

  it.each(['104', '105', '656', '100', '204', '225', '252', '999'])(
    'lote cStat %s → false',
    (cStat) => {
      expect(loteSemRespostaParaAChave(cStat)).toBe(false);
    },
  );

  it('over the whole 3/4-digit space, true is exactly 103/106/107/108/109/113/114', () => {
    expect(TODOS_OS_CSTAT.filter((c) => loteSemRespostaParaAChave(c))).toEqual([
      '103',
      '106',
      '107',
      '108',
      '109',
      '113',
      '114',
    ]);
  });
});

describe('isLoteProcessadoSemProtocolo', () => {
  it('104 with no protNFe for our chave → true', () => {
    expect(isLoteProcessadoSemProtocolo({ cStat: '104' }, null)).toBe(true);
  });

  it('104 carrying our protNFe → false', () => {
    expect(isLoteProcessadoSemProtocolo({ cStat: '104' }, prot('100'))).toBe(false);
  });

  it.each(['103', '105', '106', '108', '656', '100'])(
    'lote cStat %s with no protNFe → false (not a processed lote)',
    (cStat) => {
      expect(isLoteProcessadoSemProtocolo({ cStat }, null)).toBe(false);
    },
  );
});
