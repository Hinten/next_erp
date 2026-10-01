import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_FRETE, type FreteDoPedido, type IntFrete } from '@delfrance/schemas';

const h = vi.hoisted(() => ({ getDoc: vi.fn(), dereferenceOuterRef: vi.fn() }));
vi.mock('firebase/firestore', () => ({ getDoc: h.getDoc }));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: h.dereferenceOuterRef }));

import { decidirIntFrete, resolverIntFrete, tipoDeDespacho } from './intFrete';

/* -------------------------------- fixtures -------------------------------- */

const { shopee, mercadoLivre, melhorEnvios, retiradaNaLoja, motoboy } = INTEGRACAO_FRETE;

/** An `int_frete` document of `tipo`, as `resolverIntFrete` hands it to the rule. */
function docDe(tipo: string, id = 'int-1'): { id: string; data: IntFrete } {
  return { id, data: { tipo, nome: `conta ${tipo}` } as unknown as IntFrete };
}

const doc = (d: { id: string; data: IntFrete }) => ({
  fonte: 'doc',
  id: d.id,
  tipo: d.data.tipo,
  data: d.data,
});
const bloco = (tipo: string) => ({ fonte: 'bloco', id: null, tipo, data: null });

beforeEach(() => {
  vi.resetAllMocks();
});

/* ------------------------------ decidirIntFrete ----------------------------- */

describe('decidirIntFrete — a marketplace-owned block tipo wins, and only widens', () => {
  it('a shopee block with NO int_frete document dispatches on the block alone', () => {
    expect(decidirIntFrete(null, shopee)).toEqual(bloco(shopee));
  });

  it('a shopee block whose document names the SAME tipo keeps the document', () => {
    // The pair: equal tipos ⇒ `doc`, so a provider that reads the doc keeps it.
    const d = docDe(shopee);
    expect(decidirIntFrete(d, shopee)).toEqual(doc(d));
  });

  it('W5 — a shopee block beats a document of a NON-marketplace tipo (retiradaNaLoja)', () => {
    // The near-miss of the pair above: a document exists but disagrees. The
    // Shopee route checks the BLOCK, so dispatching on the document would print
    // a generic "retirada" label for a Shopee order.
    expect(decidirIntFrete(docDe(retiradaNaLoja), shopee)).toEqual(bloco(shopee));
  });

  it('two DIFFERENT marketplaces: the block wins over the document (either direction)', () => {
    expect(decidirIntFrete(docDe(mercadoLivre), shopee)).toEqual(bloco(shopee));
    expect(decidirIntFrete(docDe(shopee), mercadoLivre)).toEqual(bloco(mercadoLivre));
  });

  it('an ML block with its ML document keeps the document (today’s ML path, unchanged)', () => {
    const d = docDe(mercadoLivre, 'int-ml');
    expect(decidirIntFrete(d, mercadoLivre)).toEqual(doc(d));
  });

  it('an ML block whose ref was degraded to null on import still dispatches (bloco)', () => {
    expect(decidirIntFrete(null, mercadoLivre)).toEqual(bloco(mercadoLivre));
  });

  it('W4 — a NON-marketplace block (melhorEnvios) never widens: no document ⇒ null', () => {
    expect(decidirIntFrete(null, melhorEnvios)).toBeNull();
    expect(decidirIntFrete(null, motoboy)).toBeNull();
  });

  it('a NON-marketplace block never narrows either: the document decides, as before', () => {
    const d = docDe(retiradaNaLoja);
    expect(decidirIntFrete(d, melhorEnvios)).toEqual(doc(d));
  });

  it('no block tipo: the document decides, and no document ⇒ null (today’s behaviour)', () => {
    const d = docDe(melhorEnvios);
    expect(decidirIntFrete(d, null)).toEqual(doc(d));
    expect(decidirIntFrete(d, undefined)).toEqual(doc(d));
    expect(decidirIntFrete(null, null)).toBeNull();
    expect(decidirIntFrete(null, undefined)).toBeNull();
  });

  it('an unknown / legacy block string is NOT marketplace-owned (freightCapsFor tolerance)', () => {
    // Near-misses of `shopee`: a case variant and a padded value are not tipos.
    expect(decidirIntFrete(null, 'Shopee')).toBeNull();
    expect(decidirIntFrete(null, ' shopee')).toBeNull();
    expect(decidirIntFrete(null, 'correios')).toBeNull();
    const d = docDe(motoboy);
    expect(decidirIntFrete(d, 'Shopee')).toEqual(doc(d));
  });

  it('the bloco shape carries no id and no data, so no carrier can be handed a null id', () => {
    const r = decidirIntFrete(null, shopee);
    expect(r).not.toBeNull();
    expect(r!.fonte).toBe('bloco');
    expect(r!.id).toBeNull();
    expect(r!.data).toBeNull();
  });
});

/* ------------------------------- tipoDeDespacho ----------------------------- */

describe('tipoDeDespacho — the same rule over the two tipos a caller holds', () => {
  it.each([
    // [docTipo, blocoTipo, expected]
    [null, shopee, shopee],
    [undefined, shopee, shopee],
    [shopee, shopee, shopee],
    [retiradaNaLoja, shopee, shopee], // W5
    [mercadoLivre, shopee, shopee],
    [shopee, mercadoLivre, mercadoLivre],
    [null, mercadoLivre, mercadoLivre],
    [null, melhorEnvios, null], // W4
    [retiradaNaLoja, melhorEnvios, retiradaNaLoja],
    [melhorEnvios, null, melhorEnvios],
    [melhorEnvios, undefined, melhorEnvios],
    [null, null, null],
    [undefined, undefined, null],
    [motoboy, 'Shopee', motoboy],
    [null, 'Shopee', null],
  ] as const)('doc %s + block %s ⇒ %s', (docTipo, blocoTipo, esperado) => {
    expect(tipoDeDespacho(docTipo, blocoTipo)).toBe(esperado);
  });

  it('agrees with decidirIntFrete on the dispatched tipo in every row above', () => {
    const tipos = [null, shopee, mercadoLivre, melhorEnvios, retiradaNaLoja, motoboy, 'Shopee'];
    for (const docTipo of tipos) {
      for (const blocoTipo of tipos) {
        const decidido = decidirIntFrete(docTipo === null ? null : docDe(docTipo), blocoTipo);
        expect(tipoDeDespacho(docTipo, blocoTipo)).toBe(decidido?.tipo ?? null);
      }
    }
  });
});

/* ------------------------------ resolverIntFrete ---------------------------- */

describe('resolverIntFrete — reads the document when there is one, then applies the rule', () => {
  const db = { __db: true } as never;
  const frete = (over: Partial<FreteDoPedido>) =>
    ({ integracaoFreteOuterRef: null, externalOptionIntegracao: null, ...over }) as FreteDoPedido;
  const snapDe = (d: { id: string; data: IntFrete } | null) =>
    d === null ? { exists: () => false } : { exists: () => true, id: d.id, data: () => d.data };

  it('no frete ⇒ null, and nothing is read', async () => {
    expect(await resolverIntFrete(db, null)).toBeNull();
    expect(h.dereferenceOuterRef).not.toHaveBeenCalled();
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('a Shopee pedido with NO ref resolves from the block, with ZERO document reads', async () => {
    h.dereferenceOuterRef.mockReturnValue(null);
    const r = await resolverIntFrete(db, frete({ externalOptionIntegracao: shopee }));
    expect(r).toEqual(bloco(shopee));
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('dereferences the block’s own ref and reads THAT document', async () => {
    const ref = { __ref: 'int_frete/int-1' };
    h.dereferenceOuterRef.mockReturnValue(ref);
    const d = docDe(melhorEnvios);
    h.getDoc.mockResolvedValue(snapDe(d));

    const r = await resolverIntFrete(
      db,
      frete({ integracaoFreteOuterRef: 'documents/int_frete/int-1' }),
    );
    expect(h.dereferenceOuterRef).toHaveBeenCalledWith(db, 'documents/int_frete/int-1');
    expect(h.getDoc).toHaveBeenCalledTimes(1);
    expect(h.getDoc).toHaveBeenCalledWith(ref);
    expect(r).toEqual(doc(d));
  });

  it('a dangling ref with no marketplace block ⇒ null (the "sem integração" answer)', async () => {
    h.dereferenceOuterRef.mockReturnValue({ __ref: 'int_frete/gone' });
    h.getDoc.mockResolvedValue(snapDe(null));
    expect(
      await resolverIntFrete(db, frete({ integracaoFreteOuterRef: 'documents/int_frete/gone' })),
    ).toBeNull();
  });

  it('a dangling ref under a marketplace block ⇒ bloco', async () => {
    h.dereferenceOuterRef.mockReturnValue({ __ref: 'int_frete/gone' });
    h.getDoc.mockResolvedValue(snapDe(null));
    expect(
      await resolverIntFrete(
        db,
        frete({
          integracaoFreteOuterRef: 'documents/int_frete/gone',
          externalOptionIntegracao: mercadoLivre,
        }),
      ),
    ).toEqual(bloco(mercadoLivre));
  });

  it('W5 through the reader: a shopee block beats a retiradaNaLoja document', async () => {
    h.dereferenceOuterRef.mockReturnValue({ __ref: 'int_frete/int-1' });
    h.getDoc.mockResolvedValue(snapDe(docDe(retiradaNaLoja)));
    expect(
      await resolverIntFrete(
        db,
        frete({
          integracaoFreteOuterRef: 'documents/int_frete/int-1',
          externalOptionIntegracao: shopee,
        }),
      ),
    ).toEqual(bloco(shopee));
  });

  it('W4 through the reader: a melhorEnvios block with no ref ⇒ null', async () => {
    h.dereferenceOuterRef.mockReturnValue(null);
    expect(
      await resolverIntFrete(db, frete({ externalOptionIntegracao: melhorEnvios })),
    ).toBeNull();
  });

  it('propagates a read failure (the caller’s deadline / catch owns it)', async () => {
    const boom = new RangeError('read failed');
    h.dereferenceOuterRef.mockReturnValue({ __ref: 'int_frete/int-1' });
    h.getDoc.mockRejectedValue(boom);
    await expect(
      resolverIntFrete(
        db,
        frete({
          integracaoFreteOuterRef: 'documents/int_frete/int-1',
          externalOptionIntegracao: shopee,
        }),
      ),
    ).rejects.toBe(boom);
  });

  // Review 2 (I3): the reader's half of the same-tipo pair. A reader that
  // skipped the `getDoc` under a marketplace block would still pass every
  // `bloco` row above — only a block WITH its own-tipo document tells it apart.
  it('a MIGRATED legacy Shopee pedido: a shopee block with a shopee document ⇒ doc, read once', async () => {
    const ref = { __ref: 'int_frete/int-1' };
    h.dereferenceOuterRef.mockReturnValue(ref);
    const d = docDe(shopee);
    h.getDoc.mockResolvedValue(snapDe(d));

    const r = await resolverIntFrete(
      db,
      frete({
        integracaoFreteOuterRef: 'documents/int_frete/int-1',
        externalOptionIntegracao: shopee,
      }),
    );
    expect(h.getDoc).toHaveBeenCalledTimes(1);
    expect(h.getDoc).toHaveBeenCalledWith(ref);
    expect(r).toEqual(doc(d));
  });

  it('an ML block with its ML document ⇒ doc through the reader (today’s ML path)', async () => {
    h.dereferenceOuterRef.mockReturnValue({ __ref: 'int_frete/int-ml' });
    const d = docDe(mercadoLivre, 'int-ml');
    h.getDoc.mockResolvedValue(snapDe(d));
    expect(
      await resolverIntFrete(
        db,
        frete({
          integracaoFreteOuterRef: 'documents/int_frete/int-ml',
          externalOptionIntegracao: mercadoLivre,
        }),
      ),
    ).toEqual(doc(d));
    expect(h.getDoc).toHaveBeenCalledTimes(1);
  });
});
