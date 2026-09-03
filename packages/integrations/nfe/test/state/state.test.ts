import { describe, it, expect } from 'vitest';
import { type EstadoNFe, ESTADO_NFE, UF_SIGLA } from '@delfrance/schemas';
import {
  ESTADOS_FINAIS_NFE,
  applyOutcome,
  classifyCStat,
  cStatToEstado,
  isEstadoFinalNFe,
  CSTAT_EPEC_DUPLICIDADE,
  CSTAT_EPEC_NAO_SINCRONIZADO,
  EPEC_EVENT_REGISTRADO,
  MAX_LOTE_POLL_RETRIES,
  MAX_RECONCILE_ATTEMPTS,
  nextAction,
  nextConsultaDelayMs,
  RECONCILE_BASE_DELAY_MS,
  RECONCILE_MAX_DELAY_MS,
  resolveTpEmis,
} from '../../src/state/index';

describe('classifyCStat', () => {
  it.each([
    ['100', 'autorizada'],
    ['150', 'autorizada'],
    ['101', 'cancelada'],
    ['151', 'cancelada'], // cancelamento homologado fora de prazo
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
  it('151 (cancelamento fora de prazo) → cancelada', () => {
    expect(cStatToEstado('151')).toBe(ESTADO_NFE.cancelada);
  });
});

describe('isEstadoFinalNFe', () => {
  it.each([
    ['0', false], // gerado
    ['1', false], // enviando
    ['2', false], // aguardandoResposta
    ['3', false], // processamentoCompleto
    ['4', false], // processamentoCancelado
    ['a', true], // aprovada
    ['p', false], // epecAprovado — the pós-EPEC transmit still pends
    ['n', false], // rejeitada — re-verifying is the feature's purpose
    ['c', true], // cancelada
    ['i', true], // numeracaoInutilizada
    ['e', false], // error — re-verifying is the feature's purpose
  ] as ReadonlyArray<[EstadoNFe, boolean]>)('%s → %s', (estado, expected) => {
    expect(isEstadoFinalNFe(estado)).toBe(expected);
    expect(ESTADOS_FINAIS_NFE.has(estado)).toBe(expected);
  });

  it('null / undefined are not final', () => {
    expect(isEstadoFinalNFe(null)).toBe(false);
    expect(isEstadoFinalNFe(undefined)).toBe(false);
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
      tMed: null,
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

  // Anti-regression defense: consSitNFe for a cancelada/inutilizada NF-e
  // still returns the ORIGINAL authorization protNFe (cStat 100) — an
  // autorizada outcome must never downgrade a final estado back to aprovada.
  describe('cancelada/inutilizada anti-regression defense', () => {
    it("cancelada + outcome 100 → stays 'c' done-terminal, keeping the provided cStat/xMotivo", () => {
      const patch = applyOutcome(
        {
          estado: ESTADO_NFE.cancelada,
          retries: 3,
          cStat: '101',
          xMotivo: 'Cancelamento de NF-e homologado',
        },
        { cStat: '100', xMotivo: 'Autorizado o uso da NF-e' },
      );
      expect(patch).toEqual({
        estado: ESTADO_NFE.cancelada,
        cStat: '101',
        xMotivo: 'Cancelamento de NF-e homologado',
        retries: 0,
        nRec: null,
        action: 'done-terminal',
        tMed: null,
      });
    });

    it("cancelada + outcome 100 WITHOUT current cStat/xMotivo → stays 'c' with the outcome's", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.cancelada, retries: 0 },
        { cStat: '100', xMotivo: 'Autorizado o uso da NF-e' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.cancelada);
      expect(patch.action).toBe('done-terminal');
      expect(patch.cStat).toBe('100');
    });

    it("inutilizada + outcome 100 → stays 'i' done-terminal", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.numeracaoInutilizada, retries: 0, cStat: '102', xMotivo: 'Inut' },
        { cStat: '100', xMotivo: 'Autorizado o uso da NF-e' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.numeracaoInutilizada);
      expect(patch.cStat).toBe('102');
      expect(patch.action).toBe('done-terminal');
    });

    it("cancelada + outcome 105 (lote-pendente) → stays 'c' done-terminal, no retry scheduled", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.cancelada, retries: 2, cStat: '101', xMotivo: 'Cancelamento' },
        { cStat: '105', xMotivo: 'Lote em processamento', tMed: '5' },
      );
      expect(patch).toEqual({
        estado: ESTADO_NFE.cancelada,
        cStat: '101',
        xMotivo: 'Cancelamento',
        retries: 0,
        nRec: null,
        action: 'done-terminal',
        tMed: null,
      });
    });

    it("cancelada + a business rejection → stays 'c' done-terminal", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.cancelada, retries: 0, cStat: '101', xMotivo: 'Cancelamento' },
        { cStat: '999', xMotivo: 'Rejeição: Erro não catalogado' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.cancelada);
      expect(patch.cStat).toBe('101');
      expect(patch.action).toBe('done-terminal');
    });

    it("inutilizada + outcome 656 (consumo indevido) → stays 'i' done-terminal", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.numeracaoInutilizada, retries: 0, cStat: '102', xMotivo: 'Inut' },
        { cStat: '656', xMotivo: 'Rejeição: Consumo Indevido' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.numeracaoInutilizada);
      expect(patch.cStat).toBe('102');
      expect(patch.action).toBe('done-terminal');
    });

    it("cancelada + outcome 204 (duplicidade, mapped-null) → stays 'c' done-terminal, never recover-via-consulta", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.cancelada, retries: 0, cStat: '101', xMotivo: 'Cancelamento' },
        { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e [nRec:351000000000123]' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.cancelada);
      expect(patch.action).toBe('done-terminal');
    });

    it("same-estado outcome flows through normally: cancelada + outcome 101 → 'c' with the outcome's cStat", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.cancelada, retries: 0, cStat: '999', xMotivo: 'stale' },
        { cStat: '101', xMotivo: 'Cancelamento de NF-e homologado' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.cancelada);
      expect(patch.cStat).toBe('101');
      expect(patch.xMotivo).toBe('Cancelamento de NF-e homologado');
      expect(patch.action).toBe('done-terminal');
    });

    it("forward transition stays allowed: aprovada + outcome 101 → 'c'", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.aprovada, retries: 0, cStat: '100', xMotivo: 'Autorizado' },
        { cStat: '101', xMotivo: 'Cancelamento de NF-e homologado' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.cancelada);
      expect(patch.cStat).toBe('101');
      expect(patch.action).toBe('done-terminal');
    });

    it("aprovada + outcome 204 (duplicidade, no estado of its own) → stays 'a'", () => {
      const patch = applyOutcome(
        { estado: ESTADO_NFE.aprovada, retries: 0, cStat: '100', xMotivo: 'Autorizado' },
        { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e [nRec:351000000000123]' },
      );
      expect(patch.estado).toBe(ESTADO_NFE.aprovada);
      expect(patch.cStat).toBe('204');
    });
  });
});

describe('nextConsultaDelayMs', () => {
  it('attempt 0 respects SEFAZ tMed (seconds → ms) when present', () => {
    expect(nextConsultaDelayMs(0, '3')).toBe(3000);
    expect(nextConsultaDelayMs(0, 5)).toBe(5000);
  });

  it('attempt 0 falls back to the base delay when tMed is absent/invalid', () => {
    expect(nextConsultaDelayMs(0)).toBe(RECONCILE_BASE_DELAY_MS);
    expect(nextConsultaDelayMs(0, null)).toBe(RECONCILE_BASE_DELAY_MS);
    expect(nextConsultaDelayMs(0, '0')).toBe(RECONCILE_BASE_DELAY_MS);
    expect(nextConsultaDelayMs(0, 'abc')).toBe(RECONCILE_BASE_DELAY_MS);
  });

  it('attempt 0 caps a huge tMed at the max delay', () => {
    expect(nextConsultaDelayMs(0, '99999')).toBe(RECONCILE_MAX_DELAY_MS);
  });

  it('later attempts back off exponentially (deterministic — base·2^n, capped)', () => {
    // Deterministic so the backstop due-gate (proximaConsultaEm) can be derived
    // from the same value and never drift ahead of the task (#77 review).
    for (const attempt of [1, 2, 3]) {
      const expected = Math.min(RECONCILE_BASE_DELAY_MS * 2 ** attempt, RECONCILE_MAX_DELAY_MS);
      expect(nextConsultaDelayMs(attempt)).toBe(expected);
      // Stable across calls — no random jitter.
      expect(nextConsultaDelayMs(attempt)).toBe(nextConsultaDelayMs(attempt));
    }
  });

  it('never exceeds the max delay even for large attempts', () => {
    for (const attempt of [8, 12, 20]) {
      expect(nextConsultaDelayMs(attempt)).toBe(RECONCILE_MAX_DELAY_MS);
    }
  });

  it('MAX_RECONCILE_ATTEMPTS is a sane positive cap', () => {
    expect(MAX_RECONCILE_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_RECONCILE_ATTEMPTS)).toBe(true);
  });
});

describe('resolveTpEmis', () => {
  it('mode none → 1 for any UF', () => {
    expect(resolveTpEmis(UF_SIGLA.SP)).toBe(1);
    expect(resolveTpEmis(UF_SIGLA.PR, 'none')).toBe(1);
  });

  it("mode 'svc' resolves per UF — SP (SVC-AN) → 6", () => {
    expect(resolveTpEmis(UF_SIGLA.SP, 'svc')).toBe(6);
    expect(resolveTpEmis(UF_SIGLA.MG, 'svc')).toBe(6);
  });

  it("mode 'svc' resolves per UF — PR (SVC-RS) → 7", () => {
    expect(resolveTpEmis(UF_SIGLA.PR, 'svc')).toBe(7);
    expect(resolveTpEmis(UF_SIGLA.BA, 'svc')).toBe(7);
  });

  it("mode 'epec' → 4 for ANY UF (the evento goes to the Ambiente Nacional)", () => {
    expect(resolveTpEmis(UF_SIGLA.SP, 'epec')).toBe(4);
    expect(resolveTpEmis(UF_SIGLA.PR, 'epec')).toBe(4);
    expect(resolveTpEmis(UF_SIGLA.AM, 'epec')).toBe(4);
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
