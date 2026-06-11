import { describe, it, expect } from 'vitest';
import { ESTADO_NFE } from '@delfrance/schemas';
import {
  applyOutcome,
  classifyCStat,
  cStatToEstado,
  CSTAT_EPEC_DUPLICIDADE,
  CSTAT_EPEC_NAO_SINCRONIZADO,
  EPEC_EVENT_REGISTRADO,
  MAX_LOTE_POLL_RETRIES,
  nextAction,
  resolveTpEmis,
} from '../../src/state/index';

describe('classifyCStat', () => {
  it.each([
    ['100', 'autorizada'],
    ['150', 'autorizada'],
    ['101', 'cancelada'],
    ['102', 'inutilizada'],
    ['103', 'lote-recebido'],
    ['104', 'lote-processado'],
    ['105', 'lote-pendente'],
    ['106', 'lote-nao-localizado'],
    ['107', 'servico-em-operacao'],
    ['108', 'servico-paralisado'],
    ['109', 'servico-paralisado'],
    ['113', 'servico-paralisado'],
    ['114', 'servico-paralisado'],
    ['110', 'denegada'],
    ['204', 'duplicidade'],
    ['205', 'duplicidade'],
    ['218', 'duplicidade'],
    ['252', 'rejeitada-ambiente'],
    ['280', 'rejeitada-certificado'],
    ['290', 'rejeitada-certificado'],
    ['298', 'rejeitada-certificado'],
    ['301', 'denegada'],
    ['302', 'denegada'],
    ['539', 'duplicidade'],
    ['635', 'duplicidade'],
    ['656', 'consumo-indevido'],
    ['215', 'rejeitada-schema'],
    ['225', 'rejeitada-schema'],
    ['999', 'rejeitada'],
  ] as const)('classifies %s as %s', (cStat, expected) => {
    expect(classifyCStat(cStat)).toBe(expected);
  });
});

describe('cStatToEstado', () => {
  it('100 → aprovada', () => {
    expect(cStatToEstado('100')).toBe(ESTADO_NFE.aprovada);
  });
  it('103 (lote-recebido) → aguardandoResposta', () => {
    expect(cStatToEstado('103')).toBe(ESTADO_NFE.aguardandoResposta);
  });
  it('105 (lote-pendente) → aguardandoResposta', () => {
    expect(cStatToEstado('105')).toBe(ESTADO_NFE.aguardandoResposta);
  });
  it('110 (denegada) → rejeitada', () => {
    expect(cStatToEstado('110')).toBe(ESTADO_NFE.rejeitada);
  });
  it('656 (consumo indevido) → error', () => {
    expect(cStatToEstado('656')).toBe(ESTADO_NFE.error);
  });
  it('204 (duplicidade) carries no terminal estado on its own', () => {
    expect(cStatToEstado('204')).toBe(null);
  });
});

describe('nextAction', () => {
  it('100 → done-authorized', () => {
    expect(nextAction('100', 0)).toBe('done-authorized');
  });
  it('204 → recover-via-consulta', () => {
    expect(nextAction('204', 0)).toBe('recover-via-consulta');
  });
  it('103 → poll-lote', () => {
    expect(nextAction('103', 0)).toBe('poll-lote');
  });
  it('105 polls while retries below cap', () => {
    expect(nextAction('105', 0)).toBe('poll-lote');
    expect(nextAction('105', MAX_LOTE_POLL_RETRIES - 1)).toBe('poll-lote');
  });
  it('105 backs off once cap reached', () => {
    expect(nextAction('105', MAX_LOTE_POLL_RETRIES)).toBe('backoff');
  });
  it('rejeição com cStat fora dos buckets conhecidos → done-rejected', () => {
    expect(nextAction('999', 0)).toBe('done-rejected');
  });
  it('656 (consumo indevido) → backoff', () => {
    expect(nextAction('656', 0)).toBe('backoff');
  });
});

describe('applyOutcome', () => {
  it('autorização stamps aprovada and resets retries', () => {
    const patch = applyOutcome(
      { estado: ESTADO_NFE.aguardandoResposta, retries: 2 },
      { cStat: '100', xMotivo: 'Autorizado o uso da NF-e' },
    );
    expect(patch).toEqual({
      estado: ESTADO_NFE.aprovada,
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      retries: 0,
      nRec: null,
      action: 'done-authorized',
    });
  });

  it('lote pendente (105) increments retries', () => {
    const patch = applyOutcome(
      { estado: ESTADO_NFE.aguardandoResposta, retries: 1 },
      { cStat: '105', xMotivo: 'Lote em processamento' },
    );
    expect(patch.estado).toBe(ESTADO_NFE.aguardandoResposta);
    expect(patch.retries).toBe(2);
    expect(patch.action).toBe('poll-lote');
  });

  it('duplicidade preserva nRec extraído', () => {
    const patch = applyOutcome(
      { estado: ESTADO_NFE.enviando, retries: 0 },
      {
        cStat: '204',
        xMotivo: 'Rejeição: Duplicidade de NF-e [nRec:351000000000000]',
        nRec: '351000000000000',
      },
    );
    expect(patch.action).toBe('recover-via-consulta');
    expect(patch.nRec).toBe('351000000000000');
    expect(patch.estado).toBe(ESTADO_NFE.enviando);
  });

  it('rejeição genérica → estado rejeitada', () => {
    const patch = applyOutcome(
      { estado: ESTADO_NFE.enviando, retries: 0 },
      { cStat: '999', xMotivo: 'Rejeição: motivo desconhecido' },
    );
    expect(patch.estado).toBe(ESTADO_NFE.rejeitada);
    expect(patch.action).toBe('done-rejected');
  });

  it('retries default to 0 when current value is null', () => {
    const patch = applyOutcome(
      { estado: ESTADO_NFE.aguardandoResposta, retries: null },
      { cStat: '105', xMotivo: 'Lote em processamento' },
    );
    expect(patch.retries).toBe(1);
  });
});

describe('resolveTpEmis', () => {
  it('mode none → 1 for any UF', () => {
    expect(resolveTpEmis('SP')).toBe(1);
    expect(resolveTpEmis('PR', 'none')).toBe(1);
  });

  it("mode 'svc' resolves per UF — SP (SVC-AN) → 6", () => {
    expect(resolveTpEmis('SP', 'svc')).toBe(6);
    expect(resolveTpEmis('MG', 'svc')).toBe(6);
  });

  it("mode 'svc' resolves per UF — PR (SVC-RS) → 7", () => {
    expect(resolveTpEmis('PR', 'svc')).toBe(7);
    expect(resolveTpEmis('BA', 'svc')).toBe(7);
  });

  it("mode 'epec' → 4 for ANY UF (the evento goes to the Ambiente Nacional)", () => {
    expect(resolveTpEmis('SP', 'epec')).toBe(4);
    expect(resolveTpEmis('PR', 'epec')).toBe(4);
    expect(resolveTpEmis('AM', 'epec')).toBe(4);
  });
});

describe('EPEC constants', () => {
  it('135 AND 136 both register the EPEC (legacy parity — unlike CC-e, where 136 rejects)', () => {
    expect(EPEC_EVENT_REGISTRADO.has('135')).toBe(true);
    expect(EPEC_EVENT_REGISTRADO.has('136')).toBe(true);
    expect(EPEC_EVENT_REGISTRADO.size).toBe(2);
  });

  it('468 = EPEC não sincronizado (keep estado p + retry); 485 = duplicidade de EPEC', () => {
    expect(CSTAT_EPEC_NAO_SINCRONIZADO).toBe('468');
    expect(CSTAT_EPEC_DUPLICIDADE).toBe('485');
  });
});
