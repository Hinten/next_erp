import { readdirSync, readFileSync, type WriteStream } from 'node:fs';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  CAMPOS_SINCRONIZADOS,
  type IntFreteEncontrado,
  type PlanoIntFrete,
  type SyncIntFreteConta,
} from '@delfrance/data/admin/frete';
import { TIPOS_ALVO_MAPA_FRETE_LI, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import {
  bloqueiaAplicacao,
  idsAExecutar,
  paradasDoPlano,
  registrosDoPlano,
  resumirPassagem,
  type ContaEscaneada,
  type LinhaConta,
  type ParadasDoPlano,
  type PlanoDaPassagem,
} from '../intFreteAdocao/plano';
import { ChangeSink, type BatchWriter, type MigrationContext } from '../runner';
import { run } from './backfill';
import { adocaoLojaIntegrada, auditarMapa, syncLojaIntegrada } from './transform';

/* --------------------------------- fixtures ------------------------------- */

type Dados = Record<string, unknown>;

const V = VINCULO_INT_FRETE_CONTA;
const LI = V.lojaIntegrada;
const ID = 'int-1';
const OUTRO_ID = 'int-2';
const CANONICO = `documents/integracao/${ID}`;
const BARE = `integracao/${ID}`;
const DET = `lojaIntegrada-${ID}`;
const FILIAL = 'documents/filiais/f-1';
const CADASTRO = Date.parse('2026-01-05T10:00:00.000Z');
/** A stored `ultimaModificacao` — the core's stamp on a doc it already wrote once. */
const CARIMBO = Date.parse('2026-03-02T09:30:00.000Z');

const canonicoDe = (id: string): string => `documents/integracao/${id}`;

/** A stored `mapa`: one mapped row, one cleared row, one with an unknown key and no id. */
const MAPA_LEGADO = [
  {
    nomeOriginal: 'Transportadora A - PAC',
    idOriginal: '141909---PAC',
    observacao: 'Origem: Pedido 1001',
    integracaoUid: 'if-motoboy',
    targetTipoIntegracao: 'motoboy',
    targetData: null,
    nomeTarget: null,
  },
  {
    nomeOriginal: 'Transportadora A - SEDEX',
    idOriginal: '141909---SEDEX',
    observacao: 'Origem: Pedido 1002',
    integracaoUid: null,
    targetTipoIntegracao: 'outros',
    targetData: null,
    nomeTarget: null,
  },
  {
    nomeOriginal: 'Retirada',
    idOriginal: null,
    observacao: null,
    integracaoUid: null,
    targetTipoIntegracao: 'outros',
    targetData: null,
    nomeTarget: null,
    chaveDesconhecida: 'mantida',
  },
];

const HORARIO_LEGADO = [{ diaDaSemana: 1, hora: 14, minuto: 30 }];

function conta(id = ID, over: Dados = {}): ContaEscaneada {
  return {
    id,
    data: {
      tipo: LI.tipoConta,
      nome: 'Loja Teste',
      ativo: true,
      filialIntegracaoPedidoOuterRef: FILIAL,
      dataCadastro: CADASTRO,
      ...over,
    },
  };
}

/**
 * A legacy per-conta freight doc as the import brings it: an AUTO id, the canonical back-ref, its
 * `mapa` and `horarioDeCorte`, and NO `ultimaModificacao`.
 */
function legado(id: string, over: Dados = {}, contaId = ID): IntFreteEncontrado {
  return {
    id,
    data: {
      tipo: LI.tipoFrete,
      nome: 'Loja Teste',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      contaLojaIntegradaEnviosOuterRef: canonicoDe(contaId),
      dataCadastro: CADASTRO,
      mapa: MAPA_LEGADO,
      horarioDeCorte: HORARIO_LEGADO,
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
  return adocaoLojaIntegrada.planejarPassagem({ contas, docs });
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

/** The fields a patch must never carry: the doc's own configuration, never the conta's. */
const NUNCA_ESCRITOS = ['mapa', 'horarioDeCorte', 'faixaCep', 'enderecoDeOrigem'];

/* ------------------------------- the binding ------------------------------ */

describe('the binding — the trigger’s own, zero options', () => {
  it('binds the Loja Integrada row of VINCULO_INT_FRETE_CONTA, and the pass plans through it', () => {
    expect(syncLojaIntegrada.vinculo).toBe(LI);
    expect(adocaoLojaIntegrada.sync).toBe(syncLojaIntegrada);
  });

  it('has NO tolerant scan: a bare back-ref is never chosen', () => {
    const bare = legado('legacy-bare', { contaLojaIntegradaEnviosOuterRef: BARE });
    expect(syncLojaIntegrada.escolherIntFreteDaConta([bare], ID)).toBeNull();
  });

  it('the STOP message names the Loja Integrada runbook', () => {
    expect(adocaoLojaIntegrada.mensagemDeParada(paradas({ duplicados: [ID] }))).toContain(
      'Veja li-int-frete.README.md.',
    );
  });
});

/* ---------------------------------- labels -------------------------------- */

describe('every label, with the Loja Integrada row', () => {
  it('criar — a complete conta with no doc: executable, at lojaIntegrada-<id>', () => {
    const l = linhaDe(planejar([conta()], []));
    expect(l).toMatchObject({
      rotulo: 'criar',
      executar: true,
      intFreteId: DET,
      duplicados: [],
      naoCanonicos: [],
      de: null,
    });
    expect(l.para).toEqual({
      tipo: 'lojaIntegrada',
      ativo: true,
      contaLojaIntegradaEnviosOuterRef: CANONICO,
      nome: 'Loja Teste',
      filialIntegracaoFreteOuterRef: FILIAL,
      dataCadastro: CADASTRO,
    });
  });

  it('adotar — the legacy AUTO-id doc is adopted by its back-ref; no lojaIntegrada-<id> is planned', () => {
    const plano = planejar([conta()], [legado('legacy-auto', { nome: 'Nome Antigo' })]);
    const l = linhaDe(plano);
    expect(l).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: 'legacy-auto',
      de: { nome: 'Nome Antigo' },
      para: { nome: 'Loja Teste' },
    });
    expect(plano.linhas.map((x) => x.intFreteId)).toEqual(['legacy-auto']);
  });

  it('the adopt patch never carries the doc’s mapa, horarioDeCorte, faixaCep or enderecoDeOrigem', () => {
    const l = linhaDe(
      planejar(
        [conta(ID, { nome: 'Novo', ativo: false })],
        [legado('legacy-auto', { dataCadastro: CADASTRO - 1 })],
      ),
    );
    expect(l.rotulo).toBe('adotar');
    expect(Object.keys(l.para ?? {}).sort()).toEqual(['ativo', 'dataCadastro', 'nome']);
    for (const campo of NUNCA_ESCRITOS) {
      expect(l.para ?? {}, campo).not.toHaveProperty(campo);
      expect(l.de ?? {}, campo).not.toHaveProperty(campo);
    }
  });

  it('the dataCadastro patch — an adopted doc whose stored date differs takes the conta’s', () => {
    const l = linhaDe(planejar([conta()], [legado('legacy-auto', { dataCadastro: CADASTRO + 5 })]));
    expect(l).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      de: { dataCadastro: CADASTRO + 5 },
      para: { dataCadastro: CADASTRO },
    });
    expect(Object.keys(l.para ?? {})).toEqual(['dataCadastro']);
  });

  it('ativo follows the conta — a stored ativo that differs is patched, both ways', () => {
    const desligada = linhaDe(planejar([conta(ID, { ativo: false })], [legado('legacy-auto')]));
    expect(desligada).toMatchObject({ rotulo: 'adotar', para: { ativo: false } });
    const religada = linhaDe(planejar([conta()], [carimbado('if-1', { ativo: false })]));
    expect(religada).toMatchObject({ rotulo: 'atualizar', para: { ativo: true } });
  });

  it('atualizar — a doc the core already stamped that differs: executable', () => {
    const l = linhaDe(planejar([conta()], [carimbado(DET, { nome: 'Nome Antigo' })]));
    expect(l).toMatchObject({ rotulo: 'atualizar', executar: true, intFreteId: DET });
  });

  it('a legacy doc already equal to its conta ⇒ inalterado, not executable', () => {
    const l = linhaDe(planejar([conta()], [legado('legacy-auto')]));
    expect(l).toMatchObject({ rotulo: 'inalterado', executar: false, intFreteId: 'legacy-auto' });
    expect(l.para).toBeNull();
  });

  it('incompleto — a conta with no filial and no doc: not executable, no target', () => {
    const l = linhaDe(planejar([conta(ID, { filialIntegracaoPedidoOuterRef: null })], []));
    expect(l).toMatchObject({ rotulo: 'incompleto', executar: false, intFreteId: null });
    expect(l.plano).toEqual({ acao: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] });
  });

  it('incompleto beside its doc is inalterado: the stored filial survives', () => {
    const l = linhaDe(
      planejar([conta(ID, { filialIntegracaoPedidoOuterRef: null })], [legado('legacy-auto')]),
    );
    expect(l).toMatchObject({ rotulo: 'inalterado', executar: false });
  });
});

/* ---------------------------- the conta's tipo ---------------------------- */

describe('which conta is a Loja Integrada conta — tipo 3, the number', () => {
  it('desativar-orfao — the conta is gone and its doc is active', () => {
    const l = linhaDe(planejar([], [carimbado('if-2', {}, OUTRO_ID)]), OUTRO_ID);
    expect(l).toMatchObject({
      rotulo: 'desativar-orfao',
      executar: true,
      intFreteId: 'if-2',
      de: { ativo: true },
      para: { ativo: false },
    });
  });

  it('near-miss: the conta under tipo 5 (Shopee) or the STRING "3" is not this channel’s ⇒ desativar-orfao', () => {
    for (const tipo of [V.shopee.tipoConta, '3']) {
      const l = linhaDe(planejar([conta(ID, { tipo })], [legado('legacy-auto')]));
      expect(l, JSON.stringify(tipo)).toMatchObject({ rotulo: 'desativar-orfao', executar: true });
    }
  });

  it('an inactive orphan ⇒ orfao-inativo, not executed', () => {
    const plano = planejar([], [legado('legacy-2', { ativo: false }, OUTRO_ID)]);
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({ rotulo: 'orfao-inativo', executar: false });
    expect(idsAExecutar(plano.linhas)).toEqual([]);
  });

  it('a doc of another freight tipo is outside the pass (the scan’s own filter)', () => {
    const daShopee = { id: 'sh-1', data: { ...legado('sh-1').data, tipo: V.shopee.tipoFrete } };
    const l = linhaDe(planejar([conta()], [daShopee]));
    expect(l).toMatchObject({ rotulo: 'criar', intFreteId: DET });
  });
});

/* --------------------- back-refs and the deterministic id ------------------ */

describe('the back-ref and the doc id — what is adopted, and what STOPs', () => {
  it('near-miss: the canonical ref is adopted; the BARE ref on an auto-id doc is bloqueado-nao-canonico', () => {
    const adotado = linhaDe(planejar([conta()], [legado('legacy-auto', { nome: 'X' })]));
    expect(adotado).toMatchObject({ rotulo: 'adotar', intFreteId: 'legacy-auto' });

    const plano = planejar(
      [conta()],
      [legado('legacy-auto', { contaLojaIntegradaEnviosOuterRef: BARE })],
    );
    expect(linhaDe(plano)).toEqual({
      integracaoId: ID,
      rotulo: 'bloqueado-nao-canonico',
      executar: false,
      intFreteId: null,
      plano: null,
      duplicados: [],
      naoCanonicos: ['legacy-auto'],
      compartilhadoCom: [],
      de: null,
      para: null,
    });
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
    expect(idsAExecutar(plano.linhas)).toEqual([]);
  });

  it('the doc AT lojaIntegrada-<id> with a bare ref is chosen by the fallback: patched back, no STOP', () => {
    const docs = [carimbado(DET, { contaLojaIntegradaEnviosOuterRef: BARE })];
    const l = linhaDe(planejar([conta()], docs));
    expect(l).toMatchObject({
      rotulo: 'atualizar',
      executar: true,
      intFreteId: DET,
      naoCanonicos: [],
      de: { contaLojaIntegradaEnviosOuterRef: BARE },
      para: { contaLojaIntegradaEnviosOuterRef: CANONICO },
    });
    expect(syncLojaIntegrada.escolherIntFreteDaConta(docs, ID)?.id).toBe(DET);
  });

  it('near-miss: shopee-<id> and lojaintegrada-<id> are NOT the deterministic id — the same bare ref STOPs', () => {
    for (const id of [`shopee-${ID}`, `lojaintegrada-${ID}`]) {
      const plano = planejar(
        [conta()],
        [carimbado(id, { contaLojaIntegradaEnviosOuterRef: BARE })],
      );
      expect(linhaDe(plano), id).toMatchObject({
        rotulo: 'bloqueado-nao-canonico',
        naoCanonicos: [id],
      });
      expect(bloqueiaAplicacao(paradasDoPlano(plano)), id).toBe(true);
    }
  });

  it('ref-ilegivel — a back-ref naming no conta: reported as stored, never executed', () => {
    const plano = planejar(
      [],
      [
        legado('nulo', { contaLojaIntegradaEnviosOuterRef: null }),
        legado('filial', { contaLojaIntegradaEnviosOuterRef: FILIAL }),
      ],
    );
    expect(plano.linhas).toEqual([]);
    expect(plano.refsIlegiveis).toEqual([
      { intFreteId: 'nulo', ref: null },
      { intFreteId: 'filial', ref: FILIAL },
    ]);
  });
});

/* -------------------------------- the pick -------------------------------- */

describe('which doc the pass chooses — the sync driver’s pick, no ativo filter', () => {
  it('duplicados — the newest dataCadastro is chosen, the other reported, and STOP', () => {
    const plano = planejar(
      [conta()],
      [
        legado('velho', { dataCadastro: CADASTRO - 1000 }),
        legado('novo', { dataCadastro: CADASTRO + 1000 }),
      ],
    );
    expect(linhaDe(plano)).toMatchObject({ intFreteId: 'novo', duplicados: ['velho'] });
    expect(paradasDoPlano(plano)).toEqual(paradas({ duplicados: [ID] }));
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(true);
  });

  it('on an EQUAL dataCadastro the lower id wins, whatever the scan order', () => {
    for (const docs of [
      [legado('dup-b'), legado('dup-a')],
      [legado('dup-a'), legado('dup-b')],
    ]) {
      expect(linhaDe(planejar([conta()], docs))).toMatchObject({
        intFreteId: 'dup-a',
        duplicados: ['dup-b'],
      });
    }
  });

  it('near-miss: a NEWER inactive doc beats an older active one — re-enabling must find it', () => {
    // The importer's pick (`ativo === true` first) would name `ativo-velho`; the sync must not, or
    // re-enabling a conta would plan a second doc instead of re-activating its own.
    const plano = planejar(
      [conta()],
      [
        legado('ativo-velho', { dataCadastro: CADASTRO - 1000 }),
        legado('inativo-novo', { ativo: false }),
      ],
    );
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'adotar',
      intFreteId: 'inativo-novo',
      duplicados: ['ativo-velho'],
      para: { ativo: true },
    });
  });
});

/* -------------------------- compartilhado — STOP -------------------------- */

describe('compartilhados — two contas’ lines targeting ONE doc STOP the pass', () => {
  it('lojaIntegrada-<a> carrying conta b’s canonical ref, a with no doc of its own ⇒ both STOP', () => {
    const plano = planejar(
      [conta(), conta(OUTRO_ID, { nome: 'Outra' })],
      [legado(DET, {}, OUTRO_ID)],
    );
    expect(linhaDe(plano)).toMatchObject({ intFreteId: DET, compartilhadoCom: [OUTRO_ID] });
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({ intFreteId: DET, compartilhadoCom: [ID] });
    const motivos = paradasDoPlano(plano);
    expect(motivos).toEqual(paradas({ compartilhados: [ID, OUTRO_ID] }));
    expect(adocaoLojaIntegrada.mensagemDeParada(motivos)).toContain(
      `doc compartilhado com outra conta em 2 conta(s): ${ID}, ${OUTRO_ID}`,
    );
  });

  it('near-miss: each conta with its own doc ⇒ no STOP', () => {
    const plano = planejar(
      [conta(), conta(OUTRO_ID, { nome: 'Outra' })],
      [legado('legacy-a'), legado('legacy-b', { nome: 'Outra' }, OUTRO_ID)],
    );
    expect(paradasDoPlano(plano)).toEqual(paradas());
  });
});

/* -------------------------------- idempotence ----------------------------- */

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

describe('idempotence', () => {
  it('apply every executable plan, re-plan ⇒ zero executable lines, and the mapa untouched', () => {
    const contas = [
      conta('int-c'), // criar
      conta('int-a', { nome: 'Novo Nome' }), // adotar
      conta('int-d'), // adotar (dataCadastro)
      conta('int-u', { ativo: false }), // atualizar
      conta('int-i'), // inalterado
      conta('int-x', { filialIntegracaoPedidoOuterRef: null }), // incompleto
    ];
    let docs: IntFreteEncontrado[] = [
      legado('legacy-a', {}, 'int-a'),
      legado('legacy-d', { dataCadastro: CADASTRO + 7 }, 'int-d'),
      carimbado('if-u', {}, 'int-u'),
      legado('legacy-i', {}, 'int-i'),
      carimbado('if-o', {}, 'int-o'), // orphan ⇒ desativar-orfao
    ];

    const primeira = planejar(contas, docs);
    expect(primeira.linhas.map((l) => [l.integracaoId, l.rotulo])).toEqual([
      ['int-c', 'criar'],
      ['int-a', 'adotar'],
      ['int-d', 'adotar'],
      ['int-u', 'atualizar'],
      ['int-i', 'inalterado'],
      ['int-x', 'incompleto'],
      ['int-o', 'desativar-orfao'],
    ]);
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
      ['int-d', 'inalterado'],
      ['int-u', 'inalterado'],
      ['int-i', 'inalterado'],
      ['int-x', 'incompleto'],
      ['int-o', 'orfao-inativo'],
    ]);
    expect(docs.find((d) => d.id === `lojaIntegrada-int-c`)).toBeDefined();
    for (const id of ['legacy-a', 'legacy-d', 'if-u']) {
      const doc = docs.find((d) => d.id === id)!;
      expect(doc.data.mapa, id).toBe(MAPA_LEGADO);
      expect(doc.data.horarioDeCorte, id).toBe(HORARIO_LEGADO);
    }
  });

  it('reads no clock: the same scan plans identically at two different times', () => {
    vi.useFakeTimers();
    try {
      const entrada = (): PlanoDaPassagem =>
        planejar([conta(), conta('int-3')], [legado('legacy-1', { nome: 'X' })]);
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const antes = entrada();
      vi.setSystemTime(new Date('2027-06-30T23:59:59.000Z'));
      expect(entrada()).toEqual(antes);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no source file of this folder spells a clock read', () => {
    const pasta = new URL('./', import.meta.url);
    const fontes = readdirSync(pasta).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(fontes).toEqual(expect.arrayContaining(['backfill.ts', 'transform.ts']));
    for (const arquivo of fontes) {
      const fonte = readFileSync(new URL(arquivo, pasta), 'utf8');
      expect(fonte, arquivo).not.toMatch(/Date\.now|new Date\(|performance\.now/);
    }
  });
});

/* ------------------------------- the mapa audit ---------------------------- */

function linhaDoMapa(over: Dados = {}): Dados {
  return { ...MAPA_LEGADO[1], ...over };
}

function docComMapa(id: string, mapa: unknown): IntFreteEncontrado {
  return legado(id, { mapa });
}

describe('auditarMapa — read-only counts', () => {
  it('counts the rows, the mapped ones and each finding over every scanned doc', () => {
    const auditoria = auditarMapa({
      docs: [
        docComMapa('a', [
          linhaDoMapa({ integracaoUid: 'if-moto', targetTipoIntegracao: 'motoboy' }),
          linhaDoMapa({ integracaoUid: 'if-shopee', targetTipoIntegracao: 'shopee' }),
          linhaDoMapa({ integracaoUid: 'if-sumido', targetTipoIntegracao: 'motoboy' }),
          linhaDoMapa(),
        ]),
        docComMapa('b', [
          linhaDoMapa({ integracaoUid: 'int_frete/if-moto', targetTipoIntegracao: 'motoboy' }),
        ]),
      ],
      idsDosAlvos: ['if-moto'],
    });
    expect(auditoria).toEqual({
      docsComMapaInvalido: 0,
      linhas: 5,
      mapeadas: 4,
      tipoForaDosAlvos: 1,
      alvoAusente: 2,
      uidComCaminho: 1,
    });
  });

  it('EQUAL pair: a bare id and the path forms name the SAME scanned target (never absent)', () => {
    for (const integracaoUid of ['abc', 'int_frete/abc', 'documents/int_frete/abc']) {
      const auditoria = auditarMapa({
        docs: [docComMapa('a', [linhaDoMapa({ integracaoUid, targetTipoIntegracao: 'fob' })])],
        idsDosAlvos: ['abc'],
      });
      expect(auditoria, integracaoUid).toMatchObject({ mapeadas: 1, alvoAusente: 0 });
      expect(auditoria.uidComCaminho, integracaoUid).toBe(integracaoUid === 'abc' ? 0 : 1);
    }
  });

  it('⚠️ NEAR-MISS: a longer id is another target — absent when only `abc` is scanned', () => {
    const auditoria = auditarMapa({
      docs: [
        docComMapa('a', [linhaDoMapa({ integracaoUid: 'abcd', targetTipoIntegracao: 'fob' })]),
      ],
      idsDosAlvos: ['abc'],
    });
    expect(auditoria).toMatchObject({ mapeadas: 1, alvoAusente: 1, uidComCaminho: 0 });
  });

  it('⚠️ NEAR-MISS: "mapped" is the uid, never the tipo — null or "" under any tipo is unmapped', () => {
    const auditoria = auditarMapa({
      docs: [
        docComMapa('a', [
          linhaDoMapa({ integracaoUid: null, targetTipoIntegracao: 'outros' }),
          linhaDoMapa({ integracaoUid: '', targetTipoIntegracao: 'motoboy' }),
          linhaDoMapa({ integracaoUid: 42, targetTipoIntegracao: 'motoboy' }),
          // `outros` is a real target tipo too: a row mapped there IS mapped.
          linhaDoMapa({ integracaoUid: 'abc', targetTipoIntegracao: 'outros' }),
        ]),
      ],
      idsDosAlvos: ['abc'],
    });
    expect(auditoria).toMatchObject({
      linhas: 4,
      mapeadas: 1,
      tipoForaDosAlvos: 0,
      alvoAusente: 0,
    });
  });

  it('every one of the five target tipos is inside; a marketplace tipo or no tipo is outside', () => {
    const dentro = TIPOS_ALVO_MAPA_FRETE_LI.map((tipo) =>
      linhaDoMapa({ integracaoUid: 'abc', targetTipoIntegracao: tipo }),
    );
    expect(
      auditarMapa({ docs: [docComMapa('a', dentro)], idsDosAlvos: ['abc'] }).tipoForaDosAlvos,
    ).toBe(0);
    const fora = [
      linhaDoMapa({ integracaoUid: 'abc', targetTipoIntegracao: 'mercadoLivre' }),
      linhaDoMapa({ integracaoUid: 'abc', targetTipoIntegracao: 'lojaIntegrada' }),
      linhaDoMapa({ integracaoUid: 'abc', targetTipoIntegracao: null }),
      { ...linhaDoMapa({ integracaoUid: 'abc' }), targetTipoIntegracao: undefined },
    ];
    expect(
      auditarMapa({ docs: [docComMapa('a', fora)], idsDosAlvos: ['abc'] }).tipoForaDosAlvos,
    ).toBe(4);
  });

  it('a mapa that is null or absent has no rows; a map-shaped one is counted, never read', () => {
    const auditoria = auditarMapa({
      docs: [
        docComMapa('nulo', null),
        { id: 'ausente', data: { tipo: LI.tipoFrete } },
        docComMapa('mapa-objeto', { '0': linhaDoMapa({ integracaoUid: 'abc' }) }),
        docComMapa('texto', 'lixo'),
      ],
      idsDosAlvos: [],
    });
    expect(auditoria).toEqual({
      docsComMapaInvalido: 2,
      linhas: 0,
      mapeadas: 0,
      tipoForaDosAlvos: 0,
      alvoAusente: 0,
      uidComCaminho: 0,
    });
  });

  it('an element that is not a plain object is no row, and nothing throws', () => {
    const auditoria = auditarMapa({
      docs: [docComMapa('a', [null, 'x', 7, ['abc'], linhaDoMapa({ integracaoUid: 'abc' })])],
      idsDosAlvos: ['abc'],
    });
    expect(auditoria).toMatchObject({ linhas: 1, mapeadas: 1 });
  });
});

/* ------------------- backfill.ts — the I/O around the plan ---------------- */

interface Escaneado {
  id: string;
  data: Dados;
}

/**
 * Just enough Firestore for the scans: `collection(c).where(f, '==' | 'in', v)[.select(...)].get()`.
 * An empty `select()` returns the ids only, as the Admin SDK does.
 */
function bancoFalso(contas: Escaneado[], docs: Escaneado[]) {
  const consultas: string[] = [];
  const snap = (linhas: Escaneado[]) => ({
    size: linhas.length,
    docs: linhas.map((d) => ({ id: d.id, data: () => d.data })),
  });
  const db = {
    collection(nome: string) {
      return {
        where(campo: string, op: string, valor: unknown) {
          const casa = (d: Escaneado): boolean =>
            op === 'in'
              ? (valor as unknown[]).includes(d.data[campo])
              : op === '=='
                ? d.data[campo] === valor
                : false;
          const linhas = (nome === 'integracao' ? contas : docs).filter(casa);
          const rotulo = `${nome}:${campo}${op}${Array.isArray(valor) ? `[${valor.join(',')}]` : String(valor)}`;
          return {
            select(...campos: string[]) {
              consultas.push(`${rotulo}:select(${campos.join(',')})`);
              const mascaradas = linhas.map((d) => ({
                id: d.id,
                data: Object.fromEntries(
                  Object.entries(d.data).filter(([k]) => campos.includes(k)),
                ),
              }));
              return { get: async () => snap(mascaradas) };
            },
            get: async () => {
              consultas.push(rotulo);
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

describe('backfill.ts run — the shared I/O, bound to Loja Integrada, plus the mapa audit', () => {
  // int-1 ⇒ criar (its conta carries a credential the mask drops); int-3 ⇒ inalterado; int-2
  // orphan ⇒ desativar. The target scan finds one motoboy doc, which carries a secret the id-only
  // mask must drop.
  const contas = [
    { id: ID, data: { ...conta().data, accessToken: 'segredo-de-teste' } },
    conta('int-3'),
  ];
  const alvos = [
    { id: 'if-motoboy', data: { tipo: 'motoboy', nome: 'Moto', client_secret: 'segredo-alvo' } },
    { id: 'if-me', data: { tipo: 'melhorEnvios', nome: 'ME', client_secret: 'segredo-alvo' } },
  ];
  const docs = [carimbado('if-2', {}, OUTRO_ID), legado('legacy-3', {}, 'int-3'), ...alvos];
  const consultaDosAlvos = `int_frete:tipoin[${TIPOS_ALVO_MAPA_FRETE_LI.join(',')}]:select()`;
  let reconciliar: MockInstance<SyncIntFreteConta['reconciliarIntFreteDaConta']>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    reconciliar = vi.spyOn(syncLojaIntegrada, 'reconciliarIntFreteDaConta');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dry run: the scans (conta masked, targets id-only), the plan’s rows, the audit row, no reconcile', async () => {
    const { db, consultas } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db);
    const resumo = await run(ctx);

    expect(reconciliar).not.toHaveBeenCalled();
    expect(consultas.sort()).toEqual(
      [
        `integracao:tipo==${LI.tipoConta}:select(tipo,${CAMPOS_SINCRONIZADOS.join(',')})`,
        `int_frete:tipo==${LI.tipoFrete}`,
        consultaDosAlvos,
      ].sort(),
    );
    expect(JSON.stringify(linhas)).not.toContain('segredo');
    expect(linhas.map((l) => [l.kind, l.path, l.field])).toEqual([
      ['change', `integracao/${ID}`, 'criar'],
      ['skip', 'integracao/int-3', 'inalterado'],
      ['change', `integracao/${OUTRO_ID}`, 'desativar-orfao'],
      ['skip', 'int_frete', 'auditoria-mapa'],
    ]);
    // legacy-3's mapa: one row mapped to `if-motoboy` (scanned), two unmapped; if-2's: the same.
    expect(linhas.at(-1)).toEqual({
      kind: 'skip',
      path: 'int_frete',
      field: 'auditoria-mapa',
      value: {
        docsComMapaInvalido: 0,
        linhas: 6,
        mapeadas: 2,
        tipoForaDosAlvos: 0,
        alvoAusente: 0,
        uidComCaminho: 0,
      },
      reason: 'auditoria-mapa',
    });
    expect(resumo).toEqual({ docsScanned: 6, docsChanged: 2 });
  });

  it('an INACTIVE target counts as present — the target scan reads ids only, never `ativo`', async () => {
    // Pins the runbook's stated gap: only a target missing from the scan is `alvoAusente`.
    const inativo = { id: 'if-inativo', data: { tipo: 'motoboy', nome: 'Moto', ativo: false } };
    const mapeado = legado(
      'legacy-3',
      {
        mapa: [
          linhaDoMapa({ integracaoUid: 'if-inativo', targetTipoIntegracao: 'motoboy' }),
          linhaDoMapa({ integracaoUid: 'if-sumido', targetTipoIntegracao: 'motoboy' }),
        ],
      },
      'int-3',
    );
    const { db } = bancoFalso(contas, [mapeado, inativo]);
    const { ctx, linhas } = contexto(db);
    await run(ctx);
    expect(linhas.find((l) => l.field === 'auditoria-mapa')?.value).toMatchObject({
      mapeadas: 2,
      alvoAusente: 1,
    });
  });

  it('--apply: idsAExecutar verbatim through the core, (db, id) only; no audit read', async () => {
    const { db, consultas } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db, { apply: true });
    reconciliar.mockImplementation(async (_db: Firestore, id: string) =>
      id === ID
        ? { action: 'criado', intFreteId: DET }
        : { action: 'desativado', intFreteId: 'if-2' },
    );
    const resumo = await run(ctx);

    expect(reconciliar.mock.calls).toEqual([
      [db, ID],
      [db, OUTRO_ID],
    ]);
    expect(consultas).not.toContain(consultaDosAlvos);
    expect(resumo).toEqual({ docsScanned: 4, docsChanged: 2 });
    expect(linhas.filter((l) => l.field === 'aplicado').map((l) => l.path)).toEqual([
      `integracao/${ID}`,
      `integracao/${OUTRO_ID}`,
    ]);
    expect(linhas.filter((l) => l.field === 'divergente')).toEqual([]);
    expect(linhas.filter((l) => l.field === 'auditoria-mapa')).toEqual([]);
  });

  it('--apply STOPS before any reconcile and any row on each of the three verdicts', async () => {
    const casos: Array<[string, Escaneado[], Escaneado[], RegExp]> = [
      [
        'duplicados',
        contas,
        [...docs, legado('a'), legado('b', { dataCadastro: 1 })],
        /STOP.*duplicados em 1 conta\(s\): int-1.*li-int-frete\.README\.md/,
      ],
      [
        'nao-canonico',
        contas,
        [legado('bare', { contaLojaIntegradaEnviosOuterRef: BARE })],
        /back-ref não canônico em 1 conta\(s\): int-1/,
      ],
      [
        'compartilhado',
        [conta(), conta(OUTRO_ID, { nome: 'Outra' })],
        [legado(DET, {}, OUTRO_ID)],
        /doc compartilhado com outra conta em 2 conta\(s\): int-1, int-2/,
      ],
    ];
    for (const [motivo, cs, ds, erro] of casos) {
      const { db } = bancoFalso(cs, ds);
      const { ctx, linhas } = contexto(db, { apply: true });
      await expect(run(ctx), motivo).rejects.toThrow(erro);
      expect(reconciliar, motivo).not.toHaveBeenCalled();
      expect(linhas, motivo).toEqual([]);
    }
  });

  it('a dry run with a STOP verdict still writes its rows and the audit, and never reconciles', async () => {
    const { db } = bancoFalso(contas, [...docs, legado('a'), legado('b', { dataCadastro: 1 })]);
    const { ctx, linhas } = contexto(db);
    await run(ctx);
    expect(linhas.filter((l) => l.field === 'duplicados').map((l) => l.path)).toEqual([
      `integracao/${ID}`,
    ]);
    expect(linhas.filter((l) => l.field === 'auditoria-mapa')).toHaveLength(1);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('--report-only: counts only — the audit reads, but no row and no reconcile', async () => {
    const { db, consultas } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db, { reportOnly: true });
    expect(await run(ctx)).toEqual({ docsScanned: 6, docsChanged: 0 });
    expect(consultas).toContain(consultaDosAlvos);
    expect(linhas).toEqual([]);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it('registrosDoPlano carries the LI back-ref in a criar row', () => {
    const [registro] = registrosDoPlano(planejar([conta()], []));
    expect(registro).toMatchObject({
      kind: 'change',
      field: 'criar',
      from: null,
      to: { intFreteId: DET, contaLojaIntegradaEnviosOuterRef: CANONICO },
    });
  });
});
