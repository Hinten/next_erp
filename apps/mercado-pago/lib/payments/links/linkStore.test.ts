/**
 * `persistirLinks` / `marcarLinkTerminal` against the shared optimistic-concurrency
 * engine (`@delfrance/data/testing`), through the REAL collection handles and the
 * REAL `canalDecideOEstado` — only the Firestore itself is a double.
 *
 * The engine is what makes these tests mean something: it versions every path a
 * transaction reads, buffers the writes, and on a conflict re-runs the CALLBACK
 * ONLY — so a decision captured outside the callback (a stale closure) is
 * re-applied verbatim, exactly as in production. `beforeCommit` interleaves a
 * competing writer at the one moment that matters: after this transaction has
 * read and decided, before it commits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { OccEngine, type OccTransaction, type OccWriteKind } from '@delfrance/data/testing';
import {
  ESTADO_NFE,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  INTEGRACAO_TIPO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  STATUS_PAGAMENTO,
  type EstadoNFe,
  type EstadoPedido,
} from '@delfrance/schemas';

import { lerLink } from './leitura';
import {
  marcarLinkTerminal,
  persistirLinks,
  type NovoLink,
  type ResultadoPersistencia,
} from './linkStore';

/* ------------------------------- fake Firestore ------------------------------- */

type DocData = Record<string, unknown>;

/** A gRPC-coded error, the way the Admin SDK surfaces a Firestore failure. */
function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class FakeDb {
  private readonly docs = new Map<string, DocData>();
  /** Every write the callbacks CALLED (attempts that later aborted included). */
  readonly writes: Array<{ op: OccWriteKind; path: string }> = [];
  /** Every write that COMMITTED, in order. */
  readonly patches: Array<{ path: string; data: DocData }> = [];

  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const atual = this.docs.get(path);
      if (kind === 'delete') throw new Error('unexpected delete');
      if (kind === 'create' && atual !== undefined) throw grpc(6, `ALREADY_EXISTS: ${path}`);
      if (kind === 'update' && atual === undefined) throw grpc(5, `NOT_FOUND: ${path}`);
      this.docs.set(path, kind === 'update' ? { ...atual, ...data } : { ...data });
    },
    logWrite: (op, path) => {
      this.writes.push({ op, path });
    },
    recordPatch: (path, data) => {
      this.patches.push({ path, data });
    },
  });

  /** Write straight to the store, BYPASSING the engine: no version moves. */
  seed(path: string, data: DocData): void {
    this.docs.set(path, { ...data });
  }
  read(path: string): DocData | undefined {
    return this.docs.get(path);
  }
  /** Ids of the documents directly under a collection path. */
  filhos(colecao: string): string[] {
    return [...this.docs.keys()]
      .filter((p) => p.startsWith(`${colecao}/`) && !p.slice(colecao.length + 1).includes('/'))
      .map((p) => p.slice(colecao.length + 1))
      .sort();
  }

  private snapshot(path: string, data: DocData | undefined) {
    return {
      id: path.slice(path.lastIndexOf('/') + 1),
      exists: data !== undefined,
      data: () => data,
      get: (campo: string): unknown => data?.[campo],
    };
  }

  docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => this.snapshot(path, this.docs.get(path)),
    };
  }

  collection(path: string) {
    return {
      path,
      doc: (id: string) => this.docRef(`${path}/${id}`),
      get: async () => ({
        docs: this.filhos(path).map((id) =>
          this.snapshot(`${path}/${id}`, this.docs.get(`${path}/${id}`)),
        ),
      }),
    };
  }

  runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
}

function comoFirestore(fake: FakeDb): Firestore {
  return fake as unknown as Firestore;
}

/* --------------------------------- fixtures ---------------------------------- */

const AGORA = Date.UTC(2026, 8, 29, 15, 0, 0);
const AGORA_US = AGORA * 1000;
const DIA = 86_400_000;

const PEDIDO = 'ped1';
const USUARIO = 'documents/usuarios/u1';
const OUTRO_USUARIO = 'documents/usuarios/u2';

const P_PEDIDO = `pedidos/${PEDIDO}`;
const P_LINKS = `${P_PEDIDO}/linkPgtoMercadoPago`;
const P_PAGAMENTOS = `${P_PEDIDO}/pagamentos`;
const P_NFES = `${P_PEDIDO}/nfev4`;

/** A 20-character client-minted link id (`[A-Za-z0-9]{20}`). */
function idLink(n: number): string {
  return `LINK${String(n).padStart(16, '0')}`;
}
const pLink = (n: number) => `${P_LINKS}/${idLink(n)}`;

/** The pedido as stored: `iniciado`, saída, R$ 100,00, on a balcão channel. */
function pedidoSalvo(sobra: DocData = {}): DocData {
  return {
    estado: ESTADO_PEDIDO.iniciado,
    ehSaida: true,
    valorCobrado: 100,
    itensDevolvidos: null,
    integracaoPedidoOuterRef: 'documents/integracao/int1',
    ultimaModificacao: 1_790_000_000_000_000,
    observacoes: 'não mexer',
    descontoTotal: 0,
    ...sobra,
  };
}

function semear(fake: FakeDb, pedido: DocData | null = pedidoSalvo()): void {
  if (pedido !== null) fake.seed(P_PEDIDO, pedido);
  fake.seed('integracao/int1', { tipo: INTEGRACAO_TIPO.balcao });
}

/** A link to create — an open individual link of R$ 50,00 unless overridden. */
function novo(n: number, sobra: Record<string, unknown> = {}, quantidade = 1): NovoLink {
  return {
    linkId: idLink(n),
    quantidade,
    doc: {
      contaMercadoPagoOuterRef: 'documents/metodo_pgto/m1',
      valorCobrado: 50,
      link: `https://mp.test/pref-${n}`,
      id: `pref-${n}`,
      dataCriacao: AGORA,
      dataExpiracao: AGORA + 3 * DIA,
      modo: MODO_LINK_PAGAMENTO.individual,
      nomePagador: 'Maria',
      quantidadeMaxima: 1,
      grupoId: idLink(1),
      ordem: n - 1,
      status: STATUS_LINK_PAGAMENTO.aberto,
      criadoPorOuterRef: USUARIO,
      ...sobra,
    },
  };
}

/** The request most tests send: two links of R$ 50,00 for a R$ 100,00 pedido. */
function pedido(sobra: Partial<Parameters<typeof persistirLinks>[1]> = {}) {
  return {
    pedidoId: PEDIDO,
    criadoPorOuterRef: USUARIO,
    valorCobradoEsperado: 100,
    agoraMs: AGORA,
    novos: [novo(1), novo(2)],
    ...sobra,
  };
}

/** A link already stored, as a raw doc — an open individual link. */
function linkArmazenado(n: number, sobra: DocData = {}): DocData {
  return { ...novo(n).doc, ...sobra };
}

/** Narrow a result to one kind, failing loudly with what came back. */
function como<K extends ResultadoPersistencia['kind']>(
  resultado: ResultadoPersistencia,
  kind: K,
): Extract<ResultadoPersistencia, { kind: K }> {
  expect(resultado.kind, JSON.stringify(resultado)).toBe(kind);
  return resultado as Extract<ResultadoPersistencia, { kind: K }>;
}

let fake: FakeDb;
let db: Firestore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  fake = new FakeDb();
  db = comoFirestore(fake);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ----------------------------- persistirLinks: create ----------------------------- */

describe('persistirLinks — creating the links and flipping the estado', () => {
  it('writes the links and the estado flip in ONE commit', async () => {
    semear(fake);

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'criado').transicao).toBe(
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    );
    expect(fake.filhos(P_LINKS)).toEqual([idLink(1), idLink(2)]);
    expect(fake.read(pLink(1))).toMatchObject({
      valorCobrado: 50,
      id: 'pref-1',
      link: 'https://mp.test/pref-1',
      status: STATUS_LINK_PAGAMENTO.aberto,
      criadoPorOuterRef: USUARIO,
    });
    // One attempt, one commit, three writes: two creates and the pedido update.
    expect(fake.occ.txLog.filter((e) => e.phase === 'commit')).toHaveLength(1);
    expect(fake.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(0);
    expect(fake.patches.map((p) => p.path)).toEqual([pLink(1), pLink(2), P_PEDIDO]);
    expect(fake.writes.map((w) => w.op)).toEqual(['create', 'create', 'update']);
  });

  it('writes NOTHING on the pedido but estado and ultimaModificacao', async () => {
    semear(fake);

    await persistirLinks(db, pedido());

    const flip = fake.patches.find((p) => p.path === P_PEDIDO);
    expect(Object.keys(flip?.data ?? {}).sort()).toEqual(['estado', 'ultimaModificacao']);
    expect(fake.read(P_PEDIDO)).toEqual(
      pedidoSalvo({
        estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        ultimaModificacao: AGORA_US,
      }),
    );
  });

  it('stamps ultimaModificacao as max(stored, now): a stored FUTURE value is preserved', async () => {
    const futuro = AGORA_US + 60_000_000;
    semear(fake, pedidoSalvo({ ultimaModificacao: futuro }));

    await persistirLinks(db, pedido());

    expect(fake.read(P_PEDIDO)?.ultimaModificacao).toBe(futuro);
  });

  it('moves ultimaModificacao forward when the stored value is older, in µs', async () => {
    semear(fake, pedidoSalvo({ ultimaModificacao: AGORA_US - 1 }));

    await persistirLinks(db, pedido());

    expect(fake.read(P_PEDIDO)?.ultimaModificacao).toBe(AGORA_US);
  });

  it('reads a legacy MILLISECOND ultimaModificacao on the µs scale before comparing', async () => {
    // 1.79e12 ms is in the past (it is 1.79e15 µs): the flip stamps `now`.
    semear(fake, pedidoSalvo({ ultimaModificacao: AGORA - 1000 }));
    await persistirLinks(db, pedido());
    expect(fake.read(P_PEDIDO)?.ultimaModificacao).toBe(AGORA_US);

    // ...and one in the FUTURE, still in ms, is kept (as µs), never read as a tiny number.
    const outro = new FakeDb();
    semear(outro, pedidoSalvo({ ultimaModificacao: AGORA + 5000 }));
    await persistirLinks(comoFirestore(outro), pedido());
    expect(outro.read(P_PEDIDO)?.ultimaModificacao).toBe((AGORA + 5000) * 1000);
  });

  it('treats a pedido with no readable ultimaModificacao as 0 and stamps now', async () => {
    semear(fake, pedidoSalvo({ ultimaModificacao: null }));
    await persistirLinks(db, pedido());
    expect(fake.read(P_PEDIDO)?.ultimaModificacao).toBe(AGORA_US);
  });

  it.each([
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ESTADO_PEDIDO.escolhendoFormaDePagamento,
    ESTADO_PEDIDO.carrinho,
    ESTADO_PEDIDO.pagamentoNaoRealizado,
  ] as EstadoPedido[])(
    'creates the links but does NOT write the pedido from %s',
    async (estado) => {
      // Kills an unconditional flip, and one gated on "not pago" rather than on iniciado.
      semear(fake, pedidoSalvo({ estado }));

      const resultado = await persistirLinks(db, pedido());

      expect(como(resultado, 'criado').transicao).toBeNull();
      expect(fake.filhos(P_LINKS)).toEqual([idLink(1), idLink(2)]);
      expect(fake.read(P_PEDIDO)).toEqual(pedidoSalvo({ estado }));
      expect(fake.writes.filter((w) => w.path === P_PEDIDO)).toEqual([]);
    },
  );

  it('rejects an empty batch instead of flipping the estado with no link behind it', async () => {
    semear(fake);

    await expect(persistirLinks(db, pedido({ novos: [] }))).rejects.toThrow(TypeError);

    expect(fake.occ.txLog).toEqual([]);
    expect(fake.read(P_PEDIDO)).toEqual(pedidoSalvo());
  });

  it('rejects an invalid doc BEFORE opening a transaction', async () => {
    semear(fake);

    await expect(
      persistirLinks(db, pedido({ novos: [novo(1, { valorCobrado: 0.001 }), novo(2)] })),
    ).rejects.toThrow();

    expect(fake.occ.txLog).toEqual([]);
    expect(fake.filhos(P_LINKS)).toEqual([]);
  });
});

/* ------------------------------ persistirLinks: gates ------------------------------ */

describe('persistirLinks — the gates are re-derived from the transaction’s own reads', () => {
  it('answers pedidoInexistente for a pedido that is not there, writing nothing', async () => {
    semear(fake, null);

    expect(como(await persistirLinks(db, pedido()), 'pedidoInexistente')).toBeDefined();
    expect(fake.writes).toEqual([]);
  });

  it('refuses an estado it cannot read (fails closed)', async () => {
    semear(fake, pedidoSalvo({ estado: 'lixo' }));

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.estado);
    expect(fake.writes).toEqual([]);
  });

  it('refuses when the pedido is cancelled by a competing writer between the read and the commit', async () => {
    // The class-C proof: the first attempt decided "criar" on an `iniciado` pedido;
    // the retry must re-derive from the new read, not replay that decision.
    semear(fake);
    let disputou = false;
    fake.occ.beforeCommit = async () => {
      if (disputou) return;
      disputou = true;
      await fake.occ.runTransaction(async (tx) => {
        tx.update(fake.docRef(P_PEDIDO), { estado: ESTADO_PEDIDO.cancelado });
      });
    };

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.estado);
    expect(fake.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    expect(fake.filhos(P_LINKS)).toEqual([]);
    // The pedido is exactly what the competitor left — no flip on top of it.
    expect(fake.read(P_PEDIDO)).toEqual(pedidoSalvo({ estado: ESTADO_PEDIDO.cancelado }));
  });

  it('refuses a split made on a total that is one centavo off the stored one', async () => {
    semear(fake);

    const resultado = await persistirLinks(db, pedido({ valorCobradoEsperado: 100.01 }));

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.valorDesatualizado);
    expect(fake.filhos(P_LINKS)).toEqual([]);
  });

  it('refuses when the total moved between the read and the commit (a stale expectation)', async () => {
    semear(fake);
    let disputou = false;
    fake.occ.beforeCommit = async () => {
      if (disputou) return;
      disputou = true;
      await fake.occ.runTransaction(async (tx) => {
        tx.update(fake.docRef(P_PEDIDO), { valorCobrado: 120 });
      });
    };

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.valorDesatualizado);
    expect(fake.filhos(P_LINKS)).toEqual([]);
  });

  it('sizes the batch against the paying pagamentos it reads', async () => {
    semear(fake);
    fake.seed(`${P_PAGAMENTOS}/p1`, {
      valor: 40,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
    });

    // Two links of 50 = 100 > the 60 still owed...
    const grande = await persistirLinks(db, pedido());
    expect(como(grande, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
    expect(fake.filhos(P_LINKS)).toEqual([]);

    // ...and 30 + 30 = 60 fits exactly.
    const exato = await persistirLinks(
      db,
      pedido({ novos: [novo(1, { valorCobrado: 30 }), novo(2, { valorCobrado: 30 })] }),
    );
    expect(como(exato, 'criado').transicao).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('adds the links still open to the exposure: R$ 40,00 open leaves R$ 60,00 to issue', async () => {
    semear(fake);
    fake.seed(`${P_LINKS}/OPEN`, linkArmazenado(9, { valorCobrado: 40 }));

    const acima = await persistirLinks(db, pedido({ novos: [novo(1, { valorCobrado: 60.01 })] }));
    expect(como(acima, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
    expect(fake.filhos(P_LINKS)).toEqual(['OPEN']);

    // Exactly the rest: 40 already exposed + 60 = the 100 owed.
    const exato = await persistirLinks(db, pedido({ novos: [novo(1, { valorCobrado: 60 })] }));
    expect(como(exato, 'criado').transicao).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('ignores a stored link once it has lapsed — but not one millisecond before', async () => {
    semear(fake);
    const inteiro = pedido({ novos: [novo(1, { valorCobrado: 100 })] });

    // Expires AT the instant of the request: still payable, so still exposure.
    fake.seed(`${P_LINKS}/OPEN`, linkArmazenado(9, { valorCobrado: 40, dataExpiracao: AGORA }));
    const aindaAberto = await persistirLinks(db, inteiro);
    expect(como(aindaAberto, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.excedeRestante);

    // Expired a millisecond ago: worth nothing, and the full total fits.
    fake.seed(`${P_LINKS}/OPEN`, linkArmazenado(9, { valorCobrado: 40, dataExpiracao: AGORA - 1 }));
    const expirado = await persistirLinks(db, inteiro);
    expect(como(expirado, 'criado').transicao).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('refuses a pedido that already holds the maximum number of links', async () => {
    semear(fake);
    for (let n = 100; n < 150; n += 1) {
      fake.seed(
        `${P_LINKS}/${idLink(n)}`,
        linkArmazenado(n, { status: STATUS_LINK_PAGAMENTO.cancelado }),
      );
    }
    const inteiro = pedido({ novos: [novo(1, { valorCobrado: 100 })] });

    expect(como(await persistirLinks(db, inteiro), 'recusado').motivo).toBe(
      MOTIVO_RECUSA_LINK.limiteLinks,
    );

    // Near-miss: one fewer stored link and the same request fits.
    const limpo = new FakeDb();
    semear(limpo);
    for (let n = 100; n < 149; n += 1) {
      limpo.seed(
        `${P_LINKS}/${idLink(n)}`,
        linkArmazenado(n, { status: STATUS_LINK_PAGAMENTO.cancelado }),
      );
    }
    expect(como(await persistirLinks(comoFirestore(limpo), inteiro), 'criado')).toBeDefined();
  });

  describe('the sales channel', () => {
    it('refuses a marketplace pedido', async () => {
      semear(fake);
      fake.seed('integracao/int1', { tipo: INTEGRACAO_TIPO.mercadoLivre });

      const resultado = await persistirLinks(db, pedido());

      expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.canal);
      expect(fake.writes).toEqual([]);
    });

    it('fails closed when the integração no longer exists', async () => {
      semear(fake);
      fake.seed(P_PEDIDO, pedidoSalvo({ integracaoPedidoOuterRef: 'documents/integracao/sumiu' }));

      expect(como(await persistirLinks(db, pedido()), 'recusado').motivo).toBe(
        MOTIVO_RECUSA_LINK.canal,
      );
    });

    it('allows a pedido whose channel is not a marketplace, or has none', async () => {
      semear(fake, pedidoSalvo({ integracaoPedidoOuterRef: null }));
      expect(como(await persistirLinks(db, pedido()), 'criado')).toBeDefined();
    });

    it('re-reads the integração on a retry: a channel changed to a marketplace meanwhile refuses', async () => {
      semear(fake);
      let disputou = false;
      fake.occ.beforeCommit = async () => {
        if (disputou) return;
        disputou = true;
        await fake.occ.runTransaction(async (tx) => {
          tx.update(fake.docRef(P_PEDIDO), { integracaoPedidoOuterRef: 'documents/integracao/ml' });
        });
        fake.seed('integracao/ml', { tipo: INTEGRACAO_TIPO.mercadoLivre });
      };

      const resultado = await persistirLinks(db, pedido());

      expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.canal);
      expect(fake.filhos(P_LINKS)).toEqual([]);
    });
  });

  describe('the NF-e lock', () => {
    function nfe(id: string, estado: EstadoNFe, ultimaModificacao: number): void {
      fake.seed(`${P_NFES}/${id}`, { estado, ultima_modificacao: ultimaModificacao });
    }

    it('refuses an aprovada NF-e on a pedido whose estado locks the pagamentos', async () => {
      semear(fake, pedidoSalvo({ estado: ESTADO_PEDIDO.carrinho }));
      nfe('n1', ESTADO_NFE.aprovada, 1000);

      const resultado = await persistirLinks(db, pedido());

      expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.nfe);
      expect(fake.writes).toEqual([]);
    });

    it.each([
      ESTADO_PEDIDO.iniciado,
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ] as EstadoPedido[])(
      'does NOT refuse an aprovada NF-e from %s — the editor’s own carve-out',
      async (estado) => {
        semear(fake, pedidoSalvo({ estado }));
        nfe('n1', ESTADO_NFE.aprovada, 1000);

        expect(como(await persistirLinks(db, pedido()), 'criado')).toBeDefined();
      },
    );

    it('refuses a cancelada NF-e even from iniciado (a hard lock)', async () => {
      semear(fake);
      nfe('n1', ESTADO_NFE.cancelada, 1000);

      expect(como(await persistirLinks(db, pedido()), 'recusado').motivo).toBe(
        MOTIVO_RECUSA_LINK.nfe,
      );
    });

    it('follows the NEWEST NF-e: a fresh unsent one after a cancelled attempt does not lock', async () => {
      semear(fake);
      nfe('velha', ESTADO_NFE.cancelada, 1000);
      nfe('nova', ESTADO_NFE.gerado, 2000);

      expect(como(await persistirLinks(db, pedido()), 'criado')).toBeDefined();
    });

    it('re-reads the NF-e on a retry: one approved meanwhile refuses', async () => {
      semear(fake, pedidoSalvo({ estado: ESTADO_PEDIDO.carrinho }));
      let disputou = false;
      fake.occ.beforeCommit = async () => {
        if (disputou) return;
        disputou = true;
        await fake.occ.runTransaction(async (tx) => {
          tx.create(fake.docRef(`${P_NFES}/n1`), {
            estado: ESTADO_NFE.aprovada,
            ultima_modificacao: 1000,
          });
        });
      };

      const resultado = await persistirLinks(db, pedido());

      expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.nfe);
      expect(fake.filhos(P_LINKS)).toEqual([]);
    });
  });
});

/* ------------------------- persistirLinks: concurrent batches ------------------------- */

describe('persistirLinks — two DIFFERENT concurrent batches cannot together exceed the restante', () => {
  /**
   * Hold the first transaction after it decided, let `concorrente` run to
   * completion, then let the first commit (or retry). Returns the concurrent's
   * result once the first has finished.
   */
  function segurarAte(concorrente: () => Promise<ResultadoPersistencia>) {
    let resultado: ResultadoPersistencia | undefined;
    let disputou = false;
    fake.occ.beforeCommit = async () => {
      if (disputou) return;
      disputou = true;
      resultado = await concorrente();
    };
    return (): ResultadoPersistencia => {
      if (resultado === undefined) throw new Error('the concurrent batch never ran');
      return resultado;
    };
  }

  it('commits exactly one when each batch fits alone but the two together are twice the restante', async () => {
    semear(fake);
    const loteA = pedido({ novos: [novo(1), novo(2)] }); // 100
    const loteB = pedido({ novos: [novo(3), novo(4)] }); // 100, other ids
    const resultadoB = segurarAte(() => persistirLinks(db, loteB));

    const resultadoA = await persistirLinks(db, loteA);

    expect(como(resultadoB(), 'criado').transicao).toBe(
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    );
    expect(como(resultadoA, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
    expect(fake.filhos(P_LINKS)).toEqual([idLink(3), idLink(4)]);
  });

  it('commits both when together they fit exactly — the refusal above is the exposure, not the race', async () => {
    semear(fake);
    const loteA = pedido({ novos: [novo(1)] }); // 50
    const loteB = pedido({ novos: [novo(3)] }); // 50
    const resultadoB = segurarAte(() => persistirLinks(db, loteB));

    const resultadoA = await persistirLinks(db, loteA);

    expect(como(resultadoB(), 'criado').transicao).toBe(
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    );
    // The loser retried, saw the winner's flip, and did not flip again.
    expect(como(resultadoA, 'criado').transicao).toBeNull();
    expect(fake.filhos(P_LINKS)).toEqual([idLink(1), idLink(3)]);
    expect(fake.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    // The estado flip was committed exactly once.
    expect(fake.patches.filter((p) => p.path === P_PEDIDO)).toHaveLength(1);
  });

  it('gives an identical twin the winner’s links instead of a second set', async () => {
    semear(fake);
    const resultadoB = segurarAte(() => persistirLinks(db, pedido()));

    const resultadoA = await persistirLinks(db, pedido());

    expect(como(resultadoB(), 'criado')).toBeDefined();
    const perdedor = como(resultadoA, 'reaproveitado');
    expect(perdedor.links.map((l) => l.id)).toEqual([idLink(1), idLink(2)]);
    expect(perdedor.links.map((l) => l.data.id)).toEqual(['pref-1', 'pref-2']);
    // One set of documents, one flip — the loser committed nothing.
    expect(fake.filhos(P_LINKS)).toEqual([idLink(1), idLink(2)]);
    expect(fake.patches).toHaveLength(3);
    expect(fake.patches.filter((p) => p.path === P_PEDIDO)).toHaveLength(1);
  });

  it('adopts the winner when the twin surfaces as ALREADY_EXISTS at commit', async () => {
    // A twin whose commit the engine cannot see (no version moves), so this
    // transaction reaches its `create` and the store answers ALREADY_EXISTS.
    semear(fake);
    let disputou = false;
    fake.occ.beforeCommit = () => {
      if (disputou) return;
      disputou = true;
      fake.seed(pLink(1), linkArmazenado(1, { link: 'https://mp.test/do-vencedor' }));
      fake.seed(pLink(2), linkArmazenado(2));
    };

    const resultado = await persistirLinks(db, pedido());

    const adotado = como(resultado, 'reaproveitado');
    expect(adotado.links[0]?.data.link).toBe('https://mp.test/do-vencedor');
    // This transaction never got past the first create: the pedido is untouched.
    expect(fake.read(P_PEDIDO)).toEqual(pedidoSalvo());
  });

  it('does NOT adopt an ALREADY_EXISTS whose documents belong to someone else', async () => {
    semear(fake);
    let disputou = false;
    fake.occ.beforeCommit = () => {
      if (disputou) return;
      disputou = true;
      fake.seed(pLink(1), linkArmazenado(1, { criadoPorOuterRef: OUTRO_USUARIO }));
      fake.seed(pLink(2), linkArmazenado(2, { criadoPorOuterRef: OUTRO_USUARIO }));
    };

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.conflitoLinkId);
  });

  it('rethrows any other commit failure instead of adopting it', async () => {
    semear(fake);
    fake.occ.beforeCommit = () => {
      throw grpc(14, 'UNAVAILABLE');
    };

    await expect(persistirLinks(db, pedido())).rejects.toMatchObject({ code: 14 });
    expect(fake.filhos(P_LINKS)).toEqual([]);
  });
});

/* ---------------------------- persistirLinks: ids and replay ---------------------------- */

describe('persistirLinks — client-minted ids', () => {
  it('answers a replay from what is stored, writing nothing at all', async () => {
    semear(fake, pedidoSalvo({ estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento }));
    fake.seed(pLink(1), linkArmazenado(1));
    fake.seed(pLink(2), linkArmazenado(2));

    const resultado = await persistirLinks(db, pedido());

    const replay = como(resultado, 'reaproveitado');
    expect(replay.links.map((l) => [l.id, l.data.valorCobrado, l.data.id])).toEqual([
      [idLink(1), 50, 'pref-1'],
      [idLink(2), 50, 'pref-2'],
    ]);
    expect(fake.writes).toEqual([]);
  });

  it('decides a replay BEFORE the pedido gates: it reports what exists', async () => {
    semear(fake, pedidoSalvo({ estado: ESTADO_PEDIDO.cancelado }));
    fake.seed(pLink(1), linkArmazenado(1));
    fake.seed(pLink(2), linkArmazenado(2));

    expect(como(await persistirLinks(db, pedido()), 'reaproveitado')).toBeDefined();
  });

  it('refuses a replay by ANOTHER operator: a colliding id is not theirs to read', async () => {
    semear(fake);
    fake.seed(pLink(1), linkArmazenado(1, { criadoPorOuterRef: OUTRO_USUARIO }));
    fake.seed(pLink(2), linkArmazenado(2, { criadoPorOuterRef: OUTRO_USUARIO }));

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.conflitoLinkId);
    expect(fake.writes).toEqual([]);
  });

  it('refuses a replay whose stored amount is one centavo off', async () => {
    semear(fake);
    fake.seed(pLink(1), linkArmazenado(1));
    fake.seed(pLink(2), linkArmazenado(2, { valorCobrado: 50.01 }));

    expect(como(await persistirLinks(db, pedido()), 'recusado').motivo).toBe(
      MOTIVO_RECUSA_LINK.conflitoLinkId,
    );
  });

  it('refuses a replay that stored no creator at all', async () => {
    semear(fake);
    fake.seed(pLink(1), linkArmazenado(1, { criadoPorOuterRef: null }));
    fake.seed(pLink(2), linkArmazenado(2, { criadoPorOuterRef: null }));

    expect(como(await persistirLinks(db, pedido()), 'recusado').motivo).toBe(
      MOTIVO_RECUSA_LINK.conflitoLinkId,
    );
  });

  it('refuses a PARTIAL overlap and creates none of the ids', async () => {
    semear(fake);
    fake.seed(pLink(1), linkArmazenado(1));

    const resultado = await persistirLinks(db, pedido());

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.conflitoLinkId);
    expect(fake.filhos(P_LINKS)).toEqual([idLink(1)]);
    expect(fake.read(P_PEDIDO)).toEqual(pedidoSalvo());
  });

  it('refuses a batch that names one id twice without opening a transaction', async () => {
    semear(fake);

    const resultado = await persistirLinks(db, pedido({ novos: [novo(1), novo(1)] }));

    expect(como(resultado, 'recusado').motivo).toBe(MOTIVO_RECUSA_LINK.conflitoLinkId);
    expect(fake.occ.txLog).toEqual([]);
  });
});

/* -------------------------------- marcarLinkTerminal -------------------------------- */

describe('marcarLinkTerminal', () => {
  const alvo = (sobra: Partial<Parameters<typeof marcarLinkTerminal>[1]> = {}) => ({
    pedidoId: PEDIDO,
    linkId: idLink(1),
    status: STATUS_LINK_PAGAMENTO.cancelado,
    encerradoEm: AGORA,
    encerradoPorOuterRef: USUARIO,
    erroEncerramento: null,
    ...sobra,
  });

  it('marks an open link and writes ONLY the four closing fields', async () => {
    fake.seed(pLink(1), linkArmazenado(1));

    expect(await marcarLinkTerminal(db, alvo())).toBe('marcado');

    const escrito = fake.patches.find((p) => p.path === pLink(1));
    expect(Object.keys(escrito?.data ?? {}).sort()).toEqual([
      'encerradoEm',
      'encerradoPorOuterRef',
      'erroEncerramento',
      'status',
    ]);
    expect(fake.read(pLink(1))).toEqual({
      ...linkArmazenado(1),
      status: STATUS_LINK_PAGAMENTO.cancelado,
      encerradoEm: AGORA,
      encerradoPorOuterRef: USUARIO,
      erroEncerramento: null,
    });
  });

  it('records an auto-close: concluido, no operator, the Mercado Pago error kept', async () => {
    fake.seed(pLink(1), linkArmazenado(1));

    const marcado = await marcarLinkTerminal(
      db,
      alvo({
        status: STATUS_LINK_PAGAMENTO.concluido,
        encerradoPorOuterRef: null,
        erroEncerramento: 'MP 400',
      }),
    );

    expect(marcado).toBe('marcado');
    expect(fake.read(pLink(1))).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.concluido,
      encerradoPorOuterRef: null,
      erroEncerramento: 'MP 400',
      encerradoEm: AGORA,
    });
  });

  it('is a no-op on a link that is already terminal — no second write, no re-stamp', async () => {
    fake.seed(pLink(1), linkArmazenado(1));
    await marcarLinkTerminal(db, alvo());
    const escritasAntes = fake.patches.length;

    const denovo = await marcarLinkTerminal(
      db,
      alvo({ encerradoEm: AGORA + DIA, encerradoPorOuterRef: OUTRO_USUARIO }),
    );

    expect(denovo).toBe('ja-terminal');
    expect(fake.patches).toHaveLength(escritasAntes);
    expect(fake.read(pLink(1))).toMatchObject({
      encerradoEm: AGORA,
      encerradoPorOuterRef: USUARIO,
    });
  });

  it('never moves a concluido link to cancelado, nor a cancelado one to concluido', async () => {
    fake.seed(pLink(1), linkArmazenado(1, { status: STATUS_LINK_PAGAMENTO.concluido }));
    expect(await marcarLinkTerminal(db, alvo({ status: STATUS_LINK_PAGAMENTO.cancelado }))).toBe(
      'ja-terminal',
    );
    expect(fake.read(pLink(1))?.status).toBe(STATUS_LINK_PAGAMENTO.concluido);

    fake.seed(pLink(2), linkArmazenado(2, { status: STATUS_LINK_PAGAMENTO.cancelado }));
    expect(
      await marcarLinkTerminal(
        db,
        alvo({ linkId: idLink(2), status: STATUS_LINK_PAGAMENTO.concluido }),
      ),
    ).toBe('ja-terminal');
    expect(fake.read(pLink(2))?.status).toBe(STATUS_LINK_PAGAMENTO.cancelado);
  });

  it('refuses to re-open a link — the target status must be terminal', async () => {
    fake.seed(pLink(1), linkArmazenado(1, { status: STATUS_LINK_PAGAMENTO.cancelado }));

    await expect(
      marcarLinkTerminal(db, alvo({ status: STATUS_LINK_PAGAMENTO.aberto } as never)),
    ).rejects.toThrow(TypeError);

    expect(fake.occ.txLog).toEqual([]);
    expect(fake.read(pLink(1))?.status).toBe(STATUS_LINK_PAGAMENTO.cancelado);
  });

  it('answers inexistente for a link that is not there — and creates nothing', async () => {
    expect(await marcarLinkTerminal(db, alvo())).toBe('inexistente');
    expect(fake.filhos(P_LINKS)).toEqual([]);
  });

  it('treats a legacy link with no status as open, and leaves its other fields alone', async () => {
    const legado: DocData = {
      contaMercadoPagoOuterRef: 'documents/metodo_pgto/m1',
      valorCobrado: 40,
      link: 'https://mp.test/legado',
      id: null,
      dataCriacao: AGORA - DIA,
      dataExpiracao: AGORA + DIA,
      // A key the schema does not model: a full rewrite would trip its strict parse.
      docId: 'abc',
    };
    fake.seed(pLink(1), legado);

    expect(await marcarLinkTerminal(db, alvo())).toBe('marcado');

    expect(fake.read(pLink(1))).toEqual({
      ...legado,
      status: STATUS_LINK_PAGAMENTO.cancelado,
      encerradoEm: AGORA,
      encerradoPorOuterRef: USUARIO,
      erroEncerramento: null,
    });
  });

  it('reads a stored status it cannot parse as aberto — like lerLink — and overwrites it', async () => {
    fake.seed(pLink(1), linkArmazenado(1, { status: 'lixo' }));

    expect(await marcarLinkTerminal(db, alvo())).toBe('marcado');

    expect(fake.patches).toHaveLength(1);
    expect(fake.read(pLink(1))).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.cancelado,
      encerradoEm: AGORA,
      encerradoPorOuterRef: USUARIO,
    });
    // The seam it closes: the reader every closer decides on says the same thing.
    expect(lerLink({ status: 'lixo' }).status).toBe(STATUS_LINK_PAGAMENTO.aberto);
  });

  it('still stands down on a READABLE terminal status (the near-miss of the above)', async () => {
    fake.seed(pLink(1), linkArmazenado(1, { status: STATUS_LINK_PAGAMENTO.concluido }));

    expect(await marcarLinkTerminal(db, alvo())).toBe('ja-terminal');
    expect(fake.patches).toEqual([]);
  });

  it('lets exactly one of two racing closers win; the loser re-reads and stands down', async () => {
    fake.seed(pLink(1), linkArmazenado(1));
    let disputou = false;
    let resultadoAuto: string | undefined;
    fake.occ.beforeCommit = async () => {
      if (disputou) return;
      disputou = true;
      // The webhook's auto-close commits while the operator's cancel is held.
      resultadoAuto = await marcarLinkTerminal(
        db,
        alvo({ status: STATUS_LINK_PAGAMENTO.concluido, encerradoPorOuterRef: null }),
      );
    };

    const resultadoCancelar = await marcarLinkTerminal(db, alvo());

    expect(resultadoAuto).toBe('marcado');
    expect(resultadoCancelar).toBe('ja-terminal');
    expect(fake.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    expect(fake.read(pLink(1))).toMatchObject({
      status: STATUS_LINK_PAGAMENTO.concluido,
      encerradoPorOuterRef: null,
    });
    expect(fake.patches).toHaveLength(1);
  });
});
