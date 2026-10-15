import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  VINCULO_INT_FRETE_CONTA,
  escolherIntFreteMaisNovo,
  intFreteSchema,
  type VinculoIntFreteConta,
} from '@delfrance/schemas';

import {
  OccEngine,
  deferred,
  type OccBeforeCommitCtx,
  type OccTransaction,
  type OccWriteKind,
} from '../../testing';
import {
  diffCamposIntFrete,
  intFreteContaSync,
  type DisposicaoIntFrete,
  type IntFreteEncontrado,
  type PlanoIntFrete,
  type SyncIntFreteConta,
} from './index';

/* ------------------------------ fake Firestore ---------------------------- */
// A local host over the shared `OccEngine` (per-suite fakes are this repo's
// convention; the engine is the one shared piece). It serves exactly what the
// core touches: `integracao` (doc reads, plus `escreverConta` — a write from
// OUTSIDE any of the core's transactions) and `int_frete` (chained `where`
// equality queries, doc reads, `create` / `update`). Reads are versioned by the
// engine, so a conflict really aborts and re-runs the callback.

type DocData = Record<string, unknown>;

/** A collection path nobody writes — a query registered under it is never in conflict. */
const SEM_PROTECAO = 'consulta-sem-protecao-de-fantasma';

class Host {
  readonly docs = new Map<string, DocData>();
  readonly occ: OccEngine;
  /** Every staged write, at CALL time (an aborted attempt's write included). */
  readonly opLog: Array<{ op: OccWriteKind; path: string }> = [];
  /** Every read issued, doc path or query collection path. */
  readonly leituras: string[] = [];
  /** The clock a snapshot's `readTime` reports. */
  relogioMs = RELOGIO_MS;
  /**
   * Registers every QUERY read under {@link SEM_PROTECAO}, so a concurrent insert into the
   * queried range never conflicts with it — the case where Firestore would NOT protect the range.
   */
  semProtecaoDeFantasma = false;
  private autoN = 0;

  constructor() {
    this.occ = new OccEngine({
      applyWrite: (kind, path, data) => {
        const atual = this.docs.get(path);
        if (kind === 'create' && atual != null) {
          throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
        }
        if (kind === 'update' && atual == null) {
          throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
        }
        this.docs.set(path, structuredClone(kind === 'update' ? { ...atual, ...data } : data));
      },
      applyDelete: (path) => {
        this.docs.delete(path);
      },
      logWrite: (op, path) => {
        this.opLog.push({ op, path });
      },
    });
  }

  seed(colecao: string, id: string, data: DocData): void {
    this.docs.set(`${colecao}/${id}`, structuredClone(data));
  }
  colecao(colecao: string): Map<string, DocData> {
    return new Map(
      [...this.docs]
        .filter(([path]) => path.startsWith(`${colecao}/`))
        .map(([path, data]) => [path.slice(colecao.length + 1), data]),
    );
  }
  intFrete(id: string): DocData | undefined {
    return this.docs.get(`int_frete/${id}`);
  }
  escritasIntFrete(): number {
    return this.opLog.filter((o) => o.path.startsWith('int_frete/')).length;
  }
  /** Writes (or deletes) `integracao/<id>` OUTSIDE any of the core's transactions. */
  async escreverConta(id: string, data: DocData | null): Promise<void> {
    await this.occ.runTransaction(async (tx) => {
      const ref = this.ref('integracao', id);
      if (data == null) tx.delete(ref);
      else tx.set(ref, data);
    });
  }

  private ref(colecao: string, id: string) {
    const path = `${colecao}/${id}`;
    return {
      path,
      id,
      get: async () => {
        this.leituras.push(path);
        const lidoEm = this.relogioMs;
        const data = this.docs.get(path);
        return {
          exists: data != null,
          id,
          data: () => (data == null ? undefined : structuredClone(data)),
          readTime: { toMillis: () => lidoEm },
        };
      },
    };
  }
  private query(colecao: string, clausulas: Array<[string, unknown]>) {
    return {
      path: this.semProtecaoDeFantasma ? SEM_PROTECAO : colecao,
      where: (campo: string, _op: string, valor: unknown) =>
        this.query(colecao, [...clausulas, [campo, valor]]),
      get: async () => {
        this.leituras.push(colecao);
        const docs = [...this.colecao(colecao)]
          .filter(([, d]) => clausulas.every(([campo, valor]) => d[campo] === valor))
          .map(([id, d]) => ({ id, data: () => structuredClone(d) }));
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  collection(colecao: string) {
    return {
      doc: (id?: string) => this.ref(colecao, id ?? `auto-${(this.autoN += 1)}`),
      where: (campo: string, op: string, valor: unknown) =>
        this.query(colecao, []).where(campo, op, valor),
    };
  }
  runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
}

const asDb = (host: Host) => host as unknown as Firestore;

/**
 * Starts two transactional calls together so that BOTH finish reading before EITHER commits,
 * then lets the one `ehPrimeiro` names (default: the first to finish reading) commit first; the
 * other commits only once that one has returned. A run is identified by what its first attempt
 * is about to WRITE — never by its label, which only says which `await` chain got there first.
 */
async function emCorrida<T>(
  host: Host,
  a: () => Promise<T>,
  b: () => Promise<T>,
  ehPrimeiro?: (ctx: OccBeforeCommitCtx) => boolean,
): Promise<[PromiseSettledResult<T>, PromiseSettledResult<T>]> {
  const ambosLeram = deferred();
  let chegadas = 0;
  let rotuloDoPrimeiro: string | null = null;
  const promessas: Promise<T>[] = [];
  host.occ.beforeCommit = async (ctx) => {
    if (ctx.attempt !== 1) return;
    rotuloDoPrimeiro ??= ctx.label;
    const primeiro = ehPrimeiro ? ehPrimeiro(ctx) : ctx.label === rotuloDoPrimeiro;
    chegadas += 1;
    if (chegadas === 2) ambosLeram.resolve();
    await ambosLeram.promise;
    // `race` settles when the FIRST run returns — right after its commit.
    if (!primeiro) {
      await Promise.race(promessas).then(
        () => undefined,
        () => undefined,
      );
    }
  };
  const pa = a();
  const pb = b();
  promessas.push(pa, pb);
  try {
    return await Promise.all([settled(pa), settled(pb)]);
  } finally {
    host.occ.beforeCommit = null;
  }
}

function settled<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  return p.then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
  );
}

/** The run whose attempt is about to write `nome` onto an `int_frete` doc (never a conta write). */
const escreveNome =
  (nome: string) =>
  (ctx: OccBeforeCommitCtx): boolean =>
    ctx.writes.some((w) => w.path.startsWith('int_frete/') && w.data.nome === nome);

/* --------------------------------- fixtures ------------------------------- */

const ID = 'int-1';
const OUTRO_ID = 'int-2';
const CANONICO = `documents/integracao/${ID}`;
const FILIAL = 'documents/filiais/f-1';
const CADASTRO = Date.parse('2026-01-05T10:00:00.000Z');
const EVENT_MS = Date.parse('2026-08-04T12:00:00.000Z');
/** The host clock — deliberately far from `Date.now()` and from `EVENT_MS`. */
const RELOGIO_MS = Date.parse('2026-03-02T09:30:00.000Z');

const V = VINCULO_INT_FRETE_CONTA;

function contaDe(vinculo: VinculoIntFreteConta, over: DocData = {}): DocData {
  return {
    tipo: vinculo.tipoConta,
    nome: 'Loja Teste',
    ativo: true,
    filialIntegracaoPedidoOuterRef: FILIAL,
    dataCadastro: CADASTRO,
    ...over,
  };
}

function docDe(vinculo: VinculoIntFreteConta, over: DocData = {}): DocData {
  return {
    tipo: vinculo.tipoFrete,
    nome: 'Loja Teste',
    ativo: true,
    filialIntegracaoFreteOuterRef: FILIAL,
    [vinculo.campoBackRef]: CANONICO,
    dataCadastro: CADASTRO,
    ...over,
  };
}

/** Operator-authored config the sync must never touch — every value valid for the schema. */
const CONFIG_HUMANA = {
  mapa: [
    {
      nomeOriginal: 'Padrão',
      idOriginal: null,
      observacao: null,
      nomeTarget: null,
      targetData: null,
      integracaoUid: null,
      targetTipoIntegracao: 'outros',
    },
  ],
  faixaCep: [{ cepInicial: '01000000', cepFinal: '01999999', custo: 5, valor: 10, prazo: 2 }],
  horarioDeCorte: [
    {
      diaDaSemana: 1,
      horaDeCorte: 14,
      minutosDeCorte: 0,
      prazoDePostagem: 1,
      horaPostagem: 9,
      minutosPostagem: 0,
    },
  ],
  enderecoDeOrigem: {
    idExterno: null,
    cep: '01001000',
    logradouro: 'Rua Teste',
    numero: '1',
    bairro: 'Centro',
    complemento: null,
    codigoMunicipio: null,
    cidade: 'Cidade Teste',
    estado: 'SP',
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
  },
};

/**
 * A stand-in tolerant matcher for the Mercado Livre binding: any string ref ending in
 * `integracao/<id>`. The ML suite (`intFreteSync.test.ts`) runs the binding's real one.
 */
const refToleranteDeTeste = (ref: unknown, integracaoId: string): boolean =>
  typeof ref === 'string' &&
  (ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`));

const shopee = intFreteContaSync(V.shopee);
const lojaIntegrada = intFreteContaSync(V.lojaIntegrada);
const ml = intFreteContaSync(V.mercadoLivre, { refTolerante: refToleranteDeTeste });

/**
 * Every production binding — Shopee, Loja Integrada and Mercado Livre — writes the account and
 * reconciles its current state through the ONE `reconciliarIntFreteDaConta` (#1888, #1826).
 */
interface Cenario {
  nome: string;
  vinculo: VinculoIntFreteConta;
  sync: SyncIntFreteConta;
  /** The other channel's row — the near-miss of every tipo check. */
  outro: VinculoIntFreteConta;
  /** The `ultimaModificacao` a write carries. */
  carimbo: number;
  avisoIncompleto: string;
  /** Applies the conta's current state (null = deleted) through the binding's driver. */
  aplicar(host: Host, conta: DocData | null): Promise<DisposicaoIntFrete>;
}

const CENARIOS: Cenario[] = [
  {
    nome: 'shopee — reconcile',
    vinculo: V.shopee,
    sync: shopee,
    outro: V.mercadoLivre,
    carimbo: RELOGIO_MS,
    avisoIncompleto: '[shopee] conta Shopee sem dados suficientes para criar o int_frete',
    aplicar: async (host, conta) => {
      await host.escreverConta(ID, conta);
      return shopee.reconciliarIntFreteDaConta(asDb(host), ID);
    },
  },
  {
    nome: 'lojaIntegrada — reconcile',
    vinculo: V.lojaIntegrada,
    sync: lojaIntegrada,
    outro: V.shopee,
    carimbo: RELOGIO_MS,
    avisoIncompleto:
      '[loja-integrada] conta Loja Integrada sem dados suficientes para criar o int_frete',
    aplicar: async (host, conta) => {
      await host.escreverConta(ID, conta);
      return lojaIntegrada.reconciliarIntFreteDaConta(asDb(host), ID);
    },
  },
  {
    nome: 'mercadoLivre — reconcile',
    vinculo: V.mercadoLivre,
    sync: ml,
    outro: V.shopee,
    carimbo: RELOGIO_MS,
    avisoIncompleto:
      '[mercado-livre] conta Mercado Livre sem dados suficientes para criar o int_frete',
    aplicar: async (host, conta) => {
      await host.escreverConta(ID, conta);
      return ml.reconciliarIntFreteDaConta(asDb(host), ID);
    },
  },
];

const DISPOSICAO_DO_PLANO: Record<PlanoIntFrete['acao'], DisposicaoIntFrete['action']> = {
  criar: 'criado',
  atualizar: 'atualizado',
  desativar: 'desativado',
  inalterado: 'inalterado',
  incompleto: 'incompleto',
  'nao-encontrado': 'nao-encontrado',
};

function docsComo(host: Host): IntFreteEncontrado[] {
  return [...host.colecao('int_frete')].map(([id, data]) => ({ id, data }));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------ pure helpers ------------------------------ */

describe('diffCamposIntFrete', () => {
  it('returns only the keys whose value differs, and folds nothing of its own', () => {
    const armazenado = { nome: 'A', ativo: true, dataCadastro: CADASTRO, mapa: [1] };
    expect(
      diffCamposIntFrete({ nome: 'A', ativo: true, dataCadastro: CADASTRO }, armazenado),
    ).toEqual({});
    // Near-misses: one ms off, a string where a number is stored, a bare ref.
    expect(diffCamposIntFrete({ dataCadastro: CADASTRO + 1 }, armazenado)).toEqual({
      dataCadastro: CADASTRO + 1,
    });
    expect(diffCamposIntFrete({ dataCadastro: String(CADASTRO) }, armazenado)).toEqual({
      dataCadastro: String(CADASTRO),
    });
    expect(diffCamposIntFrete({ ref: `integracao/${ID}` }, { ref: CANONICO })).toEqual({
      ref: `integracao/${ID}`,
    });
  });
});

/* --------------------------- every binding (T1–T19) ----------------------- */

/** The rows of `VINCULO_INT_FRETE_CONTA`, named by `int_frete.tipo` and sorted. */
const TIPOS_DE_TODA_LINHA = Object.values(V)
  .map((v) => v.tipoFrete)
  .sort();

describe('CENARIOS — the parameterised suite covers every binding', () => {
  // `describe.each(CENARIOS)` below carries every reconcile test (T1–T9, T11–T13, T15–T20,
  // T52–T54, T56, T57) for each channel. A row dropped here, or a new channel's row never
  // added, silently removes that channel's whole suite while every test left still passes, so
  // the table is pinned to the schema's rows rather than to a count.
  it('has exactly one scenario per VINCULO_INT_FRETE_CONTA row', () => {
    expect(CENARIOS.map((c) => c.vinculo.tipoFrete).sort()).toEqual(TIPOS_DE_TODA_LINHA);
  });

  it.each(CENARIOS)(
    '$nome: its sync is built for its own row, and its near-miss is another channel',
    (c) => {
      expect(c.sync.vinculo).toBe(c.vinculo);
      expect(c.outro.tipoFrete).not.toBe(c.vinculo.tipoFrete);
    },
  );
});

describe.each(CENARIOS)('$nome', (c) => {
  const conta = (over: DocData = {}) => contaDe(c.vinculo, over);
  const doc = (over: DocData = {}) => docDe(c.vinculo, over);

  it('T1 creates the doc mirroring the conta, with the schema defaults filled in', async () => {
    const host = new Host();
    const d = await c.aplicar(host, conta());
    expect(d.action).toBe('criado');
    expect(d.intFreteId).toBe(`${c.vinculo.prefixoDocId}-${ID}`);
    expect(host.colecao('int_frete').size).toBe(1);
    const criado = host.intFrete(d.intFreteId!)!;
    expect(criado).toMatchObject({
      tipo: c.vinculo.tipoFrete,
      nome: 'Loja Teste',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      [c.vinculo.campoBackRef]: CANONICO,
      [c.outro.campoBackRef]: null,
      dataCadastro: CADASTRO,
      ultimaModificacao: c.carimbo,
      prazoExtra: 0,
      enderecoDeOrigem: null,
      horarioDeCorte: null,
    });
    expect(d.campos).toEqual([
      'tipo',
      'ativo',
      c.vinculo.campoBackRef,
      'nome',
      'filialIntegracaoFreteOuterRef',
      'dataCadastro',
    ]);
  });

  it.each([
    [
      'the filial is null',
      { filialIntegracaoPedidoOuterRef: null },
      ['filialIntegracaoPedidoOuterRef'],
    ],
    // A malformed STRING filial (only the imported legacy corpus can carry one: the conta
    // schema is a strict `outerRefSchema`) must degrade like a null one — never throw. The
    // strict `toOuterRef` throws a ZodError on both, which would reject the reconcile onto the
    // Eventarc retry and abort the window pass on that one conta (review M-1, mutant C16).
    [
      'the filial is an empty string',
      { filialIntegracaoPedidoOuterRef: '' },
      ['filialIntegracaoPedidoOuterRef'],
    ],
    [
      'the filial has an odd segment count',
      { filialIntegracaoPedidoOuterRef: 'filiais' },
      ['filialIntegracaoPedidoOuterRef'],
    ],
    ['dataCadastro is null', { dataCadastro: null }, ['dataCadastro']],
    ["nome is ''", { nome: '' }, ['nome']],
  ])('T2 writes nothing and names the gap when %s', async (_caso, over, faltando) => {
    const host = new Host();
    const d = await c.aplicar(host, conta(over));
    expect(d).toEqual({ action: 'incompleto', faltando });
    expect(host.colecao('int_frete').size).toBe(0);
    expect(host.escritasIntFrete()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(c.avisoIncompleto, { integracaoId: ID, faltando });
  });

  it.each([
    ['an empty string', ''],
    ['an odd segment count', 'filiais'],
  ])(
    'T2 over an existing doc, a filial that is %s keeps the stored one — never thrown, never written',
    async (_caso, filialRuim) => {
      const host = new Host();
      host.seed('int_frete', 'if-1', doc());
      expect(await c.aplicar(host, conta({ filialIntegracaoPedidoOuterRef: filialRuim }))).toEqual({
        action: 'inalterado',
        intFreteId: 'if-1',
      });
      expect(host.escritasIntFrete()).toBe(0);
      // Another field moving still patches — without the filial.
      expect(
        await c.aplicar(host, conta({ filialIntegracaoPedidoOuterRef: filialRuim, nome: 'Nova' })),
      ).toEqual({ action: 'atualizado', intFreteId: 'if-1', campos: ['nome'] });
      expect(host.intFrete('if-1')).toMatchObject({
        nome: 'Nova',
        filialIntegracaoFreteOuterRef: FILIAL,
      });
      expect(host.colecao('int_frete').size).toBe(1);
    },
  );

  it('T3 ADOPTS a legacy auto-id doc: one doc, config and ODM keys byte-equal', async () => {
    const legado = { ...doc({ nome: 'Nome Antigo' }), docId: 'legacy-1', ...CONFIG_HUMANA };
    expect(legado).not.toHaveProperty('ultimaModificacao');
    const host = new Host();
    host.seed('int_frete', 'legacy-1', legado);
    const d = await c.aplicar(host, conta());
    expect(d).toEqual({ action: 'atualizado', intFreteId: 'legacy-1', campos: ['nome'] });
    expect(host.colecao('int_frete').size).toBe(1);
    const adotado = host.intFrete('legacy-1')!;
    expect(adotado.nome).toBe('Loja Teste');
    expect(adotado.ultimaModificacao).toBe(c.carimbo);
    for (const campo of ['mapa', 'faixaCep', 'horarioDeCorte', 'enderecoDeOrigem'] as const) {
      expect(adotado[campo]).toStrictEqual(CONFIG_HUMANA[campo]);
    }
    expect(adotado.docId).toBe('legacy-1');
    expect(intFreteSchema.safeParse(adotado).success).toBe(true);
  });

  it('T3 a legacy doc already equal to its conta is inalterado, zero writes (K2-F1)', async () => {
    const host = new Host();
    host.seed('int_frete', 'legacy-1', { ...doc(), docId: 'legacy-1', ...CONFIG_HUMANA });
    const d = await c.aplicar(host, conta());
    expect(d).toEqual({ action: 'inalterado', intFreteId: 'legacy-1' });
    expect(host.escritasIntFrete()).toBe(0);
  });

  it('T4 patches ONLY the mirrored field that moved; an identical second pass writes nothing', async () => {
    const host = new Host();
    host.seed('int_frete', 'if-1', { ...doc(), ...CONFIG_HUMANA });
    const primeira = await c.aplicar(host, conta({ nome: 'Loja Nova' }));
    expect(primeira).toEqual({ action: 'atualizado', intFreteId: 'if-1', campos: ['nome'] });
    expect(host.intFrete('if-1')!.dataCadastro).toBe(CADASTRO);
    const escritas = host.escritasIntFrete();
    const segunda = await c.aplicar(host, conta({ nome: 'Loja Nova' }));
    expect(segunda).toEqual({ action: 'inalterado', intFreteId: 'if-1' });
    expect(host.escritasIntFrete()).toBe(escritas);
  });

  it('T5 an absent `ativo` mirrors as true — on create, and over a stored false', async () => {
    const semAtivo = conta();
    delete semAtivo.ativo;
    const criando = new Host();
    const d = await c.aplicar(criando, semAtivo);
    expect(criando.intFrete(d.intFreteId!)!.ativo).toBe(true);

    const host = new Host();
    host.seed('int_frete', 'if-1', doc({ ativo: false }));
    expect(await c.aplicar(host, semAtivo)).toEqual({
      action: 'atualizado',
      intFreteId: 'if-1',
      campos: ['ativo'],
    });
    expect(host.intFrete('if-1')!.ativo).toBe(true);
  });

  it.each([
    ['an ISO string', '2026-01-05T10:00:00.000Z'],
    ['microseconds', CADASTRO * 1000],
  ])('T6 dataCadastro as %s folds to the stored ms — inalterado', async (_caso, valor) => {
    const host = new Host();
    host.seed('int_frete', 'if-1', doc());
    expect(await c.aplicar(host, conta({ dataCadastro: valor }))).toEqual({
      action: 'inalterado',
      intFreteId: 'if-1',
    });
    expect(host.escritasIntFrete()).toBe(0);
  });

  it('T6 near-miss: a stored dataCadastro one ms off IS patched', async () => {
    const host = new Host();
    host.seed('int_frete', 'if-1', doc({ dataCadastro: CADASTRO + 1 }));
    expect(await c.aplicar(host, conta())).toEqual({
      action: 'atualizado',
      intFreteId: 'if-1',
      campos: ['dataCadastro'],
    });
    expect(host.intFrete('if-1')!.dataCadastro).toBe(CADASTRO);
  });

  it('T7 re-enabling flips the stored inactive doc instead of creating a duplicate', async () => {
    const host = new Host();
    host.seed('int_frete', 'legacy-1', doc({ ativo: false }));
    expect(await c.aplicar(host, conta())).toEqual({
      action: 'atualizado',
      intFreteId: 'legacy-1',
      campos: ['ativo'],
    });
    expect(host.colecao('int_frete').size).toBe(1);
    expect(host.intFrete('legacy-1')!.ativo).toBe(true);
  });

  it("T8 a doc of the OTHER channel's tipo carrying this back-ref is not this conta's", async () => {
    const host = new Host();
    host.seed('int_frete', 'alheio', doc({ tipo: c.outro.tipoFrete }));
    expect(await c.sync.buscarIntFreteDaConta(asDb(host), ID)).toBeNull();
    expect(c.sync.escolherIntFreteDaConta(docsComo(host), ID)).toBeNull();
    expect(c.sync.ehDocDaConta(host.intFrete('alheio')!, ID)).toBe(false);
    const d = await c.aplicar(host, conta());
    expect(d.action).toBe('criado');
    expect(host.colecao('int_frete').size).toBe(2);
    expect(host.intFrete('alheio')!.tipo).toBe(c.outro.tipoFrete);
  });

  it('T9 a doc whose back-ref names ANOTHER conta is ignored by both choosers', async () => {
    const host = new Host();
    host.seed(
      'int_frete',
      'outra-conta',
      doc({ [c.vinculo.campoBackRef]: `documents/integracao/${OUTRO_ID}` }),
    );
    expect(await c.sync.buscarIntFreteDaConta(asDb(host), ID)).toBeNull();
    expect(c.sync.escolherIntFreteDaConta(docsComo(host), ID)).toBeNull();
    expect(c.sync.escolherIntFreteDaConta(docsComo(host), OUTRO_ID)).toMatchObject({
      id: 'outra-conta',
    });
    expect((await c.aplicar(host, conta())).action).toBe('criado');
    expect(host.colecao('int_frete').size).toBe(2);
  });

  it('T12 a deleted conta deactivates the doc: dataCadastro kept, never deleted, idempotent', async () => {
    const host = new Host();
    host.seed('int_frete', 'if-1', { ...doc(), ...CONFIG_HUMANA });
    expect(await c.aplicar(host, null)).toEqual({
      action: 'desativado',
      intFreteId: 'if-1',
      campos: ['ativo'],
    });
    const desativado = host.intFrete('if-1')!;
    expect(desativado).toMatchObject({
      ativo: false,
      dataCadastro: CADASTRO,
      ultimaModificacao: c.carimbo,
    });
    expect(desativado.enderecoDeOrigem).toStrictEqual(CONFIG_HUMANA.enderecoDeOrigem);
    expect(host.colecao('int_frete').size).toBe(1);
    const escritas = host.escritasIntFrete();
    expect(await c.aplicar(host, null)).toEqual({ action: 'inalterado', intFreteId: 'if-1' });
    expect(host.escritasIntFrete()).toBe(escritas);
  });

  it('T12 no doc to deactivate ⇒ nao-encontrado, zero writes', async () => {
    const host = new Host();
    expect(await c.aplicar(host, null)).toEqual({ action: 'nao-encontrado' });
    expect(host.escritasIntFrete()).toBe(0);
  });

  it('T12 a conta whose tipo moved to the other channel deactivates too', async () => {
    const host = new Host();
    host.seed('int_frete', 'if-1', doc());
    expect(await c.aplicar(host, conta({ tipo: c.outro.tipoConta }))).toEqual({
      action: 'desativado',
      intFreteId: 'if-1',
      campos: ['ativo'],
    });
  });

  it('T16 every path completes with all its reads before its write (the engine throws otherwise)', async () => {
    // Create: both lookups miss, so the deterministic-ID read runs too.
    const criar = new Host();
    await expect(c.aplicar(criar, conta())).resolves.toMatchObject({ action: 'criado' });
    if (c.vinculo.prefixoDocId != null) {
      expect(criar.leituras).toEqual(
        expect.arrayContaining([
          `integracao/${ID}`,
          'int_frete',
          `int_frete/${c.vinculo.prefixoDocId}-${ID}`,
        ]),
      );
    }
    // patch
    const patch = new Host();
    patch.seed('int_frete', 'if-1', doc({ nome: 'Antigo' }));
    await expect(c.aplicar(patch, conta())).resolves.toMatchObject({ action: 'atualizado' });
    // deactivate
    const desativar = new Host();
    desativar.seed('int_frete', 'if-1', doc());
    await expect(c.aplicar(desativar, null)).resolves.toMatchObject({ action: 'desativado' });
    for (const host of [criar, patch, desativar]) {
      expect(host.occ.txLog.filter((e) => e.phase === 'abort')).toEqual([]);
    }
  });

  it('T18 deveReconciliar — the payload pre-filter truth table', () => {
    const minha = conta();
    const alheia = contaDe(c.outro);
    const tipoAlheio = { ...minha, tipo: c.outro.tipoConta };
    const verdade: Array<[string, DocData | null, DocData | null]> = [
      ['create', null, minha],
      ['delete', minha, null],
      ['tipo edited away', minha, tipoAlheio],
      ['tipo edited back, nothing mirrored moved', tipoAlheio, minha],
      ['a mirrored field moved', minha, { ...minha, nome: 'Outra' }],
    ];
    const falso: Array<[string, DocData | null, DocData | null]> = [
      ['nothing mirrored moved', minha, { ...minha, tabelasAtacado: ['x'] }],
      ['shop_id only', minha, { ...minha, shop_id: 987654 }],
      ["the other channel's conta created", null, alheia],
      ["the other channel's conta updated", alheia, { ...alheia, nome: 'Outra' }],
      ["the other channel's conta deleted", alheia, null],
      ['neither side is a conta of this channel', { tipo: 6 }, { tipo: 7 }],
    ];
    for (const [caso, antes, depois] of verdade) {
      expect(c.sync.deveReconciliar(antes, depois), caso).toBe(true);
    }
    for (const [caso, antes, depois] of falso) {
      expect(c.sync.deveReconciliar(antes, depois), caso).toBe(false);
    }
  });

  it('T19 the filial fold: a bare ref equals the stored canonical; another filial is patched', async () => {
    const host = new Host();
    host.seed('int_frete', 'if-1', doc());
    expect(await c.aplicar(host, conta({ filialIntegracaoPedidoOuterRef: 'filiais/f-1' }))).toEqual(
      {
        action: 'inalterado',
        intFreteId: 'if-1',
      },
    );
    expect(await c.aplicar(host, conta({ filialIntegracaoPedidoOuterRef: 'filiais/f-2' }))).toEqual(
      {
        action: 'atualizado',
        intFreteId: 'if-1',
        campos: ['filialIntegracaoFreteOuterRef'],
      },
    );
    expect(host.intFrete('if-1')!.filialIntegracaoFreteOuterRef).toBe('documents/filiais/f-2');
  });

  it('T54 dry run = apply: the pure chooser + planner predicts what the reconcile reports', async () => {
    /** [case, conta, seeded docs IN SEED ORDER, the id both choosers must name (when pinned)] */
    const fixtures: Array<[string, DocData | null, Array<[string, DocData]>, string?]> = [
      ['create', conta(), []],
      ['incompleto', conta({ filialIntegracaoPedidoOuterRef: null }), []],
      ['adopt', conta(), [['legacy-1', { ...doc({ nome: 'Antigo' }), docId: 'legacy-1' }]]],
      ['patch', conta(), [['if-1', doc({ nome: 'Antigo', ultimaModificacao: EVENT_MS })]]],
      ['inalterado', conta(), [['if-1', doc()]]],
      ['deactivate', null, [['if-1', doc()]]],
      ['nao-encontrado', null, []],
      ['other tipo', conta({ tipo: c.outro.tipoConta }), [['if-1', doc()]]],
      [
        'duplicates',
        conta(),
        [
          ['velho', doc({ dataCadastro: CADASTRO - 1000, nome: 'Velho' })],
          ['novo', doc({ dataCadastro: CADASTRO + 1000 })],
        ],
        'novo',
      ],
      // Equal stamps (review M-2): the lexically lower id wins in EITHER arrival order — the
      // first seed order kills "last of equal stamps wins" (`>=`, mutant C1), the second kills
      // "first seen wins" (the pick riding on query result order).
      [
        'duplicates, equal dataCadastro, lower id seeded first',
        conta(),
        [
          ['a', doc({ nome: 'Gemeo A' })],
          ['b', doc({ nome: 'Gemeo B' })],
        ],
        'a',
      ],
      [
        'duplicates, equal dataCadastro, higher id seeded first',
        conta(),
        [
          ['b', doc({ nome: 'Gemeo B' })],
          ['a', doc({ nome: 'Gemeo A' })],
        ],
        'a',
      ],
      [
        'det-id with altered ref',
        conta(),
        [[`${c.vinculo.prefixoDocId}-${ID}`, doc({ [c.vinculo.campoBackRef]: null })]],
      ],
    ];
    for (const [caso, contaFixture, docs, esperado] of fixtures) {
      const host = new Host();
      for (const [id, data] of docs) host.seed('int_frete', id, data);
      if (contaFixture != null) host.seed('integracao', ID, contaFixture);
      const escolhido = c.sync.escolherIntFreteDaConta(docsComo(host), ID);
      if (esperado !== undefined) {
        expect(escolhido?.id, caso).toBe(esperado);
        expect((await c.sync.buscarIntFreteDaConta(asDb(host), ID))?.id, caso).toBe(esperado);
      }
      const plano = c.sync.planejarIntFreteDaConta(ID, contaFixture, escolhido);
      const d = await c.sync.reconciliarIntFreteDaConta(asDb(host), ID);
      expect(d.action, caso).toBe(DISPOSICAO_DO_PLANO[plano.acao]);
      if ('id' in plano && plano.id != null) expect(d.intFreteId, caso).toBe(plano.id);
      if (esperado !== undefined) expect(d.intFreteId, caso).toBe(esperado);
    }
  });

  it('T56 adopt-and-patch leaves a multi-row legacy `mapa` and the `horarioDeCorte` deep-equal to what was seeded', async () => {
    // The Loja Integrada `EnviosLojaIntegrada` shape (#1826): a mapped row, an unmapped row
    // carrying a key the schema does not model, and a row with no `idOriginal`. The reconcile
    // must never write `mapa` or `horarioDeCorte` on a patch — the mapa helper appends to it and
    // the conta screen edits it, and neither may lose a row to a conta save.
    const mapa = [
      {
        nomeOriginal: 'Gateway Teste - PAC',
        idOriginal: '141909---PAC',
        observacao: 'Origem: Pedido 101',
        nomeTarget: 'Empresa Teste — Serviço Teste',
        targetData: { id: 1, name: 'Serviço Teste', company: { id: 2, name: 'Empresa Teste' } },
        integracaoUid: 'me-1',
        targetTipoIntegracao: 'melhorEnvios',
      },
      {
        nomeOriginal: 'Gateway Teste - Expresso',
        idOriginal: '141909---null',
        observacao: 'Origem: Pedido 102',
        nomeTarget: null,
        targetData: null,
        integracaoUid: null,
        targetTipoIntegracao: 'outros',
        campoDesconhecido: 'mantém',
      },
      {
        nomeOriginal: 'Retirada',
        idOriginal: null,
        observacao: null,
        nomeTarget: null,
        targetData: null,
        integracaoUid: 'ret-1',
        targetTipoIntegracao: 'retiradaNaLoja',
      },
    ];
    const host = new Host();
    host.seed('int_frete', 'legacy-1', {
      ...doc({ nome: 'Nome Antigo', ativo: false }),
      docId: 'legacy-1',
      mapa,
      horarioDeCorte: CONFIG_HUMANA.horarioDeCorte,
    });
    const d = await c.aplicar(host, conta());
    expect(d).toEqual({ action: 'atualizado', intFreteId: 'legacy-1', campos: ['ativo', 'nome'] });
    const adotado = host.intFrete('legacy-1')!;
    expect(adotado).toMatchObject({ nome: 'Loja Teste', ativo: true });
    expect(adotado.mapa).toStrictEqual(mapa);
    expect(adotado.horarioDeCorte).toStrictEqual(CONFIG_HUMANA.horarioDeCorte);
    expect(host.colecao('int_frete').size).toBe(1);
  });

  it('T57 the importer pick: `buscarIntFreteDaConta(…, { apenasAtivo: true })` names the doc `escolherIntFreteMaisNovo(…, ativo === true)` names', async () => {
    // ONE chooser for the core and the browser (#1369, #1826): the conta screen calls the schemas
    // copy over its listener's RAW docs, the importer calls this lookup — they must agree.
    /** A doc with NO `ativo` field: the lookup's `ativo == true` excludes it, and so must the pick. */
    const semAtivo = (over: DocData): DocData => {
      const data = doc(over);
      delete data.ativo;
      return data;
    };
    const conjuntos: Array<[string, Array<[string, DocData]>, string]> = [
      [
        'an older ACTIVE doc beats a newer inactive one',
        [
          ['velho-ativo', doc({ dataCadastro: CADASTRO - 1000 })],
          ['novo-inativo', doc({ dataCadastro: CADASTRO + 1000, ativo: false })],
        ],
        'velho-ativo',
      ],
      [
        'an older ACTIVE doc beats a newer one with NO `ativo` field (raw — never the schema default)',
        [
          ['velho-ativo', doc({ dataCadastro: CADASTRO - 1000 })],
          ['novo-sem-ativo', semAtivo({ dataCadastro: CADASTRO + 1000 })],
        ],
        'velho-ativo',
      ],
      [
        // A copy that kept NaN as a date would keep the first doc it saw (every comparison
        // against NaN is false) — the lookup's private copy diverging from the shared one.
        'a NaN dataCadastro reads as 0 in both, never a date that wins by arriving first',
        [
          ['a-nan', doc({ dataCadastro: Number.NaN })],
          ['b', doc()],
        ],
        'b',
      ],
      [
        'an equal-date active pair goes to the lowest id (higher id seeded first)',
        [
          ['b', doc({ nome: 'Gemeo B' })],
          ['a', doc({ nome: 'Gemeo A' })],
        ],
        'a',
      ],
      [
        'all of them together (lower id seeded first)',
        [
          ['a', doc({ nome: 'Gemeo A' })],
          ['velho-ativo', doc({ dataCadastro: CADASTRO - 1000 })],
          ['novo-inativo', doc({ dataCadastro: CADASTRO + 1000, ativo: false })],
          ['b', doc({ nome: 'Gemeo B' })],
        ],
        'a',
      ],
    ];
    for (const [caso, docs, esperado] of conjuntos) {
      const host = new Host();
      for (const [id, data] of docs) host.seed('int_frete', id, data);
      const daSchema = escolherIntFreteMaisNovo(docsComo(host), (d) => d.ativo === true);
      const doCore = await c.sync.buscarIntFreteDaConta(asDb(host), ID, { apenasAtivo: true });
      expect(daSchema?.id, caso).toBe(esperado);
      expect(doCore?.id, caso).toBe(esperado);
    }
    // Near-miss: WITHOUT the predicate the schemas pick names the newer inactive doc, which the
    // importer's lookup never returns — the predicate is load-bearing, not decoration.
    const host = new Host();
    host.seed('int_frete', 'velho-ativo', doc({ dataCadastro: CADASTRO - 1000 }));
    host.seed('int_frete', 'novo-inativo', doc({ dataCadastro: CADASTRO + 1000, ativo: false }));
    expect(escolherIntFreteMaisNovo(docsComo(host))?.id).toBe('novo-inativo');
    expect((await c.sync.buscarIntFreteDaConta(asDb(host), ID, { apenasAtivo: true }))?.id).toBe(
      'velho-ativo',
    );
  });
});

/* ------------------------- binding-specific behaviour --------------------- */

describe('T10 a bare `integracao/<id>` back-ref', () => {
  const bare = (vinculo: VinculoIntFreteConta) =>
    docDe(vinculo, { [vinculo.campoBackRef]: `integracao/${ID}` });

  /** Every binding built WITHOUT `refTolerante` — Mercado Livre is the only one with it. */
  const SEM_REF_TOLERANTE = [
    ['Shopee', V.shopee, shopee],
    ['Loja Integrada', V.lojaIntegrada, lojaIntegrada],
  ] as const;

  it('the non-tolerant table plus Mercado Livre covers every VINCULO_INT_FRETE_CONTA row', () => {
    expect(
      [
        ...SEM_REF_TOLERANTE.map(([, vinculo]) => vinculo.tipoFrete),
        V.mercadoLivre.tipoFrete,
      ].sort(),
    ).toEqual(TIPOS_DE_TODA_LINHA);
    for (const [, vinculo, sync] of SEM_REF_TOLERANTE) expect(sync.vinculo).toBe(vinculo);
  });

  it.each(SEM_REF_TOLERANTE)(
    '%s: NOT found (no tolerant scan without refTolerante) ⇒ created at the deterministic id',
    async (_canal, vinculo, sync) => {
      const host = new Host();
      host.seed('int_frete', 'legacy-bare', bare(vinculo));
      await host.escreverConta(ID, contaDe(vinculo));
      expect(await sync.buscarIntFreteDaConta(asDb(host), ID)).toBeNull();
      expect(sync.escolherIntFreteDaConta(docsComo(host), ID)).toBeNull();
      const d = await sync.reconciliarIntFreteDaConta(asDb(host), ID);
      expect(d).toMatchObject({ action: 'criado', intFreteId: `${vinculo.prefixoDocId}-${ID}` });
      expect(host.intFrete('legacy-bare')![vinculo.campoBackRef]).toBe(`integracao/${ID}`);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it('Mercado Livre: found by the tolerant scan, warned about, and canonicalised', async () => {
    const host = new Host();
    host.seed('int_frete', 'legacy-bare', bare(V.mercadoLivre));
    expect(await ml.buscarIntFreteDaConta(asDb(host), ID)).toMatchObject({ id: 'legacy-bare' });
    expect(console.warn).toHaveBeenCalledWith(
      '[mercado-livre] int_frete encontrado apenas pelo scan tolerante — ' +
        'contaMercadoLivreMercadoEnviosOuterRef não está na forma canônica ' +
        '(rode o backfill para normalizar)',
      { integracaoId: ID, intFreteId: 'legacy-bare' },
    );
    expect(ml.escolherIntFreteDaConta(docsComo(host), ID)).toMatchObject({ id: 'legacy-bare' });
    await host.escreverConta(ID, contaDe(V.mercadoLivre));
    const d = await ml.reconciliarIntFreteDaConta(asDb(host), ID);
    expect(d).toEqual({
      action: 'atualizado',
      intFreteId: 'legacy-bare',
      campos: ['contaMercadoLivreMercadoEnviosOuterRef'],
    });
    expect(host.colecao('int_frete').size).toBe(1);
    expect(host.intFrete('legacy-bare')!.contaMercadoLivreMercadoEnviosOuterRef).toBe(CANONICO);
  });

  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ])(
    'Mercado Livre adopts the lower-ID bare-reference legacy record before deterministic fallback (%s, %s)',
    async (first, second) => {
      const host = new Host();
      for (const id of [first, second]) host.seed('int_frete', id, bare(V.mercadoLivre));
      const deterministic = `mercadoLivre-${ID}`;
      const corrupted = docDe(V.mercadoLivre, { contaMercadoLivreMercadoEnviosOuterRef: null });
      host.seed('int_frete', deterministic, corrupted);
      expect(ml.escolherIntFreteDaConta(docsComo(host), ID)?.id).toBe('a');
      expect((await ml.buscarIntFreteDaConta(asDb(host), ID))?.id).toBe('a');
      await host.escreverConta(ID, contaDe(V.mercadoLivre));
      expect(await ml.reconciliarIntFreteDaConta(asDb(host), ID)).toMatchObject({
        action: 'atualizado',
        intFreteId: 'a',
        campos: ['contaMercadoLivreMercadoEnviosOuterRef'],
      });
      expect(host.intFrete('a')!.contaMercadoLivreMercadoEnviosOuterRef).toBe(CANONICO);
      expect(host.intFrete('b')!.contaMercadoLivreMercadoEnviosOuterRef).toBe(`integracao/${ID}`);
      expect(host.intFrete(deterministic)).toStrictEqual(corrupted);
      expect(host.colecao('int_frete').size).toBe(3);
    },
  );
});

describe.each(CENARIOS)('$nome — T11 timestamps are display metadata', (c) => {
  it.each([
    ['newer', EVENT_MS + 3_600_000],
    ['an ISO string newer', new Date(EVENT_MS + 3_600_000).toISOString()],
    ['equal', RELOGIO_MS],
    ['older', RELOGIO_MS - 1],
    ['absent', undefined],
  ])('stored %s never blocks an account-authoritative patch', async (_caso, ultimaModificacao) => {
    const host = new Host();
    host.seed('int_frete', 'if-1', {
      ...docDe(c.vinculo, { nome: 'Manual mirrored value' }),
      ...CONFIG_HUMANA,
      ...(ultimaModificacao === undefined ? {} : { ultimaModificacao }),
    });
    expect(await c.aplicar(host, contaDe(c.vinculo))).toEqual({
      action: 'atualizado',
      intFreteId: 'if-1',
      campos: ['nome'],
    });
    expect(host.intFrete('if-1')).toMatchObject({
      nome: 'Loja Teste',
      ultimaModificacao: RELOGIO_MS,
    });
    expect(host.intFrete('if-1')!.mapa).toStrictEqual(CONFIG_HUMANA.mapa);
  });
});

describe.each(CENARIOS)('$nome — T13 concurrent first reconciliations', (c) => {
  it.each([
    ['with query-range protection', false],
    ['WITHOUT query-range protection (the deterministic ID alone holds)', true],
  ])('%s: one document, one abort, both resolve', async (_caso, semProtecao) => {
    const host = new Host();
    host.semProtecaoDeFantasma = semProtecao;
    await host.escreverConta(ID, contaDe(c.vinculo));
    const reconciliar = () => c.sync.reconciliarIntFreteDaConta(asDb(host), ID);
    const [a, b] = await emCorrida(host, reconciliar, reconciliar);
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const acoes = [a, b].map((r) => (r as PromiseFulfilledResult<DisposicaoIntFrete>).value.action);
    expect(acoes.sort()).toEqual(['criado', 'inalterado']);
    expect([...host.colecao('int_frete').keys()]).toEqual([`${c.vinculo.prefixoDocId}-${ID}`]);
    expect(host.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
  });
});

describe.each(CENARIOS)('$nome — T15 reconciliations around an account write A → B', (c) => {
  function preparar(): Host {
    const host = new Host();
    host.seed('integracao', ID, contaDe(c.vinculo, { nome: 'A' }));
    host.seed('int_frete', 'if-1', {
      ...docDe(c.vinculo, { nome: 'Original' }),
      ...CONFIG_HUMANA,
    });
    return host;
  }
  const reconciliar = (host: Host) => c.sync.reconciliarIntFreteDaConta(asDb(host), ID);

  it('R1 commits before the write, R2 after ⇒ B', async () => {
    const host = preparar();
    await reconciliar(host);
    await host.escreverConta(ID, contaDe(c.vinculo, { nome: 'B' }));
    await reconciliar(host);
    expect(host.intFrete('if-1')!.nome).toBe('B');
  });

  it('R1 reads A, the account changes, R2 commits B ⇒ R1 re-reads and writes nothing', async () => {
    const host = preparar();
    const r1Leu = deferred();
    const liberarR1 = deferred();
    host.occ.beforeCommit = async (ctx) => {
      if (ctx.attempt === 1 && escreveNome('A')(ctx)) {
        r1Leu.resolve();
        await liberarR1.promise;
      }
    };
    const p1 = reconciliar(host);
    await r1Leu.promise;
    await host.escreverConta(ID, contaDe(c.vinculo, { nome: 'B' }));
    const d2 = await reconciliar(host);
    liberarR1.resolve();
    const d1 = await p1;
    expect(d2).toMatchObject({ action: 'atualizado', campos: ['nome'] });
    expect(d1).toEqual({ action: 'inalterado', intFreteId: 'if-1' });
    expect(host.intFrete('if-1')!.nome).toBe('B');
    expect(host.intFrete('if-1')!.mapa).toStrictEqual(CONFIG_HUMANA.mapa);
  });

  it('both read, R1 retries and commits B first ⇒ R2 re-reads and writes nothing', async () => {
    const host = preparar();
    const r1Leu = deferred();
    const liberarR1 = deferred();
    const r2Leu = deferred();
    const liberarR2 = deferred();
    host.occ.beforeCommit = async (ctx) => {
      if (ctx.attempt !== 1) return;
      if (escreveNome('A')(ctx)) {
        r1Leu.resolve();
        await liberarR1.promise;
      } else if (escreveNome('B')(ctx)) {
        r2Leu.resolve();
        await liberarR2.promise;
      }
    };
    const p1 = reconciliar(host);
    await r1Leu.promise;
    await host.escreverConta(ID, contaDe(c.vinculo, { nome: 'B' }));
    const p2 = reconciliar(host);
    await r2Leu.promise;
    liberarR1.resolve();
    expect(await p1).toMatchObject({ action: 'atualizado', campos: ['nome'] });
    liberarR2.resolve();
    expect(await p2).toEqual({ action: 'inalterado', intFreteId: 'if-1' });
    expect(host.intFrete('if-1')!.nome).toBe('B');
  });
});

describe.each(CENARIOS)('$nome — T17 deterministic-path fallback', (c) => {
  it('repairs the altered back-ref and type instead of creating a second record', async () => {
    const host = new Host();
    const id = `${c.vinculo.prefixoDocId}-${ID}`;
    host.seed(
      'int_frete',
      id,
      docDe(c.vinculo, { tipo: 'outros', [c.vinculo.campoBackRef]: null }),
    );
    await host.escreverConta(ID, contaDe(c.vinculo));
    expect(await c.sync.reconciliarIntFreteDaConta(asDb(host), ID)).toEqual({
      action: 'atualizado',
      intFreteId: id,
      campos: ['tipo', c.vinculo.campoBackRef],
    });
    expect(host.colecao('int_frete').size).toBe(1);
    expect(host.intFrete(id)).toMatchObject({
      tipo: c.vinculo.tipoFrete,
      [c.vinculo.campoBackRef]: CANONICO,
    });
  });

  it('adopts a canonical legacy record before an altered deterministic-path record', async () => {
    const host = new Host();
    const id = `${c.vinculo.prefixoDocId}-${ID}`;
    const atDeterministicPath = docDe(c.vinculo, { [c.vinculo.campoBackRef]: null });
    host.seed('int_frete', id, atDeterministicPath);
    host.seed('int_frete', 'legacy-1', docDe(c.vinculo, { nome: 'Old' }));
    expect(await c.aplicar(host, contaDe(c.vinculo))).toMatchObject({
      action: 'atualizado',
      intFreteId: 'legacy-1',
    });
    expect(host.intFrete(id)).toStrictEqual(atDeterministicPath);
    expect(host.colecao('int_frete').size).toBe(2);
  });
});

describe.each(CENARIOS)('$nome — T20 delete replay after account recreation', (c) => {
  it('recreation under another type deactivates the original channel’s freight record', async () => {
    const host = new Host();
    host.seed('int_frete', 'if-1', { ...docDe(c.vinculo), ...CONFIG_HUMANA });
    await host.escreverConta(ID, contaDe(c.outro));
    expect(await c.sync.reconciliarIntFreteDaConta(asDb(host), ID)).toEqual({
      action: 'desativado',
      intFreteId: 'if-1',
      campos: ['ativo'],
    });
    expect(host.intFrete('if-1')!.ativo).toBe(false);
    expect(host.intFrete('if-1')!.mapa).toStrictEqual(CONFIG_HUMANA.mapa);
  });

  it.each([true, false])(
    'recreation under the same type preserves/restores the record (ativo=%s)',
    async (ativo) => {
      const host = new Host();
      host.seed('int_frete', 'if-1', docDe(c.vinculo, { ativo }));
      await host.escreverConta(ID, contaDe(c.vinculo));
      expect((await c.sync.reconciliarIntFreteDaConta(asDb(host), ID)).action).toBe(
        ativo ? 'inalterado' : 'atualizado',
      );
      expect(host.intFrete('if-1')!.ativo).toBe(true);
      expect(host.colecao('int_frete').size).toBe(1);
    },
  );
});

describe.each(CENARIOS)('$nome — T52 reconciliation is order-free', (c) => {
  const conta = (over: DocData = {}) => contaDe(c.vinculo, over);
  const SEQUENCIAS: Array<{
    nome: string;
    inicial: DocData | null;
    escritas: Array<DocData | null>;
  }> = [
    { nome: 'ativo off → on', inicial: conta(), escritas: [conta({ ativo: false }), conta()] },
    {
      nome: 'tipo away → back without mirrored field changes',
      inicial: conta(),
      escritas: [conta({ tipo: c.outro.tipoConta }), conta()],
    },
    { nome: 'ativo on, then delete', inicial: conta({ ativo: false }), escritas: [conta(), null] },
    {
      nome: 'nome X → Y → X',
      inicial: conta({ nome: 'W' }),
      escritas: [conta({ nome: 'X' }), conta({ nome: 'Y' }), conta({ nome: 'X' })],
    },
    {
      nome: 'window pass vs a restoring account write',
      inicial: conta({ nome: 'Y' }),
      escritas: [conta({ nome: 'X' }), conta({ nome: 'Y' })],
    },
    { nome: 'create, then delete', inicial: null, escritas: [conta(), null] },
  ];

  function espelha(host: Host, final: DocData | null): void {
    const docs = [...host.colecao('int_frete').values()];
    if (final == null || final.tipo !== c.vinculo.tipoConta) {
      expect(docs.every((d) => d.ativo === false)).toBe(true);
      return;
    }
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      tipo: c.vinculo.tipoFrete,
      nome: final.nome,
      ativo: final.ativo ?? true,
      [c.vinculo.campoBackRef]: CANONICO,
      filialIntegracaoFreteOuterRef: FILIAL,
      dataCadastro: CADASTRO,
    });
  }

  async function partindoDe(inicial: DocData | null): Promise<Host> {
    const host = new Host();
    if (inicial != null) {
      await host.escreverConta(ID, inicial);
      await c.sync.reconciliarIntFreteDaConta(asDb(host), ID);
    }
    return host;
  }

  it.each(SEQUENCIAS)(
    '$nome — delivered late: the first call converges, every later one writes nothing',
    async ({ inicial, escritas }) => {
      const host = await partindoDe(inicial);
      for (const escrita of escritas) await host.escreverConta(ID, escrita);
      const final = escritas[escritas.length - 1] ?? null;
      for (let evento = 0; evento < escritas.length; evento += 1) {
        const antes = host.escritasIntFrete();
        await c.sync.reconciliarIntFreteDaConta(asDb(host), ID);
        espelha(host, final);
        if (evento > 0) expect(host.escritasIntFrete()).toBe(antes);
      }
    },
  );

  it.each(SEQUENCIAS)(
    '$nome — delivered in order, then the first event replayed: the replay writes nothing',
    async ({ inicial, escritas }) => {
      const host = await partindoDe(inicial);
      for (const escrita of escritas) {
        await host.escreverConta(ID, escrita);
        await c.sync.reconciliarIntFreteDaConta(asDb(host), ID);
      }
      const final = escritas[escritas.length - 1] ?? null;
      espelha(host, final);
      const antes = host.escritasIntFrete();
      await c.sync.reconciliarIntFreteDaConta(asDb(host), ID);
      expect(host.escritasIntFrete()).toBe(antes);
      espelha(host, final);
    },
  );
});

describe.each(CENARIOS)('$nome — T53 account snapshot and readTime belong to the retry', (c) => {
  it('an intervening account write aborts the attempt; the retry writes B and its own readTime', async () => {
    const host = new Host();
    host.seed('integracao', ID, contaDe(c.vinculo, { nome: 'A' }));
    host.seed('int_frete', 'if-1', docDe(c.vinculo, { nome: 'Original' }));
    let escreveu = false;
    host.occ.beforeCommit = async (ctx) => {
      if (escreveu || !escreveNome('A')(ctx)) return;
      escreveu = true;
      await host.escreverConta(ID, contaDe(c.vinculo, { nome: 'B' }));
      host.relogioMs = RELOGIO_MS + 1000;
    };
    expect(await c.sync.reconciliarIntFreteDaConta(asDb(host), ID)).toEqual({
      action: 'atualizado',
      intFreteId: 'if-1',
      campos: ['nome'],
    });
    expect(host.intFrete('if-1')).toMatchObject({
      nome: 'B',
      ultimaModificacao: RELOGIO_MS + 1000,
    });
    expect(host.occ.txLog.filter((e) => e.phase === 'abort')).toEqual([
      expect.objectContaining({ conflictPath: `integracao/${ID}` }),
    ]);
  });
});

describe('T55 Mercado Livre no-op followed by an older event replay (#1888)', () => {
  it('preserves current fields with zero writes, without advancing a watermark', async () => {
    const host = new Host();
    const t0 = RELOGIO_MS - 10_000;
    host.seed('integracao', ID, contaDe(V.mercadoLivre, { nome: 'Atual' }));
    host.seed('int_frete', 'if-1', docDe(V.mercadoLivre, { nome: 'Atual', ultimaModificacao: t0 }));
    // The newer no-op and older replay both carry only the account ID into reconciliation.
    expect(await ml.reconciliarIntFreteDaConta(asDb(host), ID)).toEqual({
      action: 'inalterado',
      intFreteId: 'if-1',
    });
    expect(host.intFrete('if-1')!.ultimaModificacao).toBe(t0);
    host.relogioMs += 5000;
    expect(await ml.reconciliarIntFreteDaConta(asDb(host), ID)).toEqual({
      action: 'inalterado',
      intFreteId: 'if-1',
    });
    expect(host.intFrete('if-1')).toMatchObject({ nome: 'Atual', ultimaModificacao: t0 });
    expect(host.escritasIntFrete()).toBe(0);
  });
});
