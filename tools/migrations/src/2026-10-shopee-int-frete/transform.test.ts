import { readFileSync, type WriteStream } from 'node:fs';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  CAMPOS_SINCRONIZADOS,
  type DisposicaoIntFrete,
  type IntFreteEncontrado,
  type PlanoIntFrete,
  type SyncIntFreteConta,
} from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { ChangeSink, type BatchWriter, type MigrationContext } from '../runner';
import { run } from './backfill';
import {
  ROTULOS_CONTA,
  bloqueiaAplicacao,
  contaIdDoRef,
  contarDocsAlterados,
  divergeDoPlano,
  idsAExecutar,
  mensagemDeParada,
  paradasDoPlano,
  planejarPassagem,
  registrosDoPlano,
  resumirPassagem,
  syncShopee,
  type ContaEscaneada,
  type LinhaConta,
  type ParadasDoPlano,
  type PlanoDaPassagem,
} from './transform';

/* --------------------------------- fixtures ------------------------------- */

type Dados = Record<string, unknown>;

const V = VINCULO_INT_FRETE_CONTA;
const ID = 'int-1';
const OUTRO_ID = 'int-2';
const CANONICO = `documents/integracao/${ID}`;
const FILIAL = 'documents/filiais/f-1';
const CADASTRO = Date.parse('2026-01-05T10:00:00.000Z');
/** A stored `ultimaModificacao` — the core's stamp on a doc it already wrote once. */
const CARIMBO = Date.parse('2026-03-02T09:30:00.000Z');

const canonicoDe = (id: string): string => `documents/integracao/${id}`;

function conta(id = ID, over: Dados = {}): ContaEscaneada {
  return {
    id,
    data: {
      tipo: V.shopee.tipoConta,
      nome: 'Loja Teste',
      ativo: true,
      filialIntegracaoPedidoOuterRef: FILIAL,
      dataCadastro: CADASTRO,
      ...over,
    },
  };
}

/** A legacy `FreteShopee` doc as the import brings it: canonical back-ref, NO `ultimaModificacao`. */
function legado(id: string, over: Dados = {}, contaId = ID): IntFreteEncontrado {
  return {
    id,
    data: {
      tipo: V.shopee.tipoFrete,
      nome: 'Loja Teste',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      contaShopeeFreteOuterRef: canonicoDe(contaId),
      dataCadastro: CADASTRO,
      docId: id,
      ...over,
    },
  };
}

/** A doc the core already reconciled once (it carries the core's stamp). */
function carimbado(id: string, over: Dados = {}, contaId = ID): IntFreteEncontrado {
  return legado(id, { ultimaModificacao: CARIMBO, ...over }, contaId);
}

function planejar(contas: ContaEscaneada[], docs: IntFreteEncontrado[]): PlanoDaPassagem {
  return planejarPassagem({ contas, docs });
}

function linhaDe(plano: PlanoDaPassagem, id = ID): LinhaConta {
  const linha = plano.linhas.find((l) => l.integracaoId === id);
  if (linha == null) throw new Error(`no line for ${id}`);
  return linha;
}

/** The STOP verdict with every reason spelled out, empty unless given. */
function paradas(over: Partial<ParadasDoPlano> = {}): ParadasDoPlano {
  return { duplicados: [], naoCanonicos: [], compartilhados: [], ...over };
}

/* ------------------------------- the binding ------------------------------ */

describe('the binding — the trigger’s own, zero options', () => {
  it('binds the Shopee row of VINCULO_INT_FRETE_CONTA', () => {
    expect(syncShopee.vinculo).toBe(V.shopee);
  });

  it('has NO tolerant scan: a bare back-ref is never chosen', () => {
    const bare = legado('legacy-bare', { contaShopeeFreteOuterRef: `integracao/${ID}` });
    expect(syncShopee.escolherIntFreteDaConta([bare], ID)).toBeNull();
  });
});

/* ------------------------- the conta-id fold (scope) ---------------------- */

describe('contaIdDoRef — what it folds, and where it stops', () => {
  it('EQUAL: every stored form of ONE conta’s ref names that conta', () => {
    for (const ref of [
      CANONICO,
      `integracao/${ID}`,
      `/documents/integracao/${ID}`,
      `documents//integracao/${ID}/`,
    ]) {
      expect(contaIdDoRef(ref), ref).toBe(ID);
    }
  });

  it('DISTINCT: another conta, a deeper path, another collection, junk', () => {
    expect(contaIdDoRef(canonicoDe(OUTRO_ID))).toBe(OUTRO_ID);
    expect(contaIdDoRef(`documents/integracao/${ID}/sub/x`)).toBeNull();
    expect(contaIdDoRef(`documents/filiais/${ID}`)).toBeNull();
    expect(contaIdDoRef('documents/integracao')).toBeNull();
    for (const lixo of [null, undefined, 42, '', 'lixo']) {
      expect(contaIdDoRef(lixo), String(lixo)).toBeNull();
    }
  });
});

/* ------------------------------- T47 labels ------------------------------- */

describe('T47 every label, with executar per line', () => {
  it('criar — a complete conta with no doc: executable, at shopee-<id>', () => {
    const l = linhaDe(planejar([conta()], []));
    expect(l).toMatchObject({
      rotulo: 'criar',
      executar: true,
      intFreteId: `shopee-${ID}`,
      duplicados: [],
      naoCanonicos: [],
      de: null,
    });
    expect(l.para).toMatchObject({
      tipo: V.shopee.tipoFrete,
      contaShopeeFreteOuterRef: CANONICO,
      filialIntegracaoFreteOuterRef: FILIAL,
      dataCadastro: CADASTRO,
    });
  });

  it('incompleto — only when NO doc exists; not executable', () => {
    const semFilial = conta(ID, { filialIntegracaoPedidoOuterRef: null });
    const l = linhaDe(planejar([semFilial], []));
    expect(l).toMatchObject({ rotulo: 'incompleto', executar: false, intFreteId: null });
    expect(l.plano).toEqual({ acao: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] });

    // The same conta beside its doc: the stored filial survives, nothing to write.
    const comDoc = linhaDe(planejar([semFilial], [legado('legacy-1')]));
    expect(comDoc).toMatchObject({ rotulo: 'inalterado', executar: false });
  });

  it('a conta without dataCadastro whose doc matches otherwise ⇒ inalterado', () => {
    const l = linhaDe(planejar([conta(ID, { dataCadastro: null })], [legado('legacy-1')]));
    expect(l).toMatchObject({ rotulo: 'inalterado', executar: false, intFreteId: 'legacy-1' });
  });

  it('adotar — a legacy doc (no ultimaModificacao) that differs: executable', () => {
    const l = linhaDe(planejar([conta()], [legado('legacy-1', { nome: 'Nome Antigo' })]));
    expect(l).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: 'legacy-1',
      de: { nome: 'Nome Antigo' },
      para: { nome: 'Loja Teste' },
    });
  });

  it('atualizar — a doc the core already stamped that differs: executable', () => {
    const l = linhaDe(planejar([conta()], [carimbado('if-1', { nome: 'Nome Antigo' })]));
    expect(l).toMatchObject({ rotulo: 'atualizar', executar: true, intFreteId: 'if-1' });
  });

  it('a legacy doc already equal to its conta ⇒ inalterado, not executable (K2-F1)', () => {
    const l = linhaDe(planejar([conta()], [legado('legacy-1')]));
    expect(l).toMatchObject({ rotulo: 'inalterado', executar: false, intFreteId: 'legacy-1' });
    expect(l.de).toBeNull();
    expect(l.para).toBeNull();
  });

  it('duplicados — reported beside the chosen (newest) doc, never executed, and STOP', () => {
    const plano = planejar(
      [conta()],
      [
        legado('velho', { dataCadastro: CADASTRO - 1000, nome: 'Velho' }),
        legado('novo', { dataCadastro: CADASTRO + 1000, nome: 'Novo' }),
      ],
    );
    const l = linhaDe(plano);
    expect(l.intFreteId).toBe('novo');
    expect(l.duplicados).toEqual(['velho']);
    expect(l.plano).toMatchObject({ acao: 'atualizar', id: 'novo' });
    // The pass reconciles the CONTA; the duplicate's id is in no plan.
    expect(idsAExecutar(plano.linhas)).toEqual([ID]);
    expect(plano.linhas.some((x) => x.intFreteId === 'velho')).toBe(false);
    expect(paradasDoPlano(plano)).toEqual(paradas({ duplicados: [ID] }));
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(true);
  });

  it('duplicados on an EQUAL dataCadastro — the lexically lower id wins, whatever the scan order', () => {
    for (const docs of [
      [legado('dup-b'), legado('dup-a')],
      [legado('dup-a'), legado('dup-b')],
    ]) {
      const plano = planejar([conta()], docs);
      const ordem = docs.map((d) => d.id).join(',');
      expect(linhaDe(plano), ordem).toMatchObject({ intFreteId: 'dup-a', duplicados: ['dup-b'] });
      expect(linhaDe(plano).plano, ordem).toMatchObject({ id: 'dup-a' });
      expect(paradasDoPlano(plano), ordem).toEqual(paradas({ duplicados: [ID] }));
    }
  });

  it('near-miss: one ms newer beats the lower id — the id only breaks an EQUAL stamp', () => {
    const l = linhaDe(
      planejar([conta()], [legado('dup-a'), legado('dup-b', { dataCadastro: CADASTRO + 1 })]),
    );
    expect(l).toMatchObject({ intFreteId: 'dup-b', duplicados: ['dup-a'] });
  });

  it('incompleto — a malformed filial STRING degrades the conta, never aborts the pass', () => {
    // Only the imported corpus can carry one (the conta schema is a strict outerRef); the strict
    // `toOuterRef` would THROW here and take every other conta of the pass down with it.
    for (const filial of ['', 'filiais']) {
      const plano = planejar(
        [conta('int-x', { filialIntegracaoPedidoOuterRef: filial }), conta(ID)],
        [],
      );
      expect(linhaDe(plano, 'int-x'), JSON.stringify(filial)).toMatchObject({
        rotulo: 'incompleto',
        executar: false,
        intFreteId: null,
        plano: { acao: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] },
      });
      expect(linhaDe(plano), JSON.stringify(filial)).toMatchObject({
        rotulo: 'criar',
        executar: true,
      });

      // Beside its doc, the stored filial survives: nothing to write.
      const comDoc = linhaDe(
        planejar([conta(ID, { filialIntegracaoPedidoOuterRef: filial })], [legado('legacy-1')]),
      );
      expect(comDoc, JSON.stringify(filial)).toMatchObject({
        rotulo: 'inalterado',
        executar: false,
        de: null,
        para: null,
      });
    }
  });

  it('bloqueado-nao-canonico — only a bare back-ref: NOT executable, never planned beside it', () => {
    const plano = planejar(
      [conta()],
      [legado('legacy-bare', { contaShopeeFreteOuterRef: `integracao/${ID}` })],
    );
    const l = linhaDe(plano);
    expect(l).toEqual({
      integracaoId: ID,
      rotulo: 'bloqueado-nao-canonico',
      executar: false,
      intFreteId: null,
      plano: null,
      duplicados: [],
      naoCanonicos: ['legacy-bare'],
      compartilhadoCom: [],
      de: null,
      para: null,
    });
    expect(idsAExecutar(plano.linhas)).toEqual([]);
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
  });

  it('a non-canonical TWIN beside a canonical doc: labelled from the plan, and still STOP', () => {
    const plano = planejar(
      [conta()],
      [
        legado('legacy-1'),
        legado('twin', { contaShopeeFreteOuterRef: `/documents/integracao/${ID}` }),
      ],
    );
    const l = linhaDe(plano);
    expect(l).toMatchObject({ rotulo: 'inalterado', intFreteId: 'legacy-1' });
    expect(l.naoCanonicos).toEqual(['twin']);
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(true);
  });

  it('a bare ref naming ANOTHER conta does not block this one (near-miss)', () => {
    const plano = planejar(
      [conta()],
      [legado('alheio', { contaShopeeFreteOuterRef: `integracao/${OUTRO_ID}` })],
    );
    expect(linhaDe(plano)).toMatchObject({ rotulo: 'criar', naoCanonicos: [] });
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({
      rotulo: 'bloqueado-nao-canonico',
      naoCanonicos: ['alheio'],
    });
  });
});

/* ------------------------------- T48 orphans ------------------------------ */

describe('T48 orphans', () => {
  const BARE = `integracao/${ID}`;

  it('conta absent ⇒ desativar-orfao, executable', () => {
    const plano = planejar([], [carimbado('if-2', {}, OUTRO_ID)]);
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({
      rotulo: 'desativar-orfao',
      executar: true,
      intFreteId: 'if-2',
      de: { ativo: true },
      para: { ativo: false },
    });
  });

  it('conta present under ANOTHER tipo ⇒ desativar-orfao (the planner’s ehConta, K1-F5)', () => {
    const plano = planejar([conta(ID, { tipo: V.mercadoLivre.tipoConta })], [legado('legacy-1')]);
    expect(linhaDe(plano)).toMatchObject({ rotulo: 'desativar-orfao', executar: true });
  });

  it('an inactive orphan ⇒ orfao-inativo, not executed', () => {
    const plano = planejar([], [legado('legacy-2', { ativo: false }, OUTRO_ID)]);
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({ rotulo: 'orfao-inativo', executar: false });
    expect(idsAExecutar(plano.linhas)).toEqual([]);
  });

  it('the orphan’s shopee-<id> doc with a BARE ref ⇒ desativar-orfao writing only ativo, no STOP', () => {
    // The deterministic-id fallback chooses it, so it is never a twin; the deactivation leaves the
    // bare ref as stored (no conta remains to own it).
    const plano = planejar([], [carimbado(`shopee-${ID}`, { contaShopeeFreteOuterRef: BARE })]);
    const l = linhaDe(plano);
    expect(l).toMatchObject({
      rotulo: 'desativar-orfao',
      executar: true,
      intFreteId: `shopee-${ID}`,
      duplicados: [],
      naoCanonicos: [],
    });
    expect(l.plano).toEqual({ acao: 'desativar', id: `shopee-${ID}` });
    expect(l.para).toEqual({ ativo: false });
    expect(plano.refsIlegiveis).toEqual([]);
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('its inactive twin ⇒ orfao-inativo, not executed, no STOP', () => {
    const det = carimbado(`shopee-${ID}`, { contaShopeeFreteOuterRef: BARE, ativo: false });
    const plano = planejar([], [det]);
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'orfao-inativo',
      executar: false,
      intFreteId: `shopee-${ID}`,
      naoCanonicos: [],
      para: null,
    });
    expect(idsAExecutar(plano.linhas)).toEqual([]);
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('near-miss: the same bare orphan ref on an auto-id doc is bloqueado-nao-canonico, and STOP', () => {
    const plano = planejar([], [carimbado('legacy-bare', { contaShopeeFreteOuterRef: BARE })]);
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'bloqueado-nao-canonico',
      executar: false,
      naoCanonicos: ['legacy-bare'],
    });
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
  });

  it('ref-ilegivel — a back-ref naming no conta: reported as stored, never executed', () => {
    const plano = planejar(
      [],
      [
        legado('nulo', { contaShopeeFreteOuterRef: null }),
        { id: 'ausente', data: { tipo: V.shopee.tipoFrete, nome: 'X', ativo: true } },
        legado('lixo', { contaShopeeFreteOuterRef: 'lixo' }),
        legado('filial', { contaShopeeFreteOuterRef: FILIAL }),
      ],
    );
    expect(plano.linhas).toEqual([]);
    expect(plano.refsIlegiveis).toEqual([
      { intFreteId: 'nulo', ref: null },
      { intFreteId: 'ausente', ref: null },
      { intFreteId: 'lixo', ref: 'lixo' },
      { intFreteId: 'filial', ref: FILIAL },
    ]);
  });

  it('the deterministic-id doc with a blanked ref is CLAIMED by its conta, not ilegível', () => {
    const plano = planejar(
      [conta()],
      [carimbado(`shopee-${ID}`, { contaShopeeFreteOuterRef: null })],
    );
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'atualizar',
      executar: true,
      intFreteId: `shopee-${ID}`,
      para: { contaShopeeFreteOuterRef: CANONICO },
    });
    expect(plano.refsIlegiveis).toEqual([]);
  });

  it('a doc of another tipo is outside the pass (the scan’s own filter)', () => {
    const doML = { id: 'ml-1', data: { ...legado('ml-1').data, tipo: V.mercadoLivre.tipoFrete } };
    const plano = planejar([conta()], [doML]);
    expect(linhaDe(plano)).toMatchObject({ rotulo: 'criar', intFreteId: `shopee-${ID}` });
    expect(plano.refsIlegiveis).toEqual([]);
  });
});

/* ------------- T54 through the pass — the shopee-<id> doc, as chosen ------------- */

describe('T54 through planejarPassagem — the shopee-<id> doc is chosen as the reconcile chooses it', () => {
  const DET = `shopee-${ID}`;
  const BARE = `integracao/${ID}`;

  it('the det doc with a BARE ref: patched back to canonical, executable, and no STOP', () => {
    const docs = [carimbado(DET, { contaShopeeFreteOuterRef: BARE })];
    const plano = planejar([conta()], docs);
    const l = linhaDe(plano);
    expect(l).toMatchObject({
      rotulo: 'atualizar',
      executar: true,
      intFreteId: DET,
      duplicados: [],
      naoCanonicos: [],
      de: { contaShopeeFreteOuterRef: BARE },
      para: { contaShopeeFreteOuterRef: CANONICO },
    });
    expect(l.plano).toEqual({
      acao: 'atualizar',
      id: DET,
      patch: { contaShopeeFreteOuterRef: CANONICO },
    });
    // The reconcile's own chooser over the same input picks the same doc.
    expect(syncShopee.escolherIntFreteDaConta(docs, ID)?.id).toBe(DET);
    expect(idsAExecutar(plano.linhas)).toEqual([ID]);
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('near-miss: the SAME bare ref on an auto-id doc is still bloqueado-nao-canonico', () => {
    const plano = planejar([conta()], [legado('legacy-bare', { contaShopeeFreteOuterRef: BARE })]);
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'bloqueado-nao-canonico',
      executar: false,
      naoCanonicos: ['legacy-bare'],
    });
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(true);
  });

  it('a canonical legacy doc beside the det doc with a bare ref: the det doc is a twin, STOP', () => {
    const plano = planejar(
      [conta()],
      [legado('legacy-1'), carimbado(DET, { contaShopeeFreteOuterRef: BARE })],
    );
    const l = linhaDe(plano);
    expect(l).toMatchObject({ rotulo: 'inalterado', intFreteId: 'legacy-1', naoCanonicos: [DET] });
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
  });

  it('near-miss: beside a canonical legacy doc, the det doc with a NULL ref is ref-ilegivel only', () => {
    // A null ref names no conta, so it is no twin: the runbook's scoping of the STOP above.
    const plano = planejar(
      [conta()],
      [legado('legacy-1'), carimbado(DET, { contaShopeeFreteOuterRef: null })],
    );
    expect(linhaDe(plano)).toMatchObject({ intFreteId: 'legacy-1', naoCanonicos: [] });
    expect(plano.refsIlegiveis).toEqual([{ intFreteId: DET, ref: null }]);
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('the det doc AND an auto-id doc, both bare: the det doc is chosen, the other one STOPs', () => {
    const plano = planejar(
      [conta()],
      [
        legado('legacy-bare', { contaShopeeFreteOuterRef: BARE }),
        carimbado(DET, { contaShopeeFreteOuterRef: BARE }),
      ],
    );
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'atualizar',
      intFreteId: DET,
      naoCanonicos: ['legacy-bare'],
    });
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
  });

  it('the det doc with an ALTERED tipo is outside the scan: planned criar, applied as a divergente patch', () => {
    // The documented, accepted divergence (runbook): the reconcile reads shopee-<id> by id and
    // patches it, so the apply's disposition is `atualizado` on the very id the plan names.
    const alterado = { id: DET, data: { ...carimbado(DET).data, tipo: V.mercadoLivre.tipoFrete } };
    const l = linhaDe(planejar([conta()], [alterado]));
    expect(l).toMatchObject({ rotulo: 'criar', executar: true, intFreteId: DET });
    expect(divergeDoPlano(l, { action: 'atualizado', intFreteId: DET })).toBe(true);
  });
});

/* ------------------- compartilhados — two lines, one doc ------------------ */

describe('compartilhados — two contas’ lines targeting ONE doc STOP the pass', () => {
  // `shopee-int-1` carrying int-2's CANONICAL ref, int-1 owning no canonical doc: int-1's
  // deterministic-id fallback and int-2's canonical match both choose it.
  const DET = `shopee-${ID}`;
  const contas = [conta(), conta(OUTRO_ID, { nome: 'Outra' })];
  const alheio = legado(DET, {}, OUTRO_ID);

  it('both lines target the doc, each names the other, and bloqueiaAplicacao is true', () => {
    const plano = planejar(contas, [alheio]);
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: DET,
      duplicados: [],
      naoCanonicos: [],
      compartilhadoCom: [OUTRO_ID],
      para: { contaShopeeFreteOuterRef: CANONICO },
    });
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: DET,
      compartilhadoCom: [ID],
      para: { nome: 'Outra' },
    });
    const motivos = paradasDoPlano(plano);
    expect(motivos).toEqual(paradas({ compartilhados: [ID, OUTRO_ID] }));
    expect(bloqueiaAplicacao(motivos)).toBe(true);
    expect(mensagemDeParada(motivos)).toContain(
      `doc compartilhado com outra conta em 2 conta(s): ${ID}, ${OUTRO_ID}`,
    );
  });

  it('one compartilhado row per conta, naming the doc and the other contas', () => {
    const registros = registrosDoPlano(planejar(contas, [alheio]));
    expect(registros.filter((r) => r.field === 'compartilhado')).toEqual([
      {
        kind: 'skip',
        path: `integracao/${ID}`,
        field: 'compartilhado',
        value: { intFreteId: DET, compartilhadoCom: [OUTRO_ID] },
        reason: 'compartilhado',
      },
      {
        kind: 'skip',
        path: `integracao/${OUTRO_ID}`,
        field: 'compartilhado',
        value: { intFreteId: DET, compartilhadoCom: [ID] },
        reason: 'compartilhado',
      },
    ]);
  });

  it('a line that writes nothing still claims: the orphan’s inactive doc, taken by a live conta', () => {
    const plano = planejar([conta()], [legado(DET, { ativo: false }, OUTRO_ID)]);
    expect(linhaDe(plano)).toMatchObject({ executar: true, intFreteId: DET });
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({
      rotulo: 'orfao-inativo',
      executar: false,
      intFreteId: DET,
    });
    expect(paradasDoPlano(plano)).toEqual(paradas({ compartilhados: [ID, OUTRO_ID] }));
  });

  it('near-miss: each conta with its own doc ⇒ no STOP', () => {
    const plano = planejar(contas, [
      legado(DET),
      legado(`shopee-${OUTRO_ID}`, { nome: 'Outra' }, OUTRO_ID),
    ]);
    expect(plano.linhas.map((l) => l.compartilhadoCom)).toEqual([[], []]);
    expect(paradasDoPlano(plano)).toEqual(paradas());
  });

  it('near-miss: the same foreign-ref doc, once int-1 has a canonical doc of its own ⇒ no STOP', () => {
    // int-1's canonical match comes before its deterministic-id fallback, so the targets differ.
    const plano = planejar(contas, [alheio, legado('legacy-1')]);
    expect(linhaDe(plano)).toMatchObject({ intFreteId: 'legacy-1', compartilhadoCom: [] });
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({ intFreteId: DET, compartilhadoCom: [] });
    expect(paradasDoPlano(plano)).toEqual(paradas());
  });

  it('near-miss: two lines with NO target (both incompleto) share nothing', () => {
    const plano = planejar([conta(ID, { nome: '' }), conta(OUTRO_ID, { nome: '' })], []);
    expect(plano.linhas.map((l) => [l.rotulo, l.intFreteId])).toEqual([
      ['incompleto', null],
      ['incompleto', null],
    ]);
    expect(paradasDoPlano(plano)).toEqual(paradas());
  });
});

/* ------------------------------ T49 idsAExecutar -------------------------- */

describe('T49 idsAExecutar', () => {
  // Plan order: scanned contas in scan order, then orphan ids in first-doc order.
  const plano = planejar(
    [conta('int-3'), conta(ID)],
    [
      carimbado('if-2', {}, OUTRO_ID), // orphan, active ⇒ desativar
      legado('if-4', { ativo: false }, 'int-4'), // orphan, inactive ⇒ orfao-inativo
      legado('legacy-1'), // int-1's doc, equal ⇒ inalterado
    ],
  );

  it('plans every conta in plan order', () => {
    expect(plano.linhas.map((l) => [l.integracaoId, l.rotulo])).toEqual([
      ['int-3', 'criar'],
      [ID, 'inalterado'],
      [OUTRO_ID, 'desativar-orfao'],
      ['int-4', 'orfao-inativo'],
    ]);
  });

  it('is exactly the executable lines’ conta ids, in plan order', () => {
    expect(idsAExecutar(plano.linhas)).toEqual(['int-3', OUTRO_ID]);
    expect(idsAExecutar(plano.linhas)).toEqual(
      plano.linhas.filter((l) => l.executar).map((l) => l.integracaoId),
    );
  });

  it('de-duplicates, keeping the first position', () => {
    const [a, , b] = plano.linhas;
    expect(idsAExecutar([b!, a!, b!])).toEqual([OUTRO_ID, 'int-3']);
  });
});

/* ------------------------------ T50 idempotence --------------------------- */

/** The core's apply step, in memory: the same staged writes, stamped with one fixed time. */
function aplicarEmMemoria(
  docs: ReadonlyArray<IntFreteEncontrado>,
  plano: PlanoIntFrete,
): IntFreteEncontrado[] {
  const proximos = docs.map((d) => ({ id: d.id, data: { ...d.data } }));
  const alvo = (id: string) => proximos.find((d) => d.id === id)!;
  switch (plano.acao) {
    case 'criar':
      proximos.push({ id: plano.id!, data: { ...plano.campos, ultimaModificacao: CARIMBO } });
      break;
    case 'atualizar':
      Object.assign(alvo(plano.id).data, plano.patch, { ultimaModificacao: CARIMBO });
      break;
    case 'desativar':
      Object.assign(alvo(plano.id).data, { ativo: false, ultimaModificacao: CARIMBO });
      break;
    case 'inalterado':
    case 'incompleto':
    case 'nao-encontrado':
      break;
  }
  return proximos;
}

describe('T50 idempotence', () => {
  it('apply every executable plan, re-plan ⇒ zero executable lines', () => {
    const contas = [
      conta('int-c'), // criar
      conta('int-a', { nome: 'Novo Nome' }), // adotar
      conta('int-u', { ativo: false }), // atualizar
      conta('int-i'), // inalterado
      conta('int-x', { filialIntegracaoPedidoOuterRef: null }), // incompleto
    ];
    let docs: IntFreteEncontrado[] = [
      legado('legacy-a', {}, 'int-a'),
      carimbado('if-u', {}, 'int-u'),
      legado('legacy-i', {}, 'int-i'),
      carimbado('if-o', {}, 'int-o'), // orphan ⇒ desativar-orfao
      legado('legacy-oi', { ativo: false }, 'int-oi'), // orphan ⇒ orfao-inativo
    ];

    const primeira = planejar(contas, docs);
    expect(new Set(primeira.linhas.map((l) => l.rotulo))).toEqual(
      new Set([
        'criar',
        'adotar',
        'atualizar',
        'inalterado',
        'incompleto',
        'desativar-orfao',
        'orfao-inativo',
      ]),
    );
    expect(bloqueiaAplicacao(paradasDoPlano(primeira))).toBe(false);
    for (const linha of primeira.linhas.filter((l) => l.executar)) {
      docs = aplicarEmMemoria(docs, linha.plano!);
    }

    const segunda = planejar(contas, docs);
    expect(idsAExecutar(segunda.linhas)).toEqual([]);
    expect(resumirPassagem(segunda).executaveis).toBe(0);
    expect(segunda.linhas.map((l) => [l.integracaoId, l.rotulo])).toEqual([
      ['int-c', 'inalterado'],
      ['int-a', 'inalterado'],
      ['int-u', 'inalterado'],
      ['int-i', 'inalterado'],
      ['int-x', 'incompleto'],
      ['int-o', 'orfao-inativo'],
      ['int-oi', 'orfao-inativo'],
    ]);
  });

  it('reads no clock: the same scan plans identically at two different times', () => {
    vi.useFakeTimers();
    try {
      const entrada = (): PlanoDaPassagem =>
        planejar(
          [conta(), conta('int-3')],
          [legado('legacy-1', { nome: 'X' }), carimbado('if-2', {}, OUTRO_ID)],
        );
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const antes = entrada();
      vi.setSystemTime(new Date('2027-06-30T23:59:59.000Z'));
      expect(entrada()).toEqual(antes);
    } finally {
      vi.useRealTimers();
    }
  });

  it('neither file of the pass spells a clock read', () => {
    for (const arquivo of ['./transform.ts', './backfill.ts']) {
      const fonte = readFileSync(new URL(arquivo, import.meta.url), 'utf8');
      expect(fonte, arquivo).not.toMatch(/Date\.now|new Date\(|performance\.now/);
    }
  });
});

/* --------------------------- T51 the core decides ------------------------- */

describe('T51 no decision of its own', () => {
  it('an ISO-string (or µs) conta dataCadastro beside the stored ms ⇒ inalterado', () => {
    // A hand-written `!==` diff of the raw conta against the doc would say `atualizar` here.
    for (const dataCadastro of ['2026-01-05T10:00:00.000Z', CADASTRO * 1000]) {
      const l = linhaDe(planejar([conta(ID, { dataCadastro })], [legado('legacy-1')]));
      expect(l, String(dataCadastro)).toMatchObject({ rotulo: 'inalterado', executar: false });
    }
  });

  it('near-miss: the stored ms one off IS a change', () => {
    const l = linhaDe(planejar([conta()], [legado('legacy-1', { dataCadastro: CADASTRO + 1 })]));
    expect(l).toMatchObject({ rotulo: 'adotar', para: { dataCadastro: CADASTRO } });
  });

  it('a bare conta filial ≡ the stored canonical one (the core’s fold, not ours)', () => {
    const l = linhaDe(
      planejar([conta(ID, { filialIntegracaoPedidoOuterRef: 'filiais/f-1' })], [legado('l')]),
    );
    expect(l.rotulo).toBe('inalterado');
  });

  it('every planned line carries the core planner’s output verbatim', () => {
    const contas = [conta(), conta('int-3', { nome: 'Outra' }), conta('int-5', { ativo: false })];
    const docs = [legado('legacy-1', { nome: 'X' }), carimbado('if-5', {}, 'int-5')];
    const plano = planejar(contas, docs);
    for (const linha of plano.linhas) {
      const daConta = contas.find((c) => c.id === linha.integracaoId)?.data ?? null;
      expect(linha.plano, linha.integracaoId).toEqual(
        syncShopee.planejarIntFreteDaConta(
          linha.integracaoId,
          daConta,
          syncShopee.escolherIntFreteDaConta(docs, linha.integracaoId),
        ),
      );
    }
  });
});

/* ------------------------------ STOP and summary -------------------------- */

describe('the STOP verdict', () => {
  it('a clean plan does not block', () => {
    const plano = planejar([conta()], [legado('legacy-1')]);
    expect(paradasDoPlano(plano)).toEqual(paradas());
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('the refusal names every conta to resolve, by reason', () => {
    const msg = mensagemDeParada({
      duplicados: ['int-1', 'int-7'],
      naoCanonicos: ['int-9'],
      compartilhados: ['int-3', 'int-4'],
    });
    expect(msg).toContain('STOP');
    expect(msg).toContain('duplicados em 2 conta(s): int-1, int-7');
    expect(msg).toContain('back-ref não canônico em 1 conta(s): int-9');
    expect(msg).toContain('doc compartilhado com outra conta em 2 conta(s): int-3, int-4');
  });

  it('each reason alone blocks, and names only itself', () => {
    for (const motivo of ['duplicados', 'naoCanonicos', 'compartilhados'] as const) {
      const so = paradas({ [motivo]: ['int-1'] });
      expect(bloqueiaAplicacao(so), motivo).toBe(true);
      expect(mensagemDeParada(so).match(/em \d conta\(s\)/g), motivo).toHaveLength(1);
    }
  });
});

describe('resumirPassagem', () => {
  it('counts every label, the unreadable refs and the executable contas', () => {
    const plano = planejar(
      [conta(), conta('int-3')],
      [legado('legacy-1', { nome: 'X' }), legado('nulo', { contaShopeeFreteOuterRef: null })],
    );
    const resumo = resumirPassagem(plano);
    expect(Object.keys(resumo).sort()).toEqual(
      [...ROTULOS_CONTA, 'ref-ilegivel', 'executaveis'].sort(),
    );
    expect(resumo).toMatchObject({ adotar: 1, criar: 1, 'ref-ilegivel': 1, executaveis: 2 });
  });
});

describe('divergeDoPlano', () => {
  const plano = planejar([conta()], []);
  const linha = linhaDe(plano);

  it('the disposition the plan predicts, on the planned doc ⇒ no divergence', () => {
    expect(divergeDoPlano(linha, { action: 'criado', intFreteId: `shopee-${ID}` })).toBe(false);
  });

  it('another action, or another doc ⇒ divergente', () => {
    expect(divergeDoPlano(linha, { action: 'atualizado', intFreteId: `shopee-${ID}` })).toBe(true);
    expect(divergeDoPlano(linha, { action: 'criado', intFreteId: 'outro' })).toBe(true);
    expect(divergeDoPlano(linha, { action: 'inalterado', intFreteId: `shopee-${ID}` })).toBe(true);
  });

  it('a line with nothing to write diverges from any applied disposition', () => {
    const inalterado = linhaDe(planejar([conta()], [legado('legacy-1')]));
    expect(divergeDoPlano(inalterado, { action: 'inalterado', intFreteId: 'legacy-1' })).toBe(true);
  });
});

describe('contarDocsAlterados', () => {
  it('counts only the dispositions that wrote', () => {
    const disposicoes: DisposicaoIntFrete[] = [
      { action: 'criado' },
      { action: 'atualizado' },
      { action: 'desativado' },
      { action: 'inalterado' },
      { action: 'incompleto' },
      { action: 'nao-encontrado' },
      { action: 'obsoleto' },
    ];
    expect(contarDocsAlterados(disposicoes)).toBe(3);
  });
});

describe('registrosDoPlano — the JSONL rows', () => {
  const plano = planejar(
    [conta(), conta('int-x', { nome: '' }), conta('int-d')],
    [
      legado('d-velho', { dataCadastro: 1 }, 'int-d'),
      legado('d-novo', {}, 'int-d'),
      legado('bare', { contaShopeeFreteOuterRef: 'integracao/int-b' }),
      legado('nulo', { contaShopeeFreteOuterRef: null }),
    ],
  );
  const registros = registrosDoPlano(plano);

  it('one row per conta keyed integracao/<id>, plus the STOP and ref-ilegivel rows', () => {
    expect(registros.map((r) => [r.kind, r.path, r.field])).toEqual([
      ['change', `integracao/${ID}`, 'criar'],
      ['skip', 'integracao/int-x', 'incompleto'],
      ['skip', 'integracao/int-d', 'inalterado'],
      ['skip', 'integracao/int-d', 'duplicados'],
      ['skip', 'integracao/int-b', 'bloqueado-nao-canonico'],
      ['skip', 'integracao/int-b', 'nao-canonico'],
      ['skip', 'int_frete/nulo', 'ref-ilegivel'],
    ]);
  });

  it('carries the planned values, the missing fields and the twin ids', () => {
    expect(registros[0]).toMatchObject({
      from: null,
      to: { intFreteId: `shopee-${ID}`, contaShopeeFreteOuterRef: CANONICO },
    });
    expect(registros[1]).toMatchObject({ value: { intFreteId: null, faltando: ['nome'] } });
    expect(registros[3]).toMatchObject({
      value: { escolhido: 'd-novo', duplicados: ['d-velho'] },
    });
    expect(registros[5]).toMatchObject({ value: { naoCanonicos: ['bare'] } });
  });

  it('every row survives JSON (no undefined to drop silently)', () => {
    for (const r of registros) expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

/* ------------------- backfill.ts — the I/O around the plan ---------------- */

interface Escaneado {
  id: string;
  data: Dados;
}

/** Just enough Firestore for the two scans: `collection(c).where(f,'==',v)[.select(...)].get()`. */
function bancoFalso(contas: Escaneado[], docs: Escaneado[]) {
  const consultas: string[] = [];
  const snap = (linhas: Escaneado[]) => ({
    size: linhas.length,
    docs: linhas.map((d) => ({ id: d.id, data: () => d.data })),
  });
  const db = {
    collection(nome: string) {
      return {
        where(campo: string, _op: string, valor: unknown) {
          const linhas = (nome === 'integracao' ? contas : docs).filter(
            (d) => d.data[campo] === valor,
          );
          return {
            select(...campos: string[]) {
              consultas.push(`${nome}:${campo}==${String(valor)}:select(${campos.join(',')})`);
              const mascaradas = linhas.map((d) => ({
                id: d.id,
                data: Object.fromEntries(
                  Object.entries(d.data).filter(([k]) => campos.includes(k)),
                ),
              }));
              return { get: async () => snap(mascaradas) };
            },
            get: async () => {
              consultas.push(`${nome}:${campo}==${String(valor)}`);
              return snap(linhas);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Firestore, consultas };
}

function contexto(
  db: Firestore,
  modo: { apply?: boolean; reportOnly?: boolean } = {},
): { ctx: MigrationContext; linhas: Dados[] } {
  const linhas: Dados[] = [];
  const stream = { write: (s: string) => linhas.push(JSON.parse(s) as Dados) };
  const apply = modo.apply ?? false;
  const reportOnly = modo.reportOnly ?? false;
  return {
    linhas,
    ctx: {
      db,
      apply,
      reportOnly,
      sink: new ChangeSink(stream as unknown as WriteStream),
      writer: {} as BatchWriter,
      args: { projectId: 'demo-erp', apply, reportOnly, targets: [] },
    },
  };
}

describe('backfill.ts run — I/O only, around the plan', () => {
  // int-1 ⇒ criar (its conta carries a credential the mask drops); int-3 ⇒ inalterado, NOT
  // executable; int-2 orphan ⇒ desativar.
  const contas = [
    { id: ID, data: { ...conta().data, accessToken: 'segredo-de-teste' } },
    conta('int-3'),
  ];
  const docs = [carimbado('if-2', {}, OUTRO_ID), legado('legacy-3', {}, 'int-3')];
  let reconciliar: MockInstance<SyncIntFreteConta['reconciliarIntFreteDaConta']>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    reconciliar = vi.spyOn(syncShopee, 'reconciliarIntFreteDaConta');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dry run: the two scans (conta masked), the plan’s rows, no reconcile', async () => {
    const { db, consultas } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db);
    const resumo = await run(ctx);

    expect(reconciliar).not.toHaveBeenCalled();
    expect(consultas.sort()).toEqual(
      [
        `integracao:tipo==${V.shopee.tipoConta}:select(tipo,${CAMPOS_SINCRONIZADOS.join(',')})`,
        `int_frete:tipo==${V.shopee.tipoFrete}`,
      ].sort(),
    );
    expect(JSON.stringify(linhas)).not.toContain('segredo-de-teste');
    expect(linhas.map((l) => [l.kind, l.path, l.field])).toEqual([
      ['change', `integracao/${ID}`, 'criar'],
      ['skip', 'integracao/int-3', 'inalterado'],
      ['change', `integracao/${OUTRO_ID}`, 'desativar-orfao'],
    ]);
    expect(resumo).toEqual({ docsScanned: 4, docsChanged: 2 });
  });

  it('--apply: idsAExecutar verbatim through the core, (db, id) only; docsChanged from it', async () => {
    const { db } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db, { apply: true });
    reconciliar.mockImplementation(async (_db: Firestore, id: string) =>
      id === ID
        ? { action: 'criado', intFreteId: `shopee-${ID}` }
        : // Somebody re-created the conta after the scan: the core is right, the row says so.
          { action: 'inalterado', intFreteId: 'if-2' },
    );
    const resumo = await run(ctx);

    expect(reconciliar.mock.calls).toEqual([
      [db, ID],
      [db, OUTRO_ID],
    ]);
    expect(resumo).toEqual({ docsScanned: 4, docsChanged: 1 });
    expect(linhas.filter((l) => l.field === 'aplicado').map((l) => l.path)).toEqual([
      `integracao/${ID}`,
      `integracao/${OUTRO_ID}`,
    ]);
    expect(linhas.filter((l) => l.field === 'divergente').map((l) => l.path)).toEqual([
      `integracao/${OUTRO_ID}`,
    ]);
  });

  it('--apply STOPS before any reconcile and any row when a conta has duplicados', async () => {
    const { db } = bancoFalso(contas, [...docs, legado('a'), legado('b', { dataCadastro: 1 })]);
    const { ctx, linhas } = contexto(db, { apply: true });
    await expect(run(ctx)).rejects.toThrow(/STOP.*duplicados em 1 conta\(s\): int-1/);
    expect(reconciliar).not.toHaveBeenCalled();
    expect(linhas).toEqual([]);
  });

  it('--apply STOPS on a non-canonical back-ref', async () => {
    const bare = legado('bare', { contaShopeeFreteOuterRef: `integracao/${ID}` });
    const { db } = bancoFalso(contas, [bare]);
    const { ctx } = contexto(db, { apply: true });
    await expect(run(ctx)).rejects.toThrow(/back-ref não canônico em 1 conta\(s\): int-1/);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('--apply STOPS on a doc two contas claim', async () => {
    const alheio = legado(`shopee-${ID}`, {}, OUTRO_ID);
    const { db } = bancoFalso([conta(), conta(OUTRO_ID, { nome: 'Outra' })], [alheio]);
    const { ctx, linhas } = contexto(db, { apply: true });
    await expect(run(ctx)).rejects.toThrow(
      /doc compartilhado com outra conta em 2 conta\(s\): int-1, int-2/,
    );
    expect(reconciliar).not.toHaveBeenCalled();
    expect(linhas).toEqual([]);
  });

  it('--report-only: counts only — no row, no reconcile', async () => {
    const { db } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db, { reportOnly: true });
    expect(await run(ctx)).toEqual({ docsScanned: 4, docsChanged: 0 });
    expect(linhas).toEqual([]);
    expect(reconciliar).not.toHaveBeenCalled();
  });
});
