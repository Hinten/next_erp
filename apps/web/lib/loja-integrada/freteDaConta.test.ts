import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { INTEGRACAO_FRETE, TIPOS_ALVO_MAPA_FRETE_LI } from '@delfrance/schemas';
import type { TransactionWriteContext } from '@delfrance/ui';

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
    expect(write?.guard?.formField).toBe(CAMPO_MAPA_FRETE_LI);
  });

  it('a horário-only edit writes only horarioDeCorte, and its guard reloads that field', () => {
    const values = {
      [CAMPO_MAPA_FRETE_LI]: [LINHA_A, LINHA_ME],
      [CAMPO_HORARIO_CORTE_LI]: HORARIO,
    };
    const [write] = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    expect(write?.type === 'delete' ? null : write?.data).toEqual({ horarioDeCorte: HORARIO });
    expect(write?.guard?.formField).toBe(CAMPO_HORARIO_CORTE_LI);
    expect(write?.guard?.toFormValue({ horarioDeCorte: ['remoto'] }, null)).toEqual(['remoto']);
  });

  it('both edited ⇒ one write with both fields; the guard reloads the mapa', () => {
    const values = { [CAMPO_MAPA_FRETE_LI]: [LINHA_A], [CAMPO_HORARIO_CORTE_LI]: HORARIO };
    const writes = escritasFreteDaContaLi(db, FRETE, values, contexto(baseline));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.type === 'delete' ? null : writes[0]?.data).toEqual({
      mapa: [LINHA_A],
      horarioDeCorte: HORARIO,
    });
    expect(writes[0]?.guard?.toFormValue({ mapa: ['remoto'] }, null)).toEqual(['remoto']);
    expect(writes[0]?.guard?.toFormValue(null, ['local'])).toBeNull();
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
    await salvar(SEMEADO, [motoboy(LINHA_A), LINHA_ME]);
    expect(h.docs.get(FRETE_PATH)?.horarioDeCorte).toEqual(HORARIO);
    expect(h.docs.get(FRETE_PATH)?.mapa).toEqual([motoboy(LINHA_A), LINHA_ME]);
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
