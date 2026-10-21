import { existsSync, readdirSync, readFileSync, type WriteStream } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type {
  IntFreteEncontrado,
  PlanoIntFrete,
  SyncIntFreteConta,
} from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { ChangeSink, type BatchWriter, type MigrationContext } from '../runner';
import { NOME_DA_PASSAGEM, run } from './backfill';
import {
  adocaoAmazon,
  bloqueiaAplicacao,
  idsAExecutar,
  mensagemDeParada,
  paradasDoPlano,
  planejarPassagem,
  registrosDoPlano,
  resumirPassagem,
  syncAmazon,
  type ContaEscaneada,
  type LinhaConta,
  type ParadasDoPlano,
  type PlanoDaPassagem,
} from './transform';

/**
 * The Amazon binding of the shared `int_frete` adoption pass (master-plan step 20, W12), pinned
 * THROUGH that binding (§3 decision 15 of the step plan): every label once, every STOP reason,
 * the runbook's duplicate-resolution procedure (§3 decision 25), idempotence, the run's I/O, and
 * Amazon's own near-misses. The channel-independent matrices of `../intFreteAdocao/plano.ts` (the
 * full deterministic-doc matrix, the `compartilhados` combinatorics, the JSONL survival walk, the
 * `contaIdDoRef` fold scope) are NOT repeated here: Shopee's and Loja Integrada's suites run them
 * in CI over the same plan.
 *
 * Fixtures are corpus-shaped: a migrated Amazon freight doc sits at a 64-hex id (obviously fake
 * here) and carries only the keys the legacy app wrote — no `ultimaModificacao`, `mapa`,
 * `faixaCep`, `horarioDeCorte` or `prazoExtra`.
 */

/* --------------------------------- fixtures ------------------------------- */

type Dados = Record<string, unknown>;

const V = VINCULO_INT_FRETE_CONTA;
const A = V.amazon;
const ID = 'int-1';
const OUTRO_ID = 'int-2';
const CANONICO = `documents/integracao/${ID}`;
const BARE = `integracao/${ID}`;
const FILIAL = 'documents/filiais/f-1';
/** The conta's registration date, in ms. */
const CADASTRO = Date.parse('2026-01-05T10:00:00.000Z');
/** A stored `dataCadastro` on a migrated doc that differs from its conta's. */
const CADASTRO_DO_DOC = Date.parse('2026-02-11T14:20:00.000Z');
/** A stored `ultimaModificacao` — the core's stamp on a doc it already wrote once. */
const CARIMBO = Date.parse('2026-03-02T09:30:00.000Z');

/** Legacy-shaped doc ids (64 hex digits), obviously fake; lexically HEX_A < HEX_B < HEX_C. */
const HEX_A = '0a'.repeat(32);
const HEX_B = '0b'.repeat(32);
const HEX_C = '0c'.repeat(32);

/** The doc a create lands on: `amz-<integracaoId>`, written out, never derived from the row. */
const AMZ_ID = 'amz-int-1';

const canonicoDe = (id: string): string => `documents/integracao/${id}`;

function conta(id = ID, over: Dados = {}): ContaEscaneada {
  return {
    id,
    data: {
      tipo: A.tipoConta,
      nome: 'Conta Teste',
      ativo: true,
      filialIntegracaoPedidoOuterRef: FILIAL,
      dataCadastro: CADASTRO,
      ...over,
    },
  };
}

/**
 * A migrated Amazon freight doc as the import brings it: the canonical back-ref, the ODM's
 * `docId`, and NO `ultimaModificacao`. Equal to its conta unless `over` says otherwise.
 */
function legado(id: string, over: Dados = {}, contaId = ID): IntFreteEncontrado {
  return {
    id,
    data: {
      tipo: A.tipoFrete,
      nome: 'Conta Teste',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      contaAmazonContaFreteAmazonOuterRef: canonicoDe(contaId),
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

describe('the binding — the trigger’s row, zero options', () => {
  it('binds the Amazon row of VINCULO_INT_FRETE_CONTA, and the pass reconciles through it', () => {
    expect(syncAmazon.vinculo).toBe(V.amazon);
    expect(adocaoAmazon.sync).toBe(syncAmazon);
  });

  it('has NO tolerant scan: a bare back-ref is never chosen (near-miss: the canonical one is)', () => {
    expect(
      syncAmazon.escolherIntFreteDaConta(
        [legado(HEX_A, { contaAmazonContaFreteAmazonOuterRef: BARE })],
        ID,
      ),
    ).toBeNull();
    expect(syncAmazon.escolherIntFreteDaConta([legado(HEX_A)], ID)?.id).toBe(HEX_A);
  });

  it('the STOP message names the Amazon runbook, and no other channel’s', () => {
    const msg = mensagemDeParada(paradas({ duplicados: [ID] }));
    expect(msg).toContain('Veja amazon-int-frete.README.md.');
    expect(msg).not.toMatch(/shopee-int-frete|li-int-frete/);
    expect(adocaoAmazon.runbook).toBe('amazon-int-frete.README.md');
  });

  it('the runbook the message names exists beside the package README', () => {
    expect(existsSync(new URL(`../../${adocaoAmazon.runbook}`, import.meta.url))).toBe(true);
  });

  it('migrate:amazon-int-frete runs THIS folder’s backfill.ts, and the log name matches it', () => {
    const pasta = basename(fileURLToPath(new URL('.', import.meta.url)));
    expect(pasta).toBe('2026-10-amazon-int-frete');
    const pacote = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    expect(NOME_DA_PASSAGEM).toBe('amazon-int-frete');
    expect(pacote.scripts[`migrate:${NOME_DA_PASSAGEM}`]).toBe(
      `dotenv -e ../../.env.local -- tsx src/${pasta}/backfill.ts`,
    );
  });
});

/* -------------------------------- every label ----------------------------- */

describe('every label once, with executar per line', () => {
  it('criar — a complete Amazon conta with no doc: executable, at amz-<id>', () => {
    const l = linhaDe(planejar([conta()], []));
    expect(l).toMatchObject({
      rotulo: 'criar',
      executar: true,
      intFreteId: AMZ_ID,
      duplicados: [],
      naoCanonicos: [],
      compartilhadoCom: [],
      de: null,
    });
    expect(l.para).toEqual({
      tipo: 'amz',
      ativo: true,
      contaAmazonContaFreteAmazonOuterRef: CANONICO,
      nome: 'Conta Teste',
      filialIntegracaoFreteOuterRef: FILIAL,
      dataCadastro: CADASTRO,
    });
  });

  it('adotar — a migrated 64-hex doc whose dataCadastro differs: executable, patch dataCadastro only', () => {
    const l = linhaDe(planejar([conta()], [legado(HEX_A, { dataCadastro: CADASTRO_DO_DOC })]));
    expect(l).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: HEX_A,
      de: { dataCadastro: CADASTRO_DO_DOC },
      para: { dataCadastro: CADASTRO },
    });
    expect(l.plano).toEqual({ acao: 'atualizar', id: HEX_A, patch: { dataCadastro: CADASTRO } });
  });

  it('atualizar — the same doc once the core stamped it', () => {
    const l = linhaDe(planejar([conta()], [carimbado(HEX_A, { dataCadastro: CADASTRO_DO_DOC })]));
    expect(l).toMatchObject({ rotulo: 'atualizar', executar: true, intFreteId: HEX_A });
  });

  it('inalterado — a migrated doc already equal to its conta: not executable', () => {
    const l = linhaDe(planejar([conta()], [legado(HEX_A)]));
    expect(l).toMatchObject({ rotulo: 'inalterado', executar: false, intFreteId: HEX_A });
    expect(l.de).toBeNull();
    expect(l.para).toBeNull();
  });

  it('incompleto — no filial and no doc: not executable; beside its doc the stored filial survives', () => {
    const semFilial = conta(ID, { filialIntegracaoPedidoOuterRef: null });
    const l = linhaDe(planejar([semFilial], []));
    expect(l).toMatchObject({ rotulo: 'incompleto', executar: false, intFreteId: null });
    expect(l.plano).toEqual({ acao: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] });
    expect(linhaDe(planejar([semFilial], [legado(HEX_A)]))).toMatchObject({
      rotulo: 'inalterado',
      executar: false,
    });
  });

  it('incompleto — a malformed filial STRING degrades its conta, never aborts the pass', () => {
    for (const filial of ['', 'filiais']) {
      const plano = planejar(
        [conta('int-x', { filialIntegracaoPedidoOuterRef: filial }), conta(ID)],
        [],
      );
      expect(linhaDe(plano, 'int-x'), JSON.stringify(filial)).toMatchObject({
        rotulo: 'incompleto',
        executar: false,
        plano: { acao: 'incompleto', faltando: ['filialIntegracaoPedidoOuterRef'] },
      });
      expect(linhaDe(plano), JSON.stringify(filial)).toMatchObject({
        rotulo: 'criar',
        executar: true,
      });
    }
  });

  it('desativar-orfao — the conta absent, or present under the Loja Integrada tipo', () => {
    const ausente = planejar([], [legado(HEX_A, {}, OUTRO_ID)]);
    expect(linhaDe(ausente, OUTRO_ID)).toMatchObject({
      rotulo: 'desativar-orfao',
      executar: true,
      intFreteId: HEX_A,
      de: { ativo: true },
      para: { ativo: false },
    });
    expect(linhaDe(ausente, OUTRO_ID).plano).toEqual({ acao: 'desativar', id: HEX_A });

    const retipada = planejar([conta(ID, { tipo: V.lojaIntegrada.tipoConta })], [legado(HEX_A)]);
    expect(linhaDe(retipada)).toMatchObject({ rotulo: 'desativar-orfao', executar: true });
  });

  it('orfao-inativo — the conta is gone and its doc is already inactive: not executed', () => {
    const plano = planejar([], [legado(HEX_A, { ativo: false }, OUTRO_ID)]);
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({ rotulo: 'orfao-inativo', executar: false });
    expect(idsAExecutar(plano.linhas)).toEqual([]);
  });

  it('bloqueado-nao-canonico — a bare back-ref on a 64-hex doc: never planned beside it, and STOP', () => {
    const plano = planejar(
      [conta()],
      [legado(HEX_A, { contaAmazonContaFreteAmazonOuterRef: BARE })],
    );
    expect(linhaDe(plano)).toEqual({
      integracaoId: ID,
      rotulo: 'bloqueado-nao-canonico',
      executar: false,
      intFreteId: null,
      plano: null,
      duplicados: [],
      naoCanonicos: [HEX_A],
      compartilhadoCom: [],
      de: null,
      para: null,
    });
    expect(idsAExecutar(plano.linhas)).toEqual([]);
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
  });

  it('ref-ilegivel — a back-ref naming no conta: reported as stored, never executed', () => {
    const plano = planejar(
      [],
      [
        legado(HEX_A, { contaAmazonContaFreteAmazonOuterRef: null }),
        legado(HEX_B, { contaAmazonContaFreteAmazonOuterRef: FILIAL }),
      ],
    );
    expect(plano.linhas).toEqual([]);
    expect(plano.refsIlegiveis).toEqual([
      { intFreteId: HEX_A, ref: null },
      { intFreteId: HEX_B, ref: FILIAL },
    ]);
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });
});

/* ----------------------------- Amazon near-misses ------------------------- */

describe('Amazon near-misses', () => {
  it('a conta whose tipo is the STRING "8" is not Amazon: its doc is deactivated', () => {
    const textual = linhaDe(planejar([conta(ID, { tipo: String(A.tipoConta) })], [legado(HEX_A)]));
    expect(textual).toMatchObject({ rotulo: 'desativar-orfao', executar: true });
    // Near-miss: the INT enum is the Amazon conta, already in step.
    expect(linhaDe(planejar([conta()], [legado(HEX_A)]))).toMatchObject({ rotulo: 'inalterado' });
  });

  it('a conta of the Shopee tipo (5) is not Amazon either', () => {
    const l = linhaDe(planejar([conta(ID, { tipo: V.shopee.tipoConta })], [legado(HEX_A)]));
    expect(l).toMatchObject({ rotulo: 'desativar-orfao', executar: true });
  });

  it('a freight doc of tipo "amazon" is outside the pass (the scan’s own filter); "amz" is in it', () => {
    const foraDoTipo = { id: HEX_A, data: { ...legado(HEX_A).data, tipo: 'amazon' } };
    const fora = planejar([conta()], [foraDoTipo]);
    expect(linhaDe(fora)).toMatchObject({ rotulo: 'criar', intFreteId: AMZ_ID });
    expect(fora.refsIlegiveis).toEqual([]);

    expect(linhaDe(planejar([conta()], [legado(HEX_A)]))).toMatchObject({
      rotulo: 'inalterado',
      intFreteId: HEX_A,
    });
  });

  it('the doc AT amz-<id> with a bare ref is chosen and patched back to canonical, with no STOP', () => {
    const plano = planejar(
      [conta()],
      [carimbado(AMZ_ID, { contaAmazonContaFreteAmazonOuterRef: BARE })],
    );
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'atualizar',
      executar: true,
      intFreteId: AMZ_ID,
      naoCanonicos: [],
      de: { contaAmazonContaFreteAmazonOuterRef: BARE },
      para: { contaAmazonContaFreteAmazonOuterRef: CANONICO },
    });
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('near-miss: the same body at amazon-<id> or AMZ-<id> is no fallback — bloqueado-nao-canonico, STOP', () => {
    for (const id of ['amazon-int-1', 'AMZ-int-1']) {
      const plano = planejar(
        [conta()],
        [carimbado(id, { contaAmazonContaFreteAmazonOuterRef: BARE })],
      );
      expect(linhaDe(plano), id).toMatchObject({
        rotulo: 'bloqueado-nao-canonico',
        executar: false,
        naoCanonicos: [id],
      });
      expect(paradasDoPlano(plano), id).toEqual(paradas({ naoCanonicos: [ID] }));
    }
  });

  it('an inactive migrated doc under an active conta is RE-ACTIVATED, never a second doc', () => {
    const l = linhaDe(planejar([conta()], [legado(HEX_A, { ativo: false })]));
    expect(l).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: HEX_A,
      de: { ativo: false },
      para: { ativo: true },
    });
    expect(l.plano).toEqual({ acao: 'atualizar', id: HEX_A, patch: { ativo: true } });
  });
});

/* ------------------------------ the STOP reasons -------------------------- */

describe('the three STOP reasons', () => {
  /** Two migrated twins of one conta: HEX_A the lower id, HEX_B one second newer. */
  const gemeos = (): IntFreteEncontrado[] => [
    legado(HEX_A, { dataCadastro: CADASTRO_DO_DOC - 1000 }),
    legado(HEX_B, { dataCadastro: CADASTRO_DO_DOC }),
  ];

  it('duplicados — the newest dataCadastro is the REPORTED pick, the other is listed, and STOP', () => {
    const plano = planejar([conta()], gemeos());
    const l = linhaDe(plano);
    expect(l).toMatchObject({ intFreteId: HEX_B, duplicados: [HEX_A] });
    expect(plano.linhas.some((x) => x.intFreteId === HEX_A)).toBe(false);
    expect(paradasDoPlano(plano)).toEqual(paradas({ duplicados: [ID] }));
    expect(registrosDoPlano(plano).filter((r) => r.field === 'duplicados')).toEqual([
      {
        kind: 'skip',
        path: `integracao/${ID}`,
        field: 'duplicados',
        value: { escolhido: HEX_B, duplicados: [HEX_A] },
        reason: 'duplicados',
      },
    ]);
  });

  it('duplicados on an EQUAL dataCadastro — the lexically lower id is reported, whatever the scan order', () => {
    for (const docs of [
      [legado(HEX_B), legado(HEX_A)],
      [legado(HEX_A), legado(HEX_B)],
    ]) {
      const ordem = docs.map((d) => d.id.slice(0, 2)).join(',');
      const plano = planejar([conta()], docs);
      expect(linhaDe(plano), ordem).toMatchObject({ intFreteId: HEX_A, duplicados: [HEX_B] });
      expect(paradasDoPlano(plano), ordem).toEqual(paradas({ duplicados: [ID] }));
    }
  });

  it('near-miss: one ms newer beats the lower id — the id only breaks an EQUAL stamp', () => {
    const l = linhaDe(
      planejar([conta()], [legado(HEX_A), legado(HEX_B, { dataCadastro: CADASTRO + 1 })]),
    );
    expect(l).toMatchObject({ intFreteId: HEX_B, duplicados: [HEX_A] });
  });

  it('nao-canonico — a twin naming this conta in a non-canonical form, beside its canonical doc', () => {
    const plano = planejar(
      [conta()],
      [legado(HEX_A), legado(HEX_B, { contaAmazonContaFreteAmazonOuterRef: `/${CANONICO}` })],
    );
    expect(linhaDe(plano)).toMatchObject({
      rotulo: 'inalterado',
      intFreteId: HEX_A,
      duplicados: [],
      naoCanonicos: [HEX_B],
    });
    expect(paradasDoPlano(plano)).toEqual(paradas({ naoCanonicos: [ID] }));
  });

  it('compartilhado — amz-<a> carrying conta b’s canonical ref, a with no doc: both lines STOP', () => {
    const plano = planejar(
      [conta(), conta(OUTRO_ID, { nome: 'Outra' })],
      [legado(AMZ_ID, {}, OUTRO_ID)],
    );
    expect(linhaDe(plano)).toMatchObject({ intFreteId: AMZ_ID, compartilhadoCom: [OUTRO_ID] });
    expect(linhaDe(plano, OUTRO_ID)).toMatchObject({ intFreteId: AMZ_ID, compartilhadoCom: [ID] });
    expect(paradasDoPlano(plano)).toEqual(paradas({ compartilhados: [ID, OUTRO_ID] }));
  });

  it('near-miss: each conta with its own doc ⇒ no STOP', () => {
    const plano = planejar(
      [conta(), conta(OUTRO_ID, { nome: 'Outra' })],
      [legado(HEX_A), legado(HEX_B, { nome: 'Outra' }, OUTRO_ID)],
    );
    expect(plano.linhas.map((l) => l.compartilhadoCom)).toEqual([[], []]);
    expect(paradasDoPlano(plano)).toEqual(paradas());
    expect(bloqueiaAplicacao(paradasDoPlano(plano))).toBe(false);
  });

  it('each reason alone blocks, names only itself, and so does its refusal', () => {
    for (const motivo of ['duplicados', 'naoCanonicos', 'compartilhados'] as const) {
      const so = paradas({ [motivo]: [ID] });
      expect(bloqueiaAplicacao(so), motivo).toBe(true);
      expect(mensagemDeParada(so).match(/em \d conta\(s\)/g), motivo).toHaveLength(1);
    }
    expect(bloqueiaAplicacao(paradas())).toBe(false);
  });
});

/* --------------- §3 decision 25 — the runbook's duplicate resolution --------------- */

/** The runbook's resolution of one twin: back-ref nulled AND deactivated. Never deleted. */
function resolvido(doc: IntFreteEncontrado): IntFreteEncontrado {
  return {
    id: doc.id,
    data: { ...doc.data, contaAmazonContaFreteAmazonOuterRef: null, ativo: false },
  };
}

describe('§3 decision 25 — what clears a duplicados STOP, and what does not', () => {
  // HEX_A: the LOWEST id (the legacy pick). HEX_B: the newest dataCadastro (the reported pick).
  const velho = legado(HEX_A, { dataCadastro: CADASTRO_DO_DOC - 1000 });
  const novo = legado(HEX_B, { dataCadastro: CADASTRO_DO_DOC });

  it('the starting point: duplicados, with the newest twin reported', () => {
    const plano = planejar([conta()], [velho, novo]);
    expect(linhaDe(plano)).toMatchObject({ intFreteId: HEX_B, duplicados: [HEX_A] });
    expect(paradasDoPlano(plano)).toEqual(paradas({ duplicados: [ID] }));
  });

  it('deactivating the other twin ALONE still STOPs, whichever twin is kept: an inactive canonical twin counts', () => {
    // Both directions: keeping the lower id (the reported pick goes inactive) and keeping the
    // reported pick (the lower id goes inactive) — a count of ACTIVE twins would clear only the
    // second, so only both together pin "the count ignores ativo".
    for (const [mantido, outro] of [
      [velho, novo],
      [novo, velho],
    ] as const) {
      const plano = planejar(
        [conta()],
        [mantido, { id: outro.id, data: { ...outro.data, ativo: false } }],
      );
      expect(paradasDoPlano(plano), mantido.id.slice(0, 2)).toEqual(paradas({ duplicados: [ID] }));
      expect(linhaDe(plano).duplicados, mantido.id.slice(0, 2)).toHaveLength(1);
    }
  });

  it('re-spelling the other twin to the bare integracao/<id> still STOPs, whichever is kept — now as nao-canonico', () => {
    for (const [mantido, outro] of [
      [velho, novo],
      [novo, velho],
    ] as const) {
      const plano = planejar(
        [conta()],
        [
          mantido,
          { id: outro.id, data: { ...outro.data, contaAmazonContaFreteAmazonOuterRef: BARE } },
        ],
      );
      expect(linhaDe(plano), mantido.id.slice(0, 2)).toMatchObject({
        intFreteId: mantido.id,
        duplicados: [],
        naoCanonicos: [outro.id],
      });
      expect(paradasDoPlano(plano), mantido.id.slice(0, 2)).toEqual(
        paradas({ naoCanonicos: [ID] }),
      );
    }
  });

  it('null + ativo: false on the other twin clears it — keeping the LOWEST id, not the reported pick', () => {
    const plano = planejar([conta()], [velho, resolvido(novo)]);
    expect(paradasDoPlano(plano)).toEqual(paradas());
    expect(plano.refsIlegiveis).toEqual([{ intFreteId: HEX_B, ref: null }]);
    const l = linhaDe(plano);
    expect(l).toMatchObject({
      rotulo: 'adotar',
      executar: true,
      intFreteId: HEX_A,
      duplicados: [],
    });
    expect(l.plano).toEqual({ acao: 'atualizar', id: HEX_A, patch: { dataCadastro: CADASTRO } });
  });

  it('the same procedure keeping the newer twin (the one the pedidos reference) clears it too', () => {
    const plano = planejar([conta()], [resolvido(velho), novo]);
    expect(paradasDoPlano(plano)).toEqual(paradas());
    expect(plano.refsIlegiveis).toEqual([{ intFreteId: HEX_A, ref: null }]);
    expect(linhaDe(plano)).toMatchObject({ rotulo: 'adotar', executar: true, intFreteId: HEX_B });
  });

  it('near-miss: a nulled twin left ACTIVE plans identically — only the runbook’s Verify catches it', () => {
    // The pass sees a null ref, never the `ativo` beside it, so `ativo: false` is the person's
    // step, and "one active doc per active conta" is checked by Verify, not by the dry run.
    const nuloAtivo = {
      id: HEX_B,
      data: { ...novo.data, contaAmazonContaFreteAmazonOuterRef: null },
    };
    expect(planejar([conta()], [velho, nuloAtivo])).toEqual(
      planejar([conta()], [velho, resolvido(novo)]),
    );
  });

  it('an ORPHAN conta with two canonical twins STOPs too; resolved the same way, its kept doc is deactivated', () => {
    const antes = planejar([], [velho, novo]);
    expect(linhaDe(antes)).toMatchObject({ rotulo: 'desativar-orfao', duplicados: [HEX_A] });
    expect(paradasDoPlano(antes)).toEqual(paradas({ duplicados: [ID] }));

    const depois = planejar([], [velho, resolvido(novo)]);
    expect(linhaDe(depois)).toMatchObject({
      rotulo: 'desativar-orfao',
      executar: true,
      intFreteId: HEX_A,
      duplicados: [],
      para: { ativo: false },
    });
    expect(paradasDoPlano(depois)).toEqual(paradas());
  });

  it('near-miss: an orphan’s twins that are BOTH inactive still STOP (the count ignores ativo)', () => {
    const inativos = [
      { id: HEX_A, data: { ...velho.data, ativo: false } },
      { id: HEX_B, data: { ...novo.data, ativo: false } },
    ];
    const plano = planejar([], inativos);
    expect(linhaDe(plano)).toMatchObject({ rotulo: 'orfao-inativo', executar: false });
    expect(paradasDoPlano(plano)).toEqual(paradas({ duplicados: [ID] }));
  });
});

/* -------------------------------- idempotence ------------------------------ */

/** The core's apply step, in memory: the same staged writes, stamped with one fixed time. */
function aplicarEmMemoria(
  docs: ReadonlyArray<IntFreteEncontrado>,
  plano: PlanoIntFrete,
): IntFreteEncontrado[] {
  const proximos = docs.map((d) => ({ id: d.id, data: { ...d.data } }));
  const alvo = (id: string): IntFreteEncontrado => {
    const doc = proximos.find((d) => d.id === id);
    if (doc == null) throw new Error(`no doc ${id}`);
    return doc;
  };
  switch (plano.acao) {
    case 'criar':
      proximos.push({
        id: plano.id ?? 'sem-id',
        data: { ...plano.campos, ultimaModificacao: CARIMBO },
      });
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
  it('apply every executable plan, re-plan ⇒ zero executable lines', () => {
    const contas = [
      conta('int-c'), // criar
      conta('int-a'), // adotar (dataCadastro)
      conta('int-r'), // adotar (re-activation)
      conta('int-u', { nome: 'Nome Novo' }), // atualizar
      conta('int-i'), // inalterado
      conta('int-x', { filialIntegracaoPedidoOuterRef: null }), // incompleto
    ];
    let docs: IntFreteEncontrado[] = [
      legado(HEX_A, { dataCadastro: CADASTRO_DO_DOC }, 'int-a'),
      legado(HEX_B, { ativo: false }, 'int-r'),
      carimbado('amz-int-u', {}, 'int-u'),
      legado(HEX_C, {}, 'int-i'),
      legado('0d'.repeat(32), {}, 'int-o'), // orphan ⇒ desativar-orfao
      legado('0e'.repeat(32), { ativo: false }, 'int-oi'), // orphan ⇒ orfao-inativo
    ];

    const primeira = planejar(contas, docs);
    expect(primeira.linhas.map((l) => [l.integracaoId, l.rotulo])).toEqual([
      ['int-c', 'criar'],
      ['int-a', 'adotar'],
      ['int-r', 'adotar'],
      ['int-u', 'atualizar'],
      ['int-i', 'inalterado'],
      ['int-x', 'incompleto'],
      ['int-o', 'desativar-orfao'],
      ['int-oi', 'orfao-inativo'],
    ]);
    expect(bloqueiaAplicacao(paradasDoPlano(primeira))).toBe(false);
    for (const linha of primeira.linhas.filter((l) => l.executar)) {
      if (linha.plano == null) throw new Error(`no plan for ${linha.integracaoId}`);
      docs = aplicarEmMemoria(docs, linha.plano);
    }

    const segunda = planejar(contas, docs);
    expect(idsAExecutar(segunda.linhas)).toEqual([]);
    expect(resumirPassagem(segunda).executaveis).toBe(0);
    expect(segunda.linhas.map((l) => [l.integracaoId, l.rotulo])).toEqual([
      ['int-c', 'inalterado'],
      ['int-a', 'inalterado'],
      ['int-r', 'inalterado'],
      ['int-u', 'inalterado'],
      ['int-i', 'inalterado'],
      ['int-x', 'incompleto'],
      ['int-o', 'orfao-inativo'],
      ['int-oi', 'orfao-inativo'],
    ]);
    expect(linhaDe(segunda, 'int-c').intFreteId).toBe('amz-int-c');
  });

  it('reads no clock: the same scan plans identically at two different times', () => {
    vi.useFakeTimers();
    try {
      const entrada = (): PlanoDaPassagem =>
        planejar(
          [conta(), conta('int-3')],
          [legado(HEX_A, { dataCadastro: CADASTRO_DO_DOC }), carimbado(HEX_B, {}, OUTRO_ID)],
        );
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
      const antes = entrada();
      vi.setSystemTime(Date.parse('2027-06-30T23:59:59.000Z'));
      expect(entrada()).toEqual(antes);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no source file of this folder spells a clock read', () => {
    const pasta = new URL('./', import.meta.url);
    const fontes = readdirSync(pasta)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort();
    expect(fontes).toEqual(['backfill.ts', 'transform.ts']);
    for (const arquivo of fontes) {
      const fonte = readFileSync(new URL(arquivo, pasta), 'utf8');
      expect(fonte, arquivo).not.toMatch(/Date\.now|new Date\(|performance\.now/);
    }
  });
});

/* ---------------------------- no decision of its own ---------------------- */

describe('no decision of its own — the core’s folds decide', () => {
  it('an ISO-string conta dataCadastro beside the stored ms ⇒ inalterado', () => {
    const l = linhaDe(
      planejar([conta(ID, { dataCadastro: '2026-01-05T10:00:00.000Z' })], [legado(HEX_A)]),
    );
    expect(l).toMatchObject({ rotulo: 'inalterado', executar: false });
  });

  it('near-miss: the stored ms one off IS a change', () => {
    const l = linhaDe(planejar([conta()], [legado(HEX_A, { dataCadastro: CADASTRO + 1 })]));
    expect(l).toMatchObject({ rotulo: 'adotar', para: { dataCadastro: CADASTRO } });
  });

  it('a bare conta filial ≡ the stored canonical one', () => {
    const l = linhaDe(
      planejar([conta(ID, { filialIntegracaoPedidoOuterRef: 'filiais/f-1' })], [legado(HEX_A)]),
    );
    expect(l.rotulo).toBe('inalterado');
  });

  it('every planned line carries the core planner’s output verbatim', () => {
    const contas = [conta(), conta('int-3', { nome: 'Outra' }), conta('int-5', { ativo: false })];
    const docs = [legado(HEX_A, { nome: 'X' }), carimbado(HEX_B, {}, 'int-5')];
    for (const linha of planejar(contas, docs).linhas) {
      const daConta = contas.find((c) => c.id === linha.integracaoId)?.data ?? null;
      expect(linha.plano, linha.integracaoId).toEqual(
        syncAmazon.planejarIntFreteDaConta(
          linha.integracaoId,
          daConta,
          syncAmazon.escolherIntFreteDaConta(docs, linha.integracaoId),
        ),
      );
    }
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
        where(campo: string, op: string, valor: unknown) {
          const linhas = (nome === 'integracao' ? contas : docs).filter(
            (d) => op === '==' && d.data[campo] === valor,
          );
          const consulta = `${nome}:${campo}${op}${String(valor)}`;
          return {
            select(...campos: string[]) {
              consultas.push(`${consulta}:select(${campos.join(',')})`);
              const mascaradas = linhas.map((d) => ({
                id: d.id,
                data: Object.fromEntries(
                  Object.entries(d.data).filter(([k]) => campos.includes(k)),
                ),
              }));
              return { get: () => Promise.resolve(snap(mascaradas)) };
            },
            get: () => {
              consultas.push(consulta);
              return Promise.resolve(snap(linhas));
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
  // Plan order int-9 (criar; its conta carries a credential the mask drops), int-3 (inalterado,
  // NOT executable), then the orphan int-2 (desativar): the executable ids are NOT sorted.
  const contas = [
    { id: 'int-9', data: { ...conta('int-9').data, refresh_token: 'segredo-de-teste' } },
    conta('int-3'),
  ];
  const docs = [legado(HEX_C, {}, 'int-3'), carimbado(HEX_B, {}, OUTRO_ID)];
  let reconciliar: MockInstance<SyncIntFreteConta['reconciliarIntFreteDaConta']>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    reconciliar = vi.spyOn(syncAmazon, 'reconciliarIntFreteDaConta');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dry run: exactly the two scans (the conta one masked), the plan’s rows, no reconcile', async () => {
    const { db, consultas } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db);
    const planejarSpy = vi.spyOn(adocaoAmazon, 'planejarPassagem');
    const resumo = await run(ctx);

    expect(reconciliar).not.toHaveBeenCalled();
    expect([...consultas].sort()).toEqual([
      'int_frete:tipo==amz',
      'integracao:tipo==8:select(tipo,nome,ativo,filialIntegracaoPedidoOuterRef,dataCadastro)',
    ]);
    // The mask keeps the credential out of the PROCESS: the planner receives the masked conta.
    // (The JSONL is built from the plan alone, so a check there could not see the mask.)
    expect(planejarSpy).toHaveBeenCalledTimes(1);
    const recebida = planejarSpy.mock.calls[0]?.[0].contas.find((c) => c.id === 'int-9');
    expect(recebida?.data).toEqual(conta('int-9').data);
    expect(linhas.map((l) => [l.kind, l.path, l.field])).toEqual([
      ['change', 'integracao/int-9', 'criar'],
      ['skip', 'integracao/int-3', 'inalterado'],
      ['change', `integracao/${OUTRO_ID}`, 'desativar-orfao'],
    ]);
    expect(resumo).toEqual({ docsScanned: 4, docsChanged: 2 });
  });

  it('--apply: idsAExecutar verbatim (plan order) through the core, (db, id) only; docsChanged from it', async () => {
    const { db } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db, { apply: true });
    reconciliar.mockImplementation((_db: Firestore, id: string) =>
      Promise.resolve(
        id === 'int-9'
          ? { action: 'criado' as const, intFreteId: 'amz-int-9' }
          : // Somebody re-created the conta after the scan: the core is right, the row says so.
            { action: 'inalterado' as const, intFreteId: HEX_B },
      ),
    );
    const resumo = await run(ctx);

    expect(reconciliar.mock.calls).toEqual([
      [db, 'int-9'],
      [db, OUTRO_ID],
    ]);
    expect(resumo).toEqual({ docsScanned: 4, docsChanged: 1 });
    expect(linhas.filter((l) => l.field === 'aplicado').map((l) => l.path)).toEqual([
      'integracao/int-9',
      `integracao/${OUTRO_ID}`,
    ]);
    expect(linhas.filter((l) => l.field === 'divergente').map((l) => l.path)).toEqual([
      `integracao/${OUTRO_ID}`,
    ]);
  });

  /**
   * A STOP refuses the WHOLE `--apply`, not just the blocked contas: each case carries an
   * unblocked, executable bystander (`int-9`, no doc ⇒ `criar`), so "apply the others, then
   * refuse" fails here too. The reconcile is stubbed to succeed, so such a pass would reach its
   * STOP message and fail on the two assertions that matter.
   */
  async function esperarParadaTotal(
    contasDaParada: ContaEscaneada[],
    docsDaParada: IntFreteEncontrado[],
    mensagem: RegExp,
  ): Promise<void> {
    expect(idsAExecutar(planejar(contasDaParada, docsDaParada).linhas)).toContain('int-9');
    reconciliar.mockResolvedValue({ action: 'criado', intFreteId: 'amz-int-9' });
    const { db } = bancoFalso(contasDaParada, docsDaParada);
    const { ctx, linhas } = contexto(db, { apply: true });
    await expect(run(ctx)).rejects.toThrow(mensagem);
    expect(reconciliar).not.toHaveBeenCalled();
    expect(linhas).toEqual([]);
  }

  it('--apply STOPS before any reconcile and any row — on duplicados', async () => {
    await esperarParadaTotal(
      [conta(), conta('int-9')],
      [legado(HEX_A), legado(HEX_B, { dataCadastro: CADASTRO + 1 })],
      /STOP.*duplicados em 1 conta\(s\): int-1.*amazon-int-frete\.README\.md/,
    );
  });

  it('--apply STOPS before any reconcile and any row — on a non-canonical back-ref', async () => {
    await esperarParadaTotal(
      [conta(), conta('int-9')],
      [legado(HEX_A, { contaAmazonContaFreteAmazonOuterRef: BARE })],
      /back-ref não canônico em 1 conta\(s\): int-1/,
    );
  });

  it('--apply STOPS before any reconcile and any row — on a doc two contas claim', async () => {
    await esperarParadaTotal(
      [conta(), conta(OUTRO_ID, { nome: 'Outra' }), conta('int-9')],
      [legado(AMZ_ID, {}, OUTRO_ID)],
      /doc compartilhado com outra conta em 2 conta\(s\): int-1, int-2/,
    );
  });

  it('--report-only: counts only — no row, no reconcile, no third read', async () => {
    const { db, consultas } = bancoFalso(contas, docs);
    const { ctx, linhas } = contexto(db, { reportOnly: true });
    expect(await run(ctx)).toEqual({ docsScanned: 4, docsChanged: 0 });
    expect(consultas).toHaveLength(2);
    expect(linhas).toEqual([]);
    expect(reconciliar).not.toHaveBeenCalled();
  });
});
