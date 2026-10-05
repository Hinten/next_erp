import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  adicionarConta,
  contaIdFromRef,
  contaRefForms,
  planLinkChange,
  removerContaSeOrfa,
  type SentinelasDeArray,
} from './integracoesComProduto';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
/**
 * Per-suite in-memory double, this package's convention
 * (`resolveProdutoPorSku.test.ts`, `firestoreImpostoResolver.test.ts`) —
 * packages/data cannot import from apps/.
 *
 * Scoped to what the module touches: `produtos/<id>` (`update`, which must
 * throw gRPC 5 when the doc is absent — the cascade race both writers narrow)
 * and a read-write transaction. The channel's survivor QUERY never appears
 * here: it is injected as a closure, which is the whole point of the promotion.
 *
 * ⚠️ Writes inside the transaction are buffered and applied on commit, so a
 * `tx.update` on a produto the cascade already removed fails at COMMIT the way
 * the real SDK does. `opLog` is real, so the zero-write assertions mean
 * something.
 */
type DocData = Record<string, unknown>;

class NotFoundError extends Error {
  readonly code = 5;
  constructor(path: string) {
    super(`NOT_FOUND: ${path}`);
    this.name = 'NotFoundError';
  }
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'update'; path: string }> = [];
  /** Patches handed to `update`, in call order — the assertion surface. */
  readonly patches: Array<{ path: string; patch: DocData }> = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): this {
    this.col(path).set(id, data);
    return this;
  }

  collection(path: string) {
    const self = this;
    return {
      doc(id: string) {
        const docPath = `${path}/${id}`;
        return {
          id,
          path: docPath,
          async get() {
            self.opLog.push({ op: 'get', path: docPath });
            const col = self.col(path);
            return { exists: col.has(id), id, data: () => col.get(id) };
          },
          async update(patch: DocData) {
            self.opLog.push({ op: 'update', path: docPath });
            const col = self.col(path);
            if (!col.has(id)) throw new NotFoundError(docPath);
            self.patches.push({ path: docPath, patch });
          },
        };
      },
    };
  }

  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const buffered: Array<{ path: string; patch: DocData }> = [];
    const tx = {
      get: async (alvo: { get: () => Promise<unknown> }) => alvo.get(),
      update: (ref: { path: string }, patch: DocData) => {
        buffered.push({ path: ref.path, patch });
      },
    };
    const saida = await fn(tx);
    for (const w of buffered) {
      const corte = w.path.lastIndexOf('/');
      const col = this.col(w.path.slice(0, corte));
      const id = w.path.slice(corte + 1);
      this.opLog.push({ op: 'update', path: w.path });
      if (!col.has(id)) throw new NotFoundError(w.path);
      this.patches.push(w);
    }
    return saida;
  }
}

const db = (f: FakeDb): Firestore => f as unknown as Firestore;

const CONTA = 'int-1';
const REF_CANONICO = `documents/integracao/${CONTA}`;

/**
 * The array sentinels, as the app supplies them — marker objects rather than
 * the real `FieldValue`, for two reasons. `packages/data/src/admin/**` may not
 * import `firebase-admin` at runtime ANYWHERE, tests included
 * (`adminBundleSafety.test.ts` scans the whole subtree); and distinguishable
 * markers are what let the assertions below prove WHICH sentinel each write
 * reached for, which the real ones — two opaque transform objects — could not.
 */
const SENTINELAS: SentinelasDeArray = {
  arrayUnion: (id) => ({ __sentinela: 'arrayUnion', id }),
  arrayRemove: (id) => ({ __sentinela: 'arrayRemove', id }),
};

/* -------------------------------------------------------------------------- */
/*                                pure helpers                                */
/* -------------------------------------------------------------------------- */

describe('contaIdFromRef', () => {
  it('PAR: as duas formas armazenadas do ref resolvem a MESMA conta', () => {
    // The fold this module exists to own: the array stores BARE ids, the link
    // docs store REF strings, and readers tolerate both spellings.
    expect(contaIdFromRef(`documents/integracao/${CONTA}`)).toBe(CONTA);
    expect(contaIdFromRef(`integracao/${CONTA}`)).toBe(CONTA);
  });

  it('⛔ QUASE-IGUAL: um ref que aponta para OUTRA coleção resolve NULL, não o último segmento', () => {
    // Where the fold STOPS. Taking the trailing segment would read
    // `documents/produtos/int-1` as the conta `int-1` and add a membership row
    // for a ref that names no conta at all.
    expect(contaIdFromRef(`documents/produtos/${CONTA}`)).toBeNull();
    expect(contaIdFromRef(`categorias/${CONTA}`)).toBeNull();
  });

  it('devolve null em vez de lançar sobre lixo — um doc ruim não pode cavalgar o retry do Eventarc para sempre', () => {
    expect(contaIdFromRef(undefined)).toBeNull();
    expect(contaIdFromRef(null)).toBeNull();
    expect(contaIdFromRef(42)).toBeNull();
    expect(contaIdFromRef('')).toBeNull();
    expect(contaIdFromRef('integracao')).toBeNull(); // odd segment count
  });
});

describe('contaRefForms', () => {
  it('enumera as DUAS formas — `endsWith` não é predicado do Firestore', () => {
    expect(contaRefForms(CONTA)).toEqual([`documents/integracao/${CONTA}`, `integracao/${CONTA}`]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               planLinkChange                               */
/* -------------------------------------------------------------------------- */

describe('planLinkChange', () => {
  /** A channel whose conta ref lives on a field of its own — the #1519 case. */
  const contaDoLink = (link: Record<string, unknown>) =>
    contaIdFromRef(link.contaProdutoShopeeOuterRef);
  /** Membership rule stand-in: this doc names a live listing. */
  const conta = (link: Record<string, unknown> | null) =>
    link != null && typeof link.item_id === 'number' && link.item_id > 0;

  const vivo = { contaProdutoShopeeOuterRef: REF_CANONICO, item_id: 2500139861 };
  const morto = { contaProdutoShopeeOuterRef: REF_CANONICO, item_id: 0 };

  it('⚠️ `contaDoLink` é OBRIGATÓRIO — um valor padrão baixaria a aridade para 3', () => {
    // The guarantee is the COMPILER's and no runtime call can observe it, so it
    // is pinned through `Function.length`, which counts only the parameters
    // BEFORE the first defaulted one. Give `contaDoLink` a default reading
    // `contaOuterRef` — the shape a copy-paste from Mercado Livre produces —
    // and every other channel's link answers null on both sides, takes the
    // zero-work fast path, and the trigger becomes a no-op that logs nothing.
    expect(planLinkChange.length).toBe(4);
  });

  it('PAR: um link que o leitor resolve para a conta entra em `add`', () => {
    expect(planLinkChange(null, vivo, conta, contaDoLink)).toEqual({ add: [CONTA], check: [] });
  });

  it('⛔ QUASE-IGUAL: um doc cujo leitor devolve NULL é ignorado — nem add nem check', () => {
    // M-92, directly. The same document carrying Mercado Livre's field name
    // instead: if `contaDoLink` were defaulted to `contaOuterRef`, THIS is the
    // doc that would answer, and the one above would answer null — a trigger
    // that logs nothing and does nothing, which is the silent-outage direction.
    const comCampoDoOutroCanal = { contaOuterRef: REF_CANONICO, item_id: 2500139861 };
    expect(planLinkChange(null, comCampoDoOutroCanal, conta, contaDoLink)).toEqual({
      add: [],
      check: [],
    });
    expect(planLinkChange(comCampoDoOutroCanal, null, conta, contaDoLink)).toEqual({
      add: [],
      check: [],
    });
  });

  it('`contaDoLink` recebe o DOCUMENTO e é a ÚNICA autoridade sobre o campo', () => {
    const leitor = vi.fn(() => CONTA);
    expect(planLinkChange(null, vivo, conta, leitor)).toEqual({ add: [CONTA], check: [] });
    expect(leitor).toHaveBeenCalledWith(vivo);
    // `before` is null, so the reader is asked exactly once — the plan never
    // invents a conta for a document that does not exist.
    expect(leitor).toHaveBeenCalledTimes(1);
  });

  it('PAR: o caminho de custo ZERO — uma reescrita de rotina devolve {add:[],check:[]}', () => {
    // Load-bearing: link docs are rewritten constantly for reasons that cannot
    // move membership, and an empty plan is what makes those events cost the
    // trigger no read and no write at all.
    const depois = { ...vivo, ultimaModificacao: 1, errors: ['x'] };
    expect(planLinkChange(vivo, depois, conta, contaDoLink)).toEqual({ add: [], check: [] });
    expect(planLinkChange(morto, { ...morto, sku: 'X' }, conta, contaDoLink)).toEqual({
      add: [],
      check: [],
    });
  });

  it('⛔ QUASE-IGUAL: re-apontar o ref da conta NÃO é o caminho de custo zero', () => {
    // Where the fast path STOPS: same doc, same membership contribution, but a
    // different conta. Comparing only `counts(before) === counts(after)` would
    // swallow this and leave the old conta listed forever.
    const outra = { ...vivo, contaProdutoShopeeOuterRef: 'documents/integracao/int-2' };
    expect(planLinkChange(vivo, outra, conta, contaDoLink)).toEqual({
      add: ['int-2'],
      check: [CONTA],
    });
  });

  it('um link que deixou de contar marca a conta para CHECK, nunca para remoção', () => {
    expect(planLinkChange(vivo, morto, conta, contaDoLink)).toEqual({ add: [], check: [CONTA] });
    expect(planLinkChange(vivo, null, conta, contaDoLink)).toEqual({ add: [], check: [CONTA] });
  });

  it('volta a adicionar quando um link morto revive (auto-cura)', () => {
    expect(planLinkChange(morto, vivo, conta, contaDoLink)).toEqual({ add: [CONTA], check: [] });
  });

  it('não checa uma conta para a qual este doc NUNCA contribuiu — isso compraria uma transação e nada mais', () => {
    const outraMorta = { ...morto, contaProdutoShopeeOuterRef: 'documents/integracao/int-2' };
    expect(planLinkChange(morto, outraMorta, conta, contaDoLink)).toEqual({ add: [], check: [] });
  });
});

/* -------------------------------------------------------------------------- */
/*                                     IO                                     */
/* -------------------------------------------------------------------------- */

describe('adicionarConta', () => {
  it('⚠️ as sentinelas são OBRIGATÓRIAS nos dois escritores — um padrão baixaria a aridade', () => {
    // Same device, same reason: `packages/data/src/admin/**` cannot import
    // `FieldValue`, so a default here could only be a no-op stand-in, and the
    // write would silently store a plain value over the whole array.
    expect(adicionarConta.length).toBe(4);
    expect(removerContaSeOrfa.length).toBe(5);
  });

  it('escreve SÓ a chave do array, com a sentinela de UNIÃO — sem carimbos, ou todo publish agita os monitores da TableView', async () => {
    const f = new FakeDb().seed('produtos', 'p1', { nome: 'x' });
    await expect(adicionarConta(db(f), 'p1', CONTA, SENTINELAS)).resolves.toBe(true);
    expect(f.patches).toHaveLength(1);
    expect(Object.keys(f.patches[0]!.patch)).toEqual(['integracoesComProduto']);
    // ⛔ The swap guard: `arrayRemove` here would delete the conta on the ADD
    // path — the silent stock + price outage — and both sentinels have the same
    // type, so only the NAME distinguishes them.
    expect(f.patches[0]!.patch.integracoesComProduto).toEqual({
      __sentinela: 'arrayUnion',
      id: CONTA,
    });
    // Tier 0: no read at all, so a redelivery costs one idempotent write.
    expect(f.opLog.filter((o) => o.op === 'get')).toHaveLength(0);
  });

  it('reporta que o produto sumiu em vez de ressuscitá-lo como casca de um campo', async () => {
    const f = new FakeDb();
    await expect(adicionarConta(db(f), 'sumiu', CONTA, SENTINELAS)).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });
});

describe('removerContaSeOrfa', () => {
  const produtoComConta = () =>
    new FakeDb().seed('produtos', 'p1', { integracoesComProduto: [CONTA] });

  it('remove com a sentinela de REMOÇÃO quando o leitor de sobreviventes diz que não sobrou nenhum', async () => {
    const f = produtoComConta();
    await expect(
      removerContaSeOrfa(db(f), 'p1', CONTA, async () => false, SENTINELAS),
    ).resolves.toBe(true);
    expect(f.patches[0]!.patch.integracoesComProduto).toEqual({
      __sentinela: 'arrayRemove',
      id: CONTA,
    });
  });

  it('NÃO escreve nada enquanto o leitor diz que sobrou — a remoção errada é a direção do apagão silencioso', async () => {
    const f = produtoComConta();
    await expect(
      removerContaSeOrfa(db(f), 'p1', CONTA, async () => true, SENTINELAS),
    ).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });

  it('re-deriva o veredito DENTRO da transação, nunca de um valor capturado antes dela', async () => {
    // The OCC contract: a retry re-runs the callback but re-applies anything
    // captured in the closure verbatim. The survivors reader therefore has to
    // be CALLED inside, with the transaction handle, on every attempt — here a
    // competing publish lands after the caller decided to check.
    const f = produtoComConta();
    let sobreviveu = false;
    const sobrevivem = vi.fn(async (tx: unknown) => {
      expect(tx).toBeTruthy(); // it gets the transaction, not a captured snapshot
      return sobreviveu;
    });
    sobreviveu = true;
    await expect(removerContaSeOrfa(db(f), 'p1', CONTA, sobrevivem, SENTINELAS)).resolves.toBe(
      false,
    );
    expect(sobrevivem).toHaveBeenCalledTimes(1);
    expect(f.patches).toHaveLength(0);
  });

  it('engole a corrida do cascade — o produto sumiu no meio da transação', async () => {
    const f = new FakeDb(); // produto absent
    await expect(
      removerContaSeOrfa(db(f), 'p1', CONTA, async () => false, SENTINELAS),
    ).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });
});
