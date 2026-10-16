import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { INTEGRACAO_FRETE, TIPOS_ALVO_MAPA_FRETE_LI } from '@delfrance/schemas';
import {
  DELETE_MARK,
  type TransactionDocumentGuard,
  type TransactionWriteContext,
} from '@delfrance/ui';

/**
 * The pure half of the Loja Integrada conta's freight tabs (step 20, #1826):
 * one row edit (`aplicarAlvoLi`) and the save's sibling write
 * (`escritasFreteDaContaLi`) — the latter also COMPOSED with the real
 * `saveRecord` over the shared OCC engine, because the guard it builds is only
 * worth what `saveRecord` does with it: a concurrent change must abort the save
 * with nothing written.
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
}));

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => ({
      exists: () => h.docs.has(path),
      data: () => structuredClone(h.docs.get(path)),
    }),
  };
}

vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => docRef(`int_frete/${id}`),
  },
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
}));

const {
  CAMPO_HORARIO_CORTE_LI,
  CAMPO_MAPA_FRETE_LI,
  aplicarAlvoLi,
  escritasFreteDaContaLi,
  problemasDoFreteDaContaLi,
  rotuloServicoMelhorEnvioLi,
  valoresDoFreteDaContaLi,
} = await import('./freteDaConta');
const { RecordConflictError, saveRecord } = await import('@delfrance/ui/src/object/saveRecord');

const db = {} as never;
const FRETE = 'lojaIntegrada-conta-1';
const FRETE_PATH = `int_frete/${FRETE}`;
const CONTA_PATH = 'integracao/conta-1';

/** A schema-complete, unmapped row. */
const LINHA_A: Doc = {
  nomeOriginal: 'Forma A',
  idOriginal: '1001---A',
  observacao: 'Origem: Pedido 1',
  nomeTarget: null,
  targetData: null,
  integracaoUid: null,
  targetTipoIntegracao: 'outros',
};
/** A row mapped to Melhor Envio, with a service and an unknown legacy key. */
const LINHA_ME: Doc = {
  nomeOriginal: 'Forma B',
  idOriginal: '1001---B',
  observacao: 'Origem: Pedido 2',
  nomeTarget: 'Transportadora — Expresso',
  targetData: { id: 7, name: 'Expresso', company: { id: 3, name: 'Transportadora' } },
  integracaoUid: 'me-conta',
  targetTipoIntegracao: 'melhorEnvios',
  chaveLegada: { manter: true },
};
const HORARIO: Doc[] = [
  {
    diaDaSemana: 1,
    horaDeCorte: 16,
    minutosDeCorte: 0,
    prazoDePostagem: 0,
    horaPostagem: 18,
    minutosPostagem: 0,
  },
];

const SERVICO = { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } };

/** A guard's projections, by form field. */
function projecoes(
  guard: TransactionDocumentGuard,
): Record<string, TransactionDocumentGuard['toFormValue']> {
  return Object.fromEntries(
    [guard, ...(guard.extraFormFields ?? [])].map((p) => [p.formField, p.toFormValue]),
  );
}

function contexto(baseline: Doc | null | undefined): TransactionWriteContext {
  return { getBaseline: (path) => (path === FRETE_PATH ? baseline : undefined) };
}

describe('aplicarAlvoLi — one operator edit of one row', () => {
  it('a non-Melhor Envio target stores the bare id and its tipo, and CLEARS a previous service', () => {
    const r = aplicarAlvoLi(LINHA_ME, { id: 'moto-1', tipo: INTEGRACAO_FRETE.motoboy });
    expect(r).toEqual({
      ok: true,
      linha: {
        ...LINHA_ME,
        integracaoUid: 'moto-1',
        targetTipoIntegracao: 'motoboy',
        targetData: null,
        nomeTarget: null,
      },
    });
  });

  it('keeps every other key verbatim — the method, its observation and unknown legacy keys', () => {
    const r = aplicarAlvoLi(LINHA_ME, null);
    if (!r.ok) throw new Error('expected ok');
    expect(r.linha.nomeOriginal).toBe('Forma B');
    expect(r.linha.idOriginal).toBe('1001---B');
    expect(r.linha.observacao).toBe('Origem: Pedido 2');
    expect(r.linha.chaveLegada).toEqual({ manter: true });
  });

  it('"Nenhum" stores the cleared form: null uid, tipo outros, no service, no label', () => {
    const r = aplicarAlvoLi(LINHA_ME, null);
    if (!r.ok) throw new Error('expected ok');
    expect(r.linha).toMatchObject({
      integracaoUid: null,
      targetTipoIntegracao: 'outros',
      targetData: null,
      nomeTarget: null,
    });
  });

  it('(M35) ⛔ a Melhor Envio target WITHOUT a service is refused, and the row is not touched', () => {
    expect(aplicarAlvoLi(LINHA_A, { id: 'me-conta', tipo: INTEGRACAO_FRETE.melhorEnvios })).toEqual(
      { ok: false, motivo: 'servico-obrigatorio' },
    );
    expect(
      aplicarAlvoLi(LINHA_A, {
        id: 'me-conta',
        tipo: INTEGRACAO_FRETE.melhorEnvios,
        servico: null,
      }),
    ).toEqual({ ok: false, motivo: 'servico-obrigatorio' });
  });

  it('a Melhor Envio target with a service stores { id, name, company } and a readable label', () => {
    const r = aplicarAlvoLi(LINHA_A, {
      id: 'me-conta',
      tipo: INTEGRACAO_FRETE.melhorEnvios,
      servico: SERVICO,
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.linha).toMatchObject({
      integracaoUid: 'me-conta',
      targetTipoIntegracao: 'melhorEnvios',
      targetData: { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
      nomeTarget: 'Correios — PAC',
    });
  });

  it('(M34) ⛔ a tipo outside the targets is refused — a marketplace freight is never a target', () => {
    for (const tipo of [
      INTEGRACAO_FRETE.mercadoLivre,
      INTEGRACAO_FRETE.shopee,
      INTEGRACAO_FRETE.lojaIntegrada,
      '',
      'MOTOBOY',
    ]) {
      expect(aplicarAlvoLi(LINHA_A, { id: 'x', tipo, servico: SERVICO })).toEqual({
        ok: false,
        motivo: 'tipo-nao-suportado',
      });
    }
  });

  it('NEAR-MISS of the refusal: every listed target tipo IS accepted', () => {
    for (const tipo of TIPOS_ALVO_MAPA_FRETE_LI) {
      expect(aplicarAlvoLi(LINHA_A, { id: 'x', tipo, servico: SERVICO }).ok).toBe(true);
    }
  });

  it('a row with no string idOriginal stays read-only', () => {
    expect(aplicarAlvoLi({ ...LINHA_A, idOriginal: null }, null)).toEqual({
      ok: false,
      motivo: 'linha-sem-chave',
    });
  });

  it('labels a service as "empresa — serviço", falling back to the id', () => {
    expect(rotuloServicoMelhorEnvioLi(SERVICO)).toBe('Correios — PAC');
    expect(rotuloServicoMelhorEnvioLi({ id: 9, name: null, company: null })).toBe('9');
  });
});

describe('valoresDoFreteDaContaLi — the two seeded form values', () => {
  it('takes mapa and horarioDeCorte VERBATIM, a wrongly shaped mapa included', () => {
    const mapaEmMapa = { a: LINHA_A };
    expect(valoresDoFreteDaContaLi({ mapa: mapaEmMapa, horarioDeCorte: HORARIO })).toEqual({
      [CAMPO_MAPA_FRETE_LI]: mapaEmMapa,
      [CAMPO_HORARIO_CORTE_LI]: HORARIO,
    });
    expect(valoresDoFreteDaContaLi(null)).toEqual({
      [CAMPO_MAPA_FRETE_LI]: null,
      [CAMPO_HORARIO_CORTE_LI]: null,
    });
  });
});

describe('escritasFreteDaContaLi — the conta save’s sibling write', () => {
  const baseline: Doc = { tipo: 'lojaIntegrada', mapa: [LINHA_A, LINHA_ME], horarioDeCorte: null };

  it('(M33) zero writes when neither field changed', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A, LINHA_ME], [CAMPO_HORARIO_CORTE_LI]: null };
    expect(escritasFreteDaContaLi(db, FRETE, values, contexto(baseline))).toEqual([]);
  });

  it('writes ONLY the changed field, guarded by the seeded baseline', () => {
    const editada = { ...LINHA_A, integracaoUid: 'moto-1', targetTipoIntegracao: 'motoboy' };
    const values = { [CAMPO_MAPA_FRETE_LI]: [editada, LINHA_ME], [CAMPO_HORARIO_CORTE_LI]: null };
    const [write, ...resto] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    expect(resto).toEqual([]);
    expect(write?.type).toBe('update');
    expect(write?.ref.path).toBe(FRETE_PATH);
    expect(write?.type === 'delete' ? null : Object.keys(write?.data ?? {})).toEqual(['mapa']);
    expect(write?.guard?.baseline).toBe(baseline);
  });

  it('a horário-only edit writes only horarioDeCorte', () => {
    const values = {
      [CAMPO_MAPA_FRETE_LI]: [LINHA_A, LINHA_ME],
      [CAMPO_HORARIO_CORTE_LI]: HORARIO,
    };
    const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    expect(write?.type === 'delete' ? null : write?.data).toEqual({ horarioDeCorte: HORARIO });
  });

  it('both edited ⇒ one write with both fields', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: HORARIO };
    const writes = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.type === 'delete' ? null : writes[0]?.data).toEqual({
      mapa: [LINHA_A],
      horarioDeCorte: HORARIO,
    });
  });

  it('⚠️ the guard projects BOTH tabs, whichever field the save writes', () => {
    // A rebase moves the whole doc's baseline; a tab it did not project would keep
    // a value that baseline no longer matches, and the next save would write it.
    for (const values of [
      { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: null },
      { [CAMPO_MAPA_FRETE_LI]: [LINHA_A, LINHA_ME], [CAMPO_HORARIO_CORTE_LI]: HORARIO },
      { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: HORARIO },
    ]) {
      const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
      expect(Object.keys(projecoes(write!.guard!)).sort()).toEqual(
        [CAMPO_HORARIO_CORTE_LI, CAMPO_MAPA_FRETE_LI].sort(),
      );
    }
  });

  it('a field this save did NOT write shows the server value after a rebase', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: null };
    const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    const atual = { ...baseline, horarioDeCorte: HORARIO };
    expect(projecoes(write!.guard!)[CAMPO_HORARIO_CORTE_LI]!(atual, null)).toEqual(HORARIO);
  });

  it('EQUAL pair: a written field that did NOT collide keeps the form value (reload keeps the edit)', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: HORARIO };
    const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    // Only the horário moved on the server: the mapa edit is uncontested.
    const atual = { ...baseline, horarioDeCorte: [{ ...HORARIO[0], horaDeCorte: 10 }] };
    expect(projecoes(write!.guard!)[CAMPO_MAPA_FRETE_LI]!(atual, ['meu'])).toEqual(['meu']);
  });

  it('⚠️ NEAR-MISS: a written field that COLLIDED shows the server value', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: HORARIO };
    const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    const remoto = [{ ...HORARIO[0], horaDeCorte: 10 }];
    const atual = { ...baseline, horarioDeCorte: remoto };
    expect(projecoes(write!.guard!)[CAMPO_HORARIO_CORTE_LI]!(atual, HORARIO)).toEqual(remoto);
  });

  it('a deleted doc shows null in both tabs', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: HORARIO };
    const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    const p = projecoes(write!.guard!);
    expect(p[CAMPO_MAPA_FRETE_LI]!(null, ['meu'])).toBeNull();
    expect(p[CAMPO_HORARIO_CORTE_LI]!(null, HORARIO)).toBeNull();
  });

  it('never writes a wrongly shaped stored mapa it seeded verbatim', () => {
    const emMapa = { a: LINHA_A };
    const values = { [CAMPO_MAPA_FRETE_LI]: emMapa, [CAMPO_HORARIO_CORTE_LI]: null };
    expect(
      escritasFreteDaContaLi(db, FRETE, values, contexto({ mapa: emMapa, horarioDeCorte: null })),
    ).toEqual([]);
  });

  it('no doc ⇒ no write: no id, or a baseline that confirmed the doc absent', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: null };
    expect(escritasFreteDaContaLi(db, null, values, contexto(baseline))).toEqual([]);
    expect(escritasFreteDaContaLi(db, FRETE, values, contexto(null))).toEqual([]);
  });

  it('not seeded: nothing to write while both values are null, and an UNGUARDED write never leaves', () => {
    const vazio = { [CAMPO_MAPA_FRETE_LI]: null, [CAMPO_HORARIO_CORTE_LI]: null };
    expect(escritasFreteDaContaLi(db, FRETE, vazio, contexto(undefined))).toEqual([]);
    const comValor = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: null };
    const [write] = escritasFreteDaContaLi(db, FRETE, comValor, contexto(undefined));
    // Carried with an UNDEFINED baseline, which `saveRecord` refuses outright.
    expect(write?.guard).toBeDefined();
    expect(write?.guard?.baseline).toBeUndefined();
  });
});

describe('problemasDoFreteDaContaLi — the horário rule runs only on what the save writes', () => {
  const SEGUNDA = HORARIO[0]!;
  const duplicado = [SEGUNDA, SEGUNDA];

  /** The form as seeded from `horario`, with the mapa untouched. */
  function semeado(horario: unknown) {
    const baseline: Doc = { tipo: 'lojaIntegrada', mapa: [LINHA_A], horarioDeCorte: horario };
    return {
      contexto: contexto(baseline),
      valores: (atual: unknown, mapa: unknown = [LINHA_A]) => ({
        [CAMPO_MAPA_FRETE_LI]: mapa,
        [CAMPO_HORARIO_CORTE_LI]: atual,
      }),
    };
  }

  it.each([
    ['a weekday stored twice', duplicado],
    ['a cut-off hour out of range', [{ ...SEGUNDA, horaDeCorte: 30 }]],
    ['a weekday stored as text', [{ ...SEGUNDA, diaDaSemana: 'segunda' }]],
    ['a value that is not a list', { 1: SEGUNDA }],
  ])('an untouched stored horário is never judged: %s', (_c, horario) => {
    const { contexto: ctx, valores } = semeado(horario);
    // A structurally equal COPY, as the form holds it — never the same reference.
    expect(problemasDoFreteDaContaLi(db, FRETE, valores(structuredClone(horario)), ctx)).toEqual(
      [],
    );
    // …not even when the save writes the OTHER tab.
    expect(
      problemasDoFreteDaContaLi(db, FRETE, valores(structuredClone(horario), []), ctx),
    ).toEqual([]);
  });

  it('⚠️ NEAR-MISS: one changed hour in a list that keeps its duplicate is judged WHOLE', () => {
    const { contexto: ctx, valores } = semeado(duplicado);
    const editado = [{ ...SEGUNDA, horaDeCorte: 15 }, SEGUNDA];
    expect(problemasDoFreteDaContaLi(db, FRETE, valores(editado), ctx)).toEqual([
      { path: `${CAMPO_HORARIO_CORTE_LI}.1.diaDaSemana`, message: 'Dia da semana duplicado' },
    ]);
  });

  it('⚠️ NEAR-MISS: an out-of-range hour the operator typed is refused, keyed under the tab’s field', () => {
    const { contexto: ctx, valores } = semeado(HORARIO);
    const problemas = problemasDoFreteDaContaLi(
      db,
      FRETE,
      valores([{ ...SEGUNDA, horaDeCorte: 30 }]),
      ctx,
    );
    expect(problemas.map((p) => p.path)).toEqual([`${CAMPO_HORARIO_CORTE_LI}.0.horaDeCorte`]);
  });

  it('an edit that removes the duplicate passes', () => {
    const { contexto: ctx, valores } = semeado(duplicado);
    expect(problemasDoFreteDaContaLi(db, FRETE, valores([SEGUNDA]), ctx)).toEqual([]);
  });

  it('"changed" is the WRITE’s decision: judged exactly when escritasFreteDaContaLi writes it', () => {
    const { contexto: ctx, valores } = semeado(duplicado);
    for (const atual of [structuredClone(duplicado), [{ ...SEGUNDA, horaDeCorte: 15 }, SEGUNDA]]) {
      const escreve = escritasFreteDaContaLi(db, FRETE, valores(atual), ctx).some(
        (w) => w.type !== 'delete' && 'horarioDeCorte' in w.data,
      );
      const julgado = problemasDoFreteDaContaLi(db, FRETE, valores(atual), ctx).length > 0;
      expect(julgado).toBe(escreve);
    }
  });

  it('⚠️ "changed" holds on EITHER side of the save transform: an untouched list is untouched both ways', () => {
    // ObjectView hands `validate` the form with EVERY field's `prepareForSave`
    // applied, but `transactionWrites` only a DIRTY field's. The horário's
    // transform changes a stored list even untouched — it drops the
    // staged-deletion key and any row it marks, and turns `[]` into `null` — so
    // the same pristine list reaches the two transformed and as stored.
    for (const [guardado, transformado] of [
      [[{ ...SEGUNDA, [DELETE_MARK]: false }, SEGUNDA], duplicado],
      [[{ ...SEGUNDA, [DELETE_MARK]: true }, SEGUNDA, SEGUNDA], duplicado],
      [[], null],
    ] as const) {
      const { contexto: ctx, valores } = semeado(guardado);
      for (const atual of [structuredClone(guardado), structuredClone(transformado)]) {
        expect(problemasDoFreteDaContaLi(db, FRETE, valores(atual), ctx)).toEqual([]);
        expect(escritasFreteDaContaLi(db, FRETE, valores(atual), ctx)).toEqual([]);
      }
    }
  });

  it('writes the horário as the save transform leaves it: staged deletions dropped, an emptied list as null', () => {
    const TERCA = { ...SEGUNDA, diaDaSemana: 2 };
    const { contexto: ctx, valores } = semeado([SEGUNDA, TERCA]);
    const dados = (atual: unknown) =>
      escritasFreteDaContaLi(db, FRETE, valores(atual), ctx).map((w) =>
        w.type === 'delete' ? null : w.data,
      );
    expect(
      dados([
        { ...SEGUNDA, [DELETE_MARK]: true },
        { ...TERCA, [DELETE_MARK]: false },
      ]),
    ).toEqual([{ horarioDeCorte: [TERCA] }]);
    expect(
      dados([
        { ...SEGUNDA, [DELETE_MARK]: true },
        { ...TERCA, [DELETE_MARK]: true },
      ]),
    ).toEqual([{ horarioDeCorte: null }]);
  });

  it('no doc, or no write, ⇒ nothing to judge', () => {
    const editado = { [CAMPO_MAPA_FRETE_LI]: null, [CAMPO_HORARIO_CORTE_LI]: duplicado };
    expect(problemasDoFreteDaContaLi(db, null, editado, contexto(null))).toEqual([]);
    expect(problemasDoFreteDaContaLi(db, FRETE, editado, contexto(null))).toEqual([]);
  });
});

describe('escritasFreteDaContaLi × saveRecord — what reaches the store', () => {
  const CONTA: Doc = { tipo: 3, nome: 'Conta 1', ultimaModificacao: 1 };
  const SEMEADO: Doc = {
    tipo: 'lojaIntegrada',
    nome: 'Conta 1',
    mapa: [LINHA_A, LINHA_ME],
    horarioDeCorte: null,
    ultimaModificacao: 10,
  };
  const contaCollection = {
    docRef: () => docRef(CONTA_PATH),
    resolvePath: () => 'integracao',
    converter: {},
  } as never;
  const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;

  beforeEach(() => {
    h.docs.clear();
    h.docs.set(CONTA_PATH, structuredClone(CONTA));
    h.docs.set(FRETE_PATH, structuredClone(SEMEADO));
    h.occ = new OccEngine({
      applyWrite: (kind, path, data) => {
        const prev = h.docs.get(path) ?? {};
        h.docs.set(path, kind === 'update' ? { ...prev, ...structuredClone(data) } : data);
      },
    });
  });

  function salvar(baseline: Doc, mapa: unknown, horario: unknown = null, contaDirty = {}) {
    const values = { [CAMPO_MAPA_FRETE_LI]: mapa, [CAMPO_HORARIO_CORTE_LI]: horario };
    return saveRecord({
      db,
      collection: contaCollection,
      pathContext: {},
      recordId: 'conta-1',
      values: { ...CONTA },
      dirtyFields: contaDirty,
      currentUserUid: 'u1',
      baseline: CONTA,
      stampUnit: 'ms',
      createdAtField: false,
      modifiedAtField: 'ultimaModificacao',
      siblingWrites: () => escritasFreteDaContaLi(db, FRETE, values, contexto(baseline)),
    });
  }

  const motoboy = (linha: Doc): Doc => ({
    ...linha,
    integracaoUid: 'moto-1',
    targetTipoIntegracao: 'motoboy',
    targetData: null,
    nomeTarget: null,
  });

  it('a freight-only save writes ONLY the int_frete doc — the conta, its stamp included, stays', async () => {
    await salvar(SEMEADO, [motoboy(LINHA_A), LINHA_ME]);
    expect(h.docs.get(CONTA_PATH)).toEqual(CONTA);
    expect(h.docs.get(FRETE_PATH)?.mapa).toEqual([motoboy(LINHA_A), LINHA_ME]);
    // The other row, the scalar fields and the stored stamp are untouched.
    expect(h.docs.get(FRETE_PATH)).toMatchObject({ nome: 'Conta 1', ultimaModificacao: 10 });
  });

  it('(a) a remote change to the same field since load ⇒ conflict, and NOTHING is written', async () => {
    const remoto = [LINHA_A, { ...LINHA_ME, integracaoUid: 'outra' }];
    h.docs.set(FRETE_PATH, { ...SEMEADO, mapa: remoto });
    const err = await salvar(SEMEADO, [motoboy(LINHA_A), LINHA_ME]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordConflictError);
    expect((err as InstanceType<typeof RecordConflictError>).documents[0]?.fields).toEqual([
      'mapa',
    ]);
    expect(h.docs.get(FRETE_PATH)?.mapa).toEqual(remoto);
    expect(commits()).toBe(0);
  });

  it('the importer appending a newly seen method since load ⇒ conflict; the append survives', async () => {
    const nova: Doc = { ...LINHA_A, idOriginal: '1002---null', nomeOriginal: 'Forma C' };
    h.docs.set(FRETE_PATH, { ...SEMEADO, mapa: [LINHA_A, LINHA_ME, nova] });
    const err = await salvar(SEMEADO, [motoboy(LINHA_A), LINHA_ME]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordConflictError);
    expect(h.docs.get(FRETE_PATH)?.mapa).toEqual([LINHA_A, LINHA_ME, nova]);
  });

  it('NEAR-MISS: a remote change to a field this save does NOT write commits without a conflict', async () => {
    h.docs.set(FRETE_PATH, { ...SEMEADO, horarioDeCorte: HORARIO });
    const r = await salvar(SEMEADO, [motoboy(LINHA_A), LINHA_ME]);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual(HORARIO);
    expect(h.docs.get(FRETE_PATH)?.mapa).toEqual([motoboy(LINHA_A), LINHA_ME]);
    // …and the NEXT save: the commit rebases onto the stored doc, the remote
    // horário included, and projects it into the horário tab — so the form
    // equals the new baseline and nothing is written back.
    const doc = r.documents[0]!;
    const p = projecoes(doc.guard);
    const proximo = {
      [CAMPO_MAPA_FRETE_LI]: p[CAMPO_MAPA_FRETE_LI]!(doc.data, [motoboy(LINHA_A), LINHA_ME]),
      [CAMPO_HORARIO_CORTE_LI]: p[CAMPO_HORARIO_CORTE_LI]!(doc.data, null),
    };
    expect(proximo[CAMPO_HORARIO_CORTE_LI]).toEqual(HORARIO);
    expect(escritasFreteDaContaLi(db, FRETE, proximo, contexto(doc.data))).toEqual([]);
  });

  it('(d) save, edit the same row, save: the rebased baseline raises no conflict', async () => {
    const primeiro = await salvar(SEMEADO, [motoboy(LINHA_A), LINHA_ME]);
    // What ObjectView rebases onto after a commit: the committed document.
    const rebased = primeiro.documents[0]?.data as Doc;
    await salvar(rebased, [{ ...motoboy(LINHA_A), integracaoUid: 'moto-2' }, LINHA_ME]);
    expect((h.docs.get(FRETE_PATH)?.mapa as Doc[])[0]?.integracaoUid).toBe('moto-2');
  });

  it('(i) a raw mapa whose rows fail the row schema keeps EVERY row through a save', async () => {
    const cru = [{ idOriginal: '1003---X' }, 'lixo', LINHA_A, { ...LINHA_ME, extra: 1 }];
    h.docs.set(FRETE_PATH, { ...SEMEADO, mapa: cru });
    const editado = cru.map((l, i) => (i === 2 ? motoboy(LINHA_A) : l));
    await salvar({ ...SEMEADO, mapa: cru }, editado);
    const guardado = h.docs.get(FRETE_PATH)?.mapa as unknown[];
    expect(guardado).toHaveLength(cru.length);
    expect(guardado[0]).toEqual(cru[0]);
    expect(guardado[1]).toBe('lixo');
    expect(guardado[3]).toEqual(cru[3]);
  });
});
