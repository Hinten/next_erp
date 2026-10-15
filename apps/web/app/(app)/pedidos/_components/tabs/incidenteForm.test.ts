import { describe, expect, it } from 'vitest';
import {
  ESTADO_FRETE,
  ORIGEM_INCIDENTE,
  STATUS_CLAIM,
  TIPO_INCIDENTE,
  TIPO_RESOLUCAO,
  resolucaoSchema,
  type EstadoFrete,
  type Incidente,
} from '@delfrance/schemas';
import {
  CAMPOS_AUTORAIS_INCIDENTE,
  EMPTY_INCIDENTE_FORM,
  ORIGEM_EXCLUSIVA_MSG,
  buildIncidentePatch,
  buildResolucao,
  detectIncidenteConflict,
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

  it('trims surrounding whitespace on the saved text fields', () => {
    const data = incidenteDataFromForm(
      form({ motivo: '  defeito  ', comentarios: '\tnota\n' }),
      null,
      NOW,
    );
    expect(data).toMatchObject({ motivoDoIncidente: 'defeito', comentarios: 'nota' });
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

/* -------------------------------------------------------------------------- */
/*                    Update path — patch + conflict (#1250)                  */
/* -------------------------------------------------------------------------- */

function incidente(overrides: Partial<Incidente> = {}): Incidente {
  return {
    origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
    tipo: TIPO_INCIDENTE.devolucao,
    motivoDoIncidente: 'Motivo original',
    comentarios: 'Comentário original',
    timestamp: 1,
    ultimaModificacao: 1,
    externalId: '9001',
    resolucao: null,
    claimStatus: STATUS_CLAIM.aberta,
    claimStage: null,
    entregue: null,
    ...overrides,
  } as Incidente;
}

function comFrete(estado: EstadoFrete): NonNullable<Incidente['resolucao']> {
  return {
    data: 10,
    valor: 0,
    tipo: TIPO_RESOLUCAO.etiquetaDeDevolucao,
    comentarios: null,
    frete: { estado },
  } as NonNullable<Incidente['resolucao']>;
}

/** The form as it looks right after `openEdit` on `doc` — i.e. untouched. */
const pristine = (doc: Incidente): IncidenteFormState => formFromIncidente(doc);

describe('buildIncidentePatch', () => {
  it('is empty for an untouched form — an unchanged field is never written', () => {
    const doc = incidente();
    expect(buildIncidentePatch(pristine(doc), doc, NOW)).toEqual({});
  });

  it('carries only the authored fields the operator actually changed', () => {
    const doc = incidente();
    const patch = buildIncidentePatch({ ...pristine(doc), motivo: 'Motivo novo' }, doc, NOW);
    expect(patch).toEqual({ motivoDoIncidente: 'Motivo novo' });
  });

  it('never carries a key outside CAMPOS_AUTORAIS_INCIDENTE', () => {
    const doc = incidente({ resolucao: comFrete(ESTADO_FRETE.iniciado) });
    const patch = buildIncidentePatch(
      { ...pristine(doc), tipo: TIPO_INCIDENTE.troca, origem: '', comentarios: 'x', resValor: 5 },
      doc,
      NOW,
    );
    // `claimStatus`, `claimStage`, `entregue`, `externalId`, `timestamp`,
    // `ultimaModificacao` and `overrideBloqueio` belong to other writers.
    for (const key of Object.keys(patch)) {
      expect(CAMPOS_AUTORAIS_INCIDENTE).toContain(key);
    }
    expect(patch).not.toHaveProperty('claimStatus');
    expect(patch).not.toHaveProperty('externalId');
  });

  it('omits resolucao entirely once the doc is locked, even with resolução edits pending', () => {
    const locked = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const patch = buildIncidentePatch(
      { ...pristine(locked), resValor: 99, resComentarios: 'tentativa' },
      locked,
      NOW,
    );
    expect(patch).not.toHaveProperty('resolucao');
  });

  it('carries resolucao while the frete is still iniciado, keeping the live frete', () => {
    const doc = incidente({ resolucao: comFrete(ESTADO_FRETE.iniciado) });
    const patch = buildIncidentePatch({ ...pristine(doc), resValor: 99 }, doc, NOW);
    expect(patch.resolucao).toMatchObject({ valor: 99, frete: { estado: ESTADO_FRETE.iniciado } });
  });
});

describe('detectIncidenteConflict', () => {
  it('reports no conflict when only a NON-authored field moved remotely', () => {
    const baseline = incidente();
    // Exactly what the ML claims webhook merges while the editor is open.
    const current = incidente({
      claimStatus: STATUS_CLAIM.fechada,
      claimStage: 'dispute',
      entregue: true,
      ultimaModificacao: 999,
    });
    const patch = buildIncidentePatch({ ...pristine(baseline), motivo: 'Novo' }, baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch)).toEqual({
      conflito: false,
      campos: [],
      bloqueouAgora: false,
    });
  });

  it('reports a conflict when an authored field this save writes moved remotely', () => {
    const baseline = incidente();
    const current = incidente({ motivoDoIncidente: 'Outra pessoa escreveu isto' });
    const patch = buildIncidentePatch({ ...pristine(baseline), motivo: 'Novo' }, baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch)).toMatchObject({
      conflito: true,
      campos: ['motivoDoIncidente'],
    });
  });

  it('ignores an authored field that moved remotely but is NOT in this patch', () => {
    const baseline = incidente();
    const current = incidente({ comentarios: 'nota de outra pessoa' });
    const patch = buildIncidentePatch({ ...pristine(baseline), motivo: 'Novo' }, baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch).conflito).toBe(false);
  });

  it('conflicts with bloqueouAgora when the lock arms over pending resolução edits', () => {
    const baseline = incidente({ resolucao: comFrete(ESTADO_FRETE.iniciado) });
    const current = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const patch = buildIncidentePatch({ ...pristine(baseline), resValor: 99 }, baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch)).toMatchObject({
      conflito: true,
      campos: ['resolucao'],
      bloqueouAgora: true,
    });
  });

  it('does NOT conflict when the lock arms and the operator never touched the resolução', () => {
    const baseline = incidente({ resolucao: comFrete(ESTADO_FRETE.iniciado) });
    const current = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const patch = buildIncidentePatch({ ...pristine(baseline), motivo: 'Novo' }, baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch)).toMatchObject({
      conflito: false,
      bloqueouAgora: true,
    });
    expect(patch).not.toHaveProperty('resolucao');
  });

  it('does not fire bloqueouAgora for a resolução that was ALREADY locked at capture', () => {
    const baseline = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const current = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const patch = buildIncidentePatch(pristine(baseline), baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch).bloqueouAgora).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*     The channel lock — origem/tipo of an IMPORTED incidente (#1525, R-16)   */
/* -------------------------------------------------------------------------- */

/** A Shopee return as the importer writes it (fixture return_sn, alphanumeric). */
const shopeeImportado = (overrides: Partial<Incidente> = {}): Incidente =>
  incidente({
    origem: ORIGEM_INCIDENTE.pedidoShopee,
    tipo: TIPO_INCIDENTE.devolucao,
    externalId: '260910ABCDE0001',
    ...overrides,
  });

/** A row a person typed: no marketplace origem, no id. */
const manual = (overrides: Partial<Incidente> = {}): Incidente =>
  incidente({
    origem: ORIGEM_INCIDENTE.outros,
    externalId: null,
    claimStatus: null,
    ...overrides,
  });

/** What an operator would do to lift the overlay: retype both fields. */
const retipado = (doc: Incidente): IncidenteFormState => ({
  ...pristine(doc),
  tipo: TIPO_INCIDENTE.troca,
  origem: String(ORIGEM_INCIDENTE.troca),
});

describe('buildIncidentePatch — the channel lock', () => {
  it.each([
    ['Shopee', shopeeImportado()],
    ['Mercado Livre', incidente()],
  ])(
    '⭐ W16: on an imported %s row, a retyped origem/tipo is DROPPED from the patch',
    (_canal, doc) => {
      const patch = buildIncidentePatch({ ...retipado(doc), motivo: 'Motivo novo' }, doc, NOW);
      expect(patch).not.toHaveProperty('origem');
      expect(patch).not.toHaveProperty('tipo');
      // The lock is scoped to those two: the rest of the edit still lands.
      expect(patch).toEqual({ motivoDoIncidente: 'Motivo novo' });
    },
  );

  it('⭐ NEAR MISS: the SAME retype on a manual row is written', () => {
    const doc = manual();
    expect(buildIncidentePatch(retipado(doc), doc, NOW)).toEqual({
      tipo: TIPO_INCIDENTE.troca,
      origem: ORIGEM_INCIDENTE.troca,
    });
  });

  it('NEAR MISS: a marketplace origem WITHOUT an id is a legacy hand-typed row — still editable', () => {
    const doc = shopeeImportado({ externalId: '  ' });
    expect(buildIncidentePatch(retipado(doc), doc, NOW)).toMatchObject({
      tipo: TIPO_INCIDENTE.troca,
      origem: ORIGEM_INCIDENTE.troca,
    });
  });

  it('`outros` (99) with an id — step 5’s produto rows — is NOT locked', () => {
    const doc = manual({ externalId: 'produto-1' });
    expect(buildIncidentePatch(retipado(doc), doc, NOW)).toHaveProperty('origem');
  });

  it('the lock reads the doc it is HANDED: built against a now-imported current, the keys drop', () => {
    // `saveIncidenteEdit` writes the intersection of the patch built against the
    // baseline and the one built against the tx-fresh doc — so a lock that arms
    // between the two drops the keys from the write without any extra check.
    const form = retipado(manual());
    expect(buildIncidentePatch(form, shopeeImportado(), NOW)).not.toHaveProperty('origem');
    expect(buildIncidentePatch(form, shopeeImportado(), NOW)).not.toHaveProperty('tipo');
  });
});

describe('detectIncidenteConflict — the channel lock', () => {
  it('never reports origem/tipo on an imported row, however both moved remotely', () => {
    const baseline = shopeeImportado();
    const current = shopeeImportado({
      origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
      tipo: TIPO_INCIDENTE.troca,
    });
    const patch = buildIncidentePatch(retipado(baseline), baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch)).toEqual({
      conflito: false,
      campos: [],
      bloqueouAgora: false,
    });
  });

  it('NEAR MISS: on a manual row the same remote move IS a conflict', () => {
    const baseline = manual();
    const current = manual({ tipo: TIPO_INCIDENTE.mediacaoDoMarketplace });
    const patch = buildIncidentePatch(retipado(baseline), baseline, NOW);
    expect(detectIncidenteConflict(baseline, current, patch)).toMatchObject({
      conflito: true,
      campos: ['tipo'],
    });
  });
});

describe('validateIncidenteForm — a marketplace origem is the importer’s', () => {
  it.each([ORIGEM_INCIDENTE.pedidoMercadoLivre, ORIGEM_INCIDENTE.pedidoShopee])(
    '⭐ refuses origem %s on CREATE',
    (origem) => {
      expect(validateIncidenteForm(form({ origem: String(origem) }), null)).toBe(
        ORIGEM_EXCLUSIVA_MSG,
      );
      // No doc given is the create rule — the loud direction.
      expect(validateIncidenteForm(form({ origem: String(origem) }))).toBe(ORIGEM_EXCLUSIVA_MSG);
    },
  );

  it('refuses hand-tagging a MANUAL row with one on edit', () => {
    expect(
      validateIncidenteForm(form({ origem: String(ORIGEM_INCIDENTE.pedidoShopee) }), manual()),
    ).toBe(ORIGEM_EXCLUSIVA_MSG);
  });

  it('refuses switching an imported row to the OTHER marketplace', () => {
    expect(
      validateIncidenteForm(
        form({ origem: String(ORIGEM_INCIDENTE.pedidoMercadoLivre) }),
        shopeeImportado(),
      ),
    ).toBe(ORIGEM_EXCLUSIVA_MSG);
  });

  it('⭐ NEAR MISS: editing a row that ALREADY holds that origem passes (the imported row itself)', () => {
    const doc = shopeeImportado();
    expect(validateIncidenteForm(pristine(doc), doc)).toBeNull();
    const ml = incidente();
    expect(validateIncidenteForm(pristine(ml), ml)).toBeNull();
  });

  it('NEAR MISS: every non-marketplace origem, and none, passes on create', () => {
    for (const origem of ['', '0', '1', '3', '4', '99']) {
      expect(validateIncidenteForm(form({ origem }), null)).toBeNull();
    }
  });

  it('the origem check runs before the resolução one — and the resolução rules still apply', () => {
    expect(
      validateIncidenteForm(
        form({ origem: String(ORIGEM_INCIDENTE.pedidoShopee), registrarResolucao: true }),
        null,
      ),
    ).toBe(ORIGEM_EXCLUSIVA_MSG);
    const doc = shopeeImportado();
    expect(
      validateIncidenteForm({ ...pristine(doc), registrarResolucao: true, resTipo: '' }, doc),
    ).toMatch(/tipo/i);
  });
});
