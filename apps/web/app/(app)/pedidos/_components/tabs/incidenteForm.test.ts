import { describe, expect, it } from 'vitest';
import {
  TIPO_INCIDENTE,
  TIPO_RESOLUCAO,
  resolucaoSchema,
  type Incidente,
} from '@delfrance/schemas';
import {
  EMPTY_INCIDENTE_FORM,
  buildResolucao,
  formFromIncidente,
  incidenteDataFromForm,
  isResolucaoLocked,
  validateIncidenteForm,
  type IncidenteFormState,
} from './incidenteForm';

const NOW = 1_700_000_000_000_000; // µs epoch

function form(overrides: Partial<IncidenteFormState> = {}): IncidenteFormState {
  return { ...EMPTY_INCIDENTE_FORM, ...overrides };
}

describe('buildResolucao', () => {
  it('returns null when the switch is off', () => {
    expect(buildResolucao(form({ registrarResolucao: false }), null, NOW)).toBeNull();
  });

  it('builds a Resolucao that parses against the schema', () => {
    const res = buildResolucao(
      form({
        registrarResolucao: true,
        resTipo: String(TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente),
        resValor: 12.5,
        resComentarios: 'reembolso total',
      }),
      null,
      NOW,
    );
    expect(res).toEqual({
      tipo: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
      data: NOW,
      valor: 12.5,
      comentarios: 'reembolso total',
      frete: null,
    });
    expect(resolucaoSchema.safeParse(res).success).toBe(true);
  });

  it('defaults data to `now` and valor to 0, and coerces empty comentários to null', () => {
    const res = buildResolucao(
      form({ registrarResolucao: true, resTipo: String(TIPO_RESOLUCAO.outro) }),
      null,
      NOW,
    );
    expect(res).toMatchObject({ data: NOW, valor: 0, comentarios: null });
  });

  it('keeps an explicit resData instead of `now`', () => {
    const res = buildResolucao(
      form({
        registrarResolucao: true,
        resTipo: String(TIPO_RESOLUCAO.itemDevolvido),
        resData: 42,
      }),
      null,
      NOW,
    );
    expect(res?.data).toBe(42);
  });

  it('preserves the deferred frete sub-object from the base doc', () => {
    const base = {
      resolucao: { tipo: TIPO_RESOLUCAO.etiquetaDeDevolucao, frete: { estado: 'iniciado' } },
    } as unknown as Incidente;
    const res = buildResolucao(
      form({ registrarResolucao: true, resTipo: String(TIPO_RESOLUCAO.outro) }),
      base,
      NOW,
    );
    expect(res?.frete).toEqual({ estado: 'iniciado' });
  });

  it('preserves the existing resolução verbatim when locked (frete past iniciado)', () => {
    const locked = {
      resolucao: {
        tipo: TIPO_RESOLUCAO.itemDevolvido,
        valor: 9,
        frete: { estado: 'enviado' },
      },
    } as unknown as Incidente;
    // Even with the switch off, a locked resolução is never cleared.
    const res = buildResolucao(form({ registrarResolucao: false }), locked, NOW);
    expect(res).toBe(locked.resolucao);
  });
});

describe('isResolucaoLocked', () => {
  it('is false without a frete, or while the frete is iniciado', () => {
    expect(isResolucaoLocked(null)).toBe(false);
    expect(isResolucaoLocked({ resolucao: null } as unknown as Incidente)).toBe(false);
    expect(
      isResolucaoLocked({
        resolucao: { frete: { estado: 'iniciado' } },
      } as unknown as Incidente),
    ).toBe(false);
  });

  it('is true once the frete moved past iniciado', () => {
    expect(
      isResolucaoLocked({
        resolucao: { frete: { estado: 'entregue' } },
      } as unknown as Incidente),
    ).toBe(true);
  });
});

describe('validateIncidenteForm', () => {
  it('passes when no resolução is recorded', () => {
    expect(validateIncidenteForm(form({ registrarResolucao: false }))).toBeNull();
  });

  it('requires a tipo de resolução when the switch is on', () => {
    expect(validateIncidenteForm(form({ registrarResolucao: true, resTipo: '' }))).toMatch(/tipo/i);
  });

  it('rejects a negative despesa', () => {
    expect(
      validateIncidenteForm(
        form({ registrarResolucao: true, resTipo: String(TIPO_RESOLUCAO.outro), resValor: -1 }),
      ),
    ).toMatch(/negativa/i);
  });

  it('passes a valid resolução', () => {
    expect(
      validateIncidenteForm(
        form({ registrarResolucao: true, resTipo: String(TIPO_RESOLUCAO.outro), resValor: 0 }),
      ),
    ).toBeNull();
  });
});

describe('incidenteDataFromForm', () => {
  it('maps the incident fields and spreads the base doc (preserving externalId)', () => {
    const base = { externalId: 'X-1', timestamp: 5 } as unknown as Incidente;
    const data = incidenteDataFromForm(
      form({ tipo: TIPO_INCIDENTE.troca, origem: '4', motivo: 'defeito', comentarios: '  ' }),
      base,
      NOW,
    );
    expect(data).toMatchObject({
      externalId: 'X-1',
      timestamp: 5,
      tipo: TIPO_INCIDENTE.troca,
      origem: 4,
      motivoDoIncidente: 'defeito',
      comentarios: null,
      resolucao: null,
    });
  });

  it('includes the built resolução when the switch is on', () => {
    const data = incidenteDataFromForm(
      form({
        registrarResolucao: true,
        resTipo: String(TIPO_RESOLUCAO.enviadoOutroItem),
        resValor: 3,
      }),
      null,
      NOW,
    );
    expect(data.resolucao).toMatchObject({ tipo: TIPO_RESOLUCAO.enviadoOutroItem, valor: 3 });
  });
});

describe('formFromIncidente', () => {
  it('round-trips an incident with a resolução back into form state', () => {
    const inc = {
      tipo: TIPO_INCIDENTE.devolucao,
      origem: 2,
      motivoDoIncidente: 'atraso',
      comentarios: null,
      resolucao: {
        tipo: TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
        data: 99,
        valor: 7.5,
        comentarios: 'parcial',
        frete: null,
      },
    } as unknown as Incidente;
    expect(formFromIncidente(inc)).toEqual({
      tipo: TIPO_INCIDENTE.devolucao,
      origem: '2',
      motivo: 'atraso',
      comentarios: '',
      registrarResolucao: true,
      resTipo: String(TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente),
      resData: 99,
      resValor: 7.5,
      resComentarios: 'parcial',
    });
  });
});
