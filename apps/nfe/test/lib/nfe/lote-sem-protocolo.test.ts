/**
 * Pure-unit tests for the classifiers of `reconcileByRecibo`'s one decision per
 * `consReciNFe` round (#513, #1654).
 *
 * No mocks: `classifyCStat` runs REAL, so these tables pin the library's
 * categories as each classifier sees them. Besides the named tables, a sweep
 * over the whole 3/4-digit cStat space (NT 2025.002 widened `cStat` to 3 or 4
 * digits) proves each answer is given for exactly the listed codes and for
 * nothing else.
 */
import { describe, expect, it } from 'vitest';

import { isBloqueada, type NFeStatePatch } from '@delfrance/integrations-nfe';
import { ESTADO_NFE } from '@delfrance/schemas';

import { markAsLost } from '../../../lib/nfe/orchestrator/audit';
import {
  classificarConsSitDeRecuperacao,
  cStatBloqueanteDaRodada,
  decidirRodadaDoRecibo,
  type DecisaoDaRodada,
  type MotivoConsultaPorChave,
  motivoPorChave,
  terminalBloqueante,
} from '../../../lib/nfe/orchestrator/lote-sem-protocolo';

/** Every cStat of width 3 or 4: '000'..'999' and '1000'..'9999'. */
const TODOS_OS_CSTAT = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(3, '0'));

const MOTIVOS: readonly MotivoConsultaPorChave[] = [
  'protocolo-ausente',
  'lote-nao-localizado',
  'duplicidade',
  'aguardando-processamento',
];

/** The decision, as a comparable string (`por-chave:<motivo>` for a by-chave one). */
function rotulo(d: DecisaoDaRodada): string {
  return d.tipo === 'por-chave' ? `por-chave:${d.motivo}` : d.tipo;
}

describe('decidirRodadaDoRecibo — our protNFe is in the receipt (protCStat present)', () => {
  it.each([
    // Final answers for the chave: applied as today.
    ['100', 'aplicar-protocolo'],
    ['150', 'aplicar-protocolo'],
    ['101', 'aplicar-protocolo'],
    ['151', 'aplicar-protocolo'],
    ['102', 'aplicar-protocolo'],
    ['110', 'aplicar-protocolo'],
    ['301', 'aplicar-protocolo'],
    ['302', 'aplicar-protocolo'],
    ['215', 'aplicar-protocolo'],
    ['225', 'aplicar-protocolo'],
    ['252', 'aplicar-protocolo'],
    ['280', 'aplicar-protocolo'],
    ['297', 'aplicar-protocolo'],
    ['217', 'aplicar-protocolo'],
    ['562', 'aplicar-protocolo'],
    // Near-misses of the duplicidade codes — 4-digit rejections, applied.
    ['2040', 'aplicar-protocolo'],
    ['6350', 'aplicar-protocolo'],
    ['5390', 'aplicar-protocolo'],
    // 539 keeps its own recovery.
    ['539', 'recuperar-539'],
    // The other duplicidades are resolved by chave.
    ['204', 'por-chave:duplicidade'],
    ['205', 'por-chave:duplicidade'],
    ['218', 'por-chave:duplicidade'],
    ['635', 'por-chave:aguardando-processamento'],
    ['656', 'terminal'],
    // A lote-state code inside a protNFe says nothing final about the chave.
    ['103', 'por-chave:protocolo-ausente'],
    ['104', 'por-chave:protocolo-ausente'],
    ['105', 'por-chave:protocolo-ausente'],
    ['106', 'por-chave:protocolo-ausente'],
    ['107', 'por-chave:protocolo-ausente'],
    ['108', 'por-chave:protocolo-ausente'],
    ['109', 'por-chave:protocolo-ausente'],
    ['113', 'por-chave:protocolo-ausente'],
    ['114', 'por-chave:protocolo-ausente'],
  ])('protNFe cStat %s → %s (whatever the lote cStat)', (protCStat, esperado) => {
    for (const loteCStat of ['104', '105', '108', '656', '']) {
      expect(rotulo(decidirRodadaDoRecibo(loteCStat, protCStat))).toBe(esperado);
    }
  });

  it('over the whole 3/4-digit space, only the listed protNFe cStats leave aplicar-protocolo', () => {
    const naoAplicadas = TODOS_OS_CSTAT.filter(
      (c) => decidirRodadaDoRecibo('104', c).tipo !== 'aplicar-protocolo',
    );
    expect(naoAplicadas).toEqual([
      '103',
      '104',
      '105',
      '106',
      '107',
      '108',
      '109',
      '113',
      '114',
      '204',
      '205',
      '218',
      '539',
      '635',
      '656',
    ]);
  });
});

describe('decidirRodadaDoRecibo — no protNFe for our chave (protCStat null)', () => {
  it.each([
    // Says nothing about any chave: wait for the next round (counted).
    ['103', 'aguardar'],
    ['105', 'aguardar'],
    ['107', 'aguardar'],
    ['108', 'aguardar'],
    ['109', 'aguardar'],
    ['113', 'aguardar'],
    ['114', 'aguardar'],
    // Not TStat-shaped — an anomaly, never a verdict.
    ['', 'aguardar'],
    ['abc', 'aguardar'],
    ['10', 'aguardar'],
    ['10400', 'aguardar'],
    // A processed lote without our protNFe (#513).
    ['104', 'por-chave:protocolo-ausente'],
    ['106', 'por-chave:lote-nao-localizado'],
    // A per-NF-e verdict at LOTE level never lands without a protocol.
    ['100', 'por-chave:protocolo-ausente'],
    ['150', 'por-chave:protocolo-ausente'],
    ['101', 'por-chave:protocolo-ausente'],
    ['151', 'por-chave:protocolo-ausente'],
    ['102', 'por-chave:protocolo-ausente'],
    ['110', 'por-chave:protocolo-ausente'],
    ['301', 'por-chave:protocolo-ausente'],
    ['302', 'por-chave:protocolo-ausente'],
    ['539', 'recuperar-539'],
    ['204', 'por-chave:duplicidade'],
    ['205', 'por-chave:duplicidade'],
    ['218', 'por-chave:duplicidade'],
    ['635', 'por-chave:aguardando-processamento'],
    ['656', 'terminal'],
    // The consReci query itself was refused.
    ['252', 'terminal'],
    ['215', 'terminal'],
    ['225', 'terminal'],
    ['280', 'terminal'],
    ['297', 'terminal'],
    ['217', 'terminal'],
    ['999', 'terminal'],
    ['1040', 'terminal'],
  ])('lote cStat %s → %s', (loteCStat, esperado) => {
    expect(rotulo(decidirRodadaDoRecibo(loteCStat, null))).toBe(esperado);
  });

  it('over the whole 3/4-digit space, aguardar / por-chave / recuperar-539 are exactly the listed codes; everything else is terminal', () => {
    const por = (tipo: DecisaoDaRodada['tipo']): string[] =>
      TODOS_OS_CSTAT.filter((c) => decidirRodadaDoRecibo(c, null).tipo === tipo);
    expect(por('aguardar')).toEqual(['103', '105', '107', '108', '109', '113', '114']);
    expect(por('por-chave')).toEqual([
      '100',
      '101',
      '102',
      '104',
      '106',
      '110',
      '150',
      '151',
      '204',
      '205',
      '218',
      '301',
      '302',
      '635',
    ]);
    expect(por('recuperar-539')).toEqual(['539']);
    expect(por('aplicar-protocolo')).toEqual([]);
    expect(por('terminal')).toHaveLength(
      TODOS_OS_CSTAT.length - 7 - 14 - 1, // every other TStat-shaped code
    );
  });
});

describe('motivoPorChave', () => {
  it.each([
    ['106', 'lote-nao-localizado'],
    ['204', 'duplicidade'],
    ['205', 'duplicidade'],
    ['218', 'duplicidade'],
    ['635', 'aguardando-processamento'],
  ])('cStat %s → %s', (cStat, motivo) => {
    expect(motivoPorChave(cStat)).toBe(motivo);
  });

  it.each(['539', '104', '100', '217', '656', '2040', '6350', '1060', ''])(
    'cStat %s → null (539 keeps its own recovery)',
    (cStat) => {
      expect(motivoPorChave(cStat)).toBeNull();
    },
  );

  it('over the whole 3/4-digit space, non-null exactly for 106/204/205/218/635', () => {
    expect(TODOS_OS_CSTAT.filter((c) => motivoPorChave(c) != null)).toEqual([
      '106',
      '204',
      '205',
      '218',
      '635',
    ]);
  });
});

describe('classificarConsSitDeRecuperacao', () => {
  describe.each(MOTIVOS)('motivo %s', (motivo) => {
    it.each(['100', '150', '101', '151', '102'])('cStat %s → resolvida', (cStat) => {
      expect(classificarConsSitDeRecuperacao(cStat, motivo)).toBe('resolvida');
    });

    it.each(['108', '109', '113', '114'])('cStat %s → indisponivel', (cStat) => {
      expect(classificarConsSitDeRecuperacao(cStat, motivo)).toBe('indisponivel');
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
      // Near-misses of 217 — only 217 itself is special.
      '216',
      '2170',
    ])('cStat %s → sem-resolucao', (cStat) => {
      expect(classificarConsSitDeRecuperacao(cStat, motivo)).toBe('sem-resolucao');
    });
  });

  it.each<[MotivoConsultaPorChave, string]>([
    // The número is free (MOC 7.0 p.84 J03): re-emittable.
    ['protocolo-ausente', 'resolvida'],
    ['lote-nao-localizado', 'resolvida'],
    // 539 is facultative — the número may be taken under ANOTHER chave.
    ['duplicidade', 'sem-resolucao'],
    // 635: the NF-e is still queued at SEFAZ — wait and poll.
    ['aguardando-processamento', 'pendente'],
  ])('217 for motivo %s → %s', (motivo, esperado) => {
    expect(classificarConsSitDeRecuperacao('217', motivo)).toBe(esperado);
  });

  it.each<[MotivoConsultaPorChave, string]>([
    // Unchanged from #513: applied (it lands as rejeitada).
    ['protocolo-ausente', 'resolvida'],
    // The new motivos: the número is consumed (cstat-rejeicoes.md "Denial").
    ['lote-nao-localizado', 'sem-resolucao'],
    ['duplicidade', 'sem-resolucao'],
    ['aguardando-processamento', 'sem-resolucao'],
  ])('denegada (110/301/302) for motivo %s → %s', (motivo, esperado) => {
    for (const cStat of ['110', '301', '302']) {
      expect(classificarConsSitDeRecuperacao(cStat, motivo)).toBe(esperado);
    }
  });

  it('over the whole 3/4-digit space, each motivo resolves / waits / is unavailable for exactly the listed codes', () => {
    const conjunto = (motivo: MotivoConsultaPorChave, r: string): string[] =>
      TODOS_OS_CSTAT.filter((c) => classificarConsSitDeRecuperacao(c, motivo) === r);
    expect(conjunto('protocolo-ausente', 'resolvida')).toEqual([
      '100',
      '101',
      '102',
      '110',
      '150',
      '151',
      '217',
      '301',
      '302',
    ]);
    expect(conjunto('lote-nao-localizado', 'resolvida')).toEqual([
      '100',
      '101',
      '102',
      '150',
      '151',
      '217',
    ]);
    for (const motivo of ['duplicidade', 'aguardando-processamento'] as const) {
      expect(conjunto(motivo, 'resolvida')).toEqual(['100', '101', '102', '150', '151']);
    }
    for (const motivo of MOTIVOS) {
      expect(conjunto(motivo, 'indisponivel')).toEqual(['108', '109', '113', '114']);
      expect(conjunto(motivo, 'pendente')).toEqual(
        motivo === 'aguardando-processamento' ? ['217'] : [],
      );
    }
  });
});

describe('cStatBloqueanteDaRodada', () => {
  it.each(['103', '104', '105'])('lote cStat %s is kept (already blocking)', (cStat) => {
    expect(cStatBloqueanteDaRodada(cStat)).toBe(cStat);
    expect(isBloqueada(cStatBloqueanteDaRodada(cStat))).toBe(true);
  });

  it.each(['106', '108', '656', '204', '1040', '100', '252', ''])(
    'lote cStat %s → 103 (SEFAZ issued the receipt)',
    (cStat) => {
      expect(cStatBloqueanteDaRodada(cStat)).toBe('103');
      expect(isBloqueada(cStatBloqueanteDaRodada(cStat))).toBe(true);
    },
  );

  it('over the whole 3/4-digit space, only 103/104/105 map to themselves', () => {
    expect(TODOS_OS_CSTAT.filter((c) => cStatBloqueanteDaRodada(c) === c)).toEqual([
      '103',
      '104',
      '105',
    ]);
  });
});

describe('terminalBloqueante', () => {
  function patchCom(cStat: string): NFeStatePatch {
    return {
      estado: ESTADO_NFE.aguardandoResposta,
      cStat,
      xMotivo: `motivo ${cStat}`,
      retries: 7,
      nRec: 'REC-1',
      action: 'poll-lote',
      tMed: null,
    };
  }

  it.each(['103', '104', '105'])(
    'a blocking round cStat (%s) → byte-identical to markAsLost (today’s 105-cap / #513 terminal)',
    (cStat) => {
      const patch = patchCom(cStat);
      expect(terminalBloqueante(patch, cStat, 'verificar manualmente')).toEqual(
        markAsLost(patch, 'verificar manualmente'),
      );
    },
  );

  it('a non-blocking cStat → 103 with the original cStat as an xMotivo prefix', () => {
    const t = terminalBloqueante(
      patchCom('108'),
      '108',
      'após 10 consultas — verificar manualmente',
    );
    expect(t).toEqual({
      estado: ESTADO_NFE.error,
      cStat: '103',
      xMotivo: 'cStat 108: motivo 108 | após 10 consultas — verificar manualmente',
      retries: 7,
      nRec: 'REC-1',
      action: 'poll-lote',
      tMed: null,
    });
    expect(isBloqueada(t.cStat)).toBe(true);
  });

  it('near-miss: the patch already carries the blocking cStat the round maps to → no prefix', () => {
    // A 104 round whose patch is the lote’s 104: nothing changes, nothing is prefixed.
    const t = terminalBloqueante(patchCom('104'), '104', 'x');
    expect(t.xMotivo).toBe('motivo 104 | x');
    // The same patch in a round whose lote said 656: the cStat changes, so it is prefixed.
    const u = terminalBloqueante(patchCom('104'), '656', 'x');
    expect(u).toMatchObject({ cStat: '103', xMotivo: 'cStat 104: motivo 104 | x' });
  });
});
