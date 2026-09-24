/**
 * `carregadorContextoRejeicao` (#852) — the Firestore-backed loader behind the
 * cStat 805 guidance. Offline: `getDoc`, both collection handles,
 * `dereferenceOuterRef` and the shared cliente reader are mocked, and the XML is
 * the homologação fixture (`<tpAmb>2</tpAmb>`), parsed by jsdom's DOMParser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError, initializeApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { TIPO_CLIENTE } from '@delfrance/schemas';

import { carregadorContextoRejeicao } from './contextoRejeicao';
import { ID_DEST, IND_IE_DEST } from './destinatarioNFe';
import { nfeAssinadoXml, nfeProcXml } from './nfeAssinadoFixture';

interface FakeRef {
  readonly kind: 'nfe' | 'pedido';
  readonly ctx: Record<string, string>;
  readonly id: string;
}

const h = vi.hoisted(() => ({
  getDoc: vi.fn(),
  dereferenceOuterRef: vi.fn(),
  readClienteByRef: vi.fn(),
  // Called by both mocked `docRef`s with their kind — a test makes it throw to
  // stand in for `doc()`'s synchronous path validation.
  docRef: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return { ...actual, getDoc: (...args: unknown[]) => h.getDoc(...args) };
});
vi.mock('@/lib/data/nfeCollection', () => ({
  nfeCollection: {
    docRef: (_db: unknown, ctx: Record<string, string>, id: string): FakeRef => {
      h.docRef('nfe');
      return { kind: 'nfe', ctx, id };
    },
  },
}));
vi.mock('@/lib/data/pedidoCollection', () => ({
  pedidoCollection: {
    docRef: (_db: unknown, ctx: Record<string, string>, id: string): FakeRef => {
      h.docRef('pedido');
      return { kind: 'pedido', ctx, id };
    },
  },
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (...args: unknown[]) => h.dereferenceOuterRef(...args),
}));
// Only the reader is stubbed: the collection check (`ehRefDeCliente`) is the real one.
vi.mock('@/lib/data/readClienteByRef', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/readClienteByRef')>()),
  readClienteByRef: (...args: unknown[]) => h.readClienteByRef(...args),
}));

const db = { __db: true } as unknown as Firestore;
/** A real, never-connected Firestore — only for the REAL `dereferenceOuterRef`'s `doc()`. */
const realDb = getFirestore(
  initializeApp({ projectId: 'demo-contexto-rejeicao' }, 'contexto-rejeicao-test'),
  'default',
);
const CLIENTE_REF = { id: 'cli-1', path: 'clientes/cli-1', parent: { id: 'clientes' } };
const XML_805 = nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' });
const alvo = { pedidoId: 'p1', nfeId: 'n1' } as const;

/** A snapshot stand-in: `data()` is all the loader reads. */
function snap(data: Record<string, unknown> | undefined) {
  return { data: () => data };
}

let nfeData: Record<string, unknown> | undefined;
let pedidoData: Record<string, unknown> | undefined;

beforeEach(() => {
  h.getDoc.mockReset();
  h.dereferenceOuterRef.mockReset();
  h.readClienteByRef.mockReset();
  h.docRef.mockReset();

  nfeData = { xml_assinado: XML_805, xml_nfe_proc: null, xml_epec_proc: null };
  pedidoData = { clientePedidoOuterRef: 'clientes/cli-1' };
  h.getDoc.mockImplementation(async (ref: FakeRef) =>
    snap(ref.kind === 'nfe' ? nfeData : pedidoData),
  );
  h.dereferenceOuterRef.mockImplementation((_db: unknown, ref: unknown) =>
    ref === 'clientes/cli-1' ? CLIENTE_REF : null,
  );
  h.readClienteByRef.mockResolvedValue({
    nome: 'ACME LTDA',
    tipo: TIPO_CLIENTE.pessoaJuridica,
    ie: 'ISENTO',
  });
});

describe('carregadorContextoRejeicao', () => {
  it('happy path: destinatário from xml_assinado + the cliente cadastro', async () => {
    expect(XML_805).toContain('<tpAmb>2</tpAmb>');

    const contexto = await carregadorContextoRejeicao(db)(alvo);

    expect(contexto).toEqual({
      destinatario: { idDest: ID_DEST.interna, indIEDest: IND_IE_DEST.isento, uf: 'SP' },
      cliente: {
        id: 'cli-1',
        cadastro: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: 'ISENTO' },
      },
    });
    // The nfev4 doc is addressed under ITS pedido, and the pedido by id.
    const refs = h.getDoc.mock.calls.map((c) => c[0] as FakeRef);
    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: 'nfe', ctx: { pedidoId: 'p1' }, id: 'n1' },
        { kind: 'pedido', ctx: {}, id: 'p1' },
      ]),
    );
    expect(h.getDoc).toHaveBeenCalledTimes(2);
    // The shared reader, with the dereferenced ref — the ClienteCell provenance.
    expect(h.dereferenceOuterRef).toHaveBeenCalledWith(db, 'clientes/cli-1');
    expect(h.readClienteByRef).toHaveBeenCalledWith(db, CLIENTE_REF);
  });

  it('falls back to xml_nfe_proc when xml_assinado is absent', async () => {
    nfeData = {
      xml_assinado: null,
      xml_nfe_proc: nfeProcXml({ idDest: '2', indIEDest: '2', ufDest: 'MG' }),
      xml_epec_proc: null,
    };
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.destinatario).toEqual({ idDest: '2', indIEDest: '2', uf: 'MG' });
  });

  it('never reads xml_epec_proc — an evento, not an NF-e', async () => {
    nfeData = { xml_assinado: null, xml_nfe_proc: null, xml_epec_proc: XML_805 };
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.destinatario).toBeNull();
  });

  it('maps a soft-read RAW cliente defensively: a non-string ie and an unknown tipo read as null', async () => {
    h.readClienteByRef.mockResolvedValue({ nome: 'ACME LTDA', tipo: 'x', ie: 123 });
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toEqual({
      id: 'cli-1',
      cadastro: { nome: 'ACME LTDA', tipo: null, ie: null },
    });
  });

  it('a non-string nome reads as null; a raw non-string xml_assinado degrades instead of throwing', async () => {
    h.readClienteByRef.mockResolvedValue({ nome: 42, tipo: TIPO_CLIENTE.pessoaFisica, ie: '' });
    nfeData = { xml_assinado: 7, xml_nfe_proc: null };
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto).toEqual({
      destinatario: null,
      cliente: { id: 'cli-1', cadastro: { nome: null, tipo: TIPO_CLIENTE.pessoaFisica, ie: '' } },
    });
  });

  it('nfev4 read rejected with a FirebaseError → destinatario null, no throw, cliente still loaded', async () => {
    h.getDoc.mockImplementation(async (ref: FakeRef) => {
      if (ref.kind === 'nfe') throw new FirebaseError('permission-denied', 'denied');
      return snap(pedidoData);
    });
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.destinatario).toBeNull();
    expect(contexto.cliente?.id).toBe('cli-1');
  });

  it('pedido read rejected with a FirebaseError → cliente null, destinatário kept', async () => {
    h.getDoc.mockImplementation(async (ref: FakeRef) => {
      if (ref.kind === 'pedido') throw new FirebaseError('unavailable', 'offline');
      return snap(nfeData);
    });
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toBeNull();
    expect(contexto.destinatario).toEqual({ idDest: '1', indIEDest: '2', uf: 'SP' });
    expect(h.readClienteByRef).not.toHaveBeenCalled();
  });

  it('cliente read rejected with a FirebaseError → { id, cadastro: null } — the link survives', async () => {
    h.readClienteByRef.mockRejectedValue(new FirebaseError('permission-denied', 'denied'));
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toEqual({ id: 'cli-1', cadastro: null });
    expect(contexto.destinatario).not.toBeNull();
  });

  it('cliente doc missing → { id, cadastro: null }', async () => {
    h.readClienteByRef.mockResolvedValue(null);
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toEqual({ id: 'cli-1', cadastro: null });
  });

  it('pedido without clientePedidoOuterRef → cliente null, and no cliente read', async () => {
    pedidoData = { clientePedidoOuterRef: null };
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toBeNull();
    expect(h.readClienteByRef).not.toHaveBeenCalled();
  });

  it('pedido doc missing → cliente null', async () => {
    pedidoData = undefined;
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toBeNull();
  });

  it('xml_assinado and xml_nfe_proc both null → destinatario null', async () => {
    nfeData = { xml_assinado: null, xml_nfe_proc: null, xml_epec_proc: null };
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.destinatario).toBeNull();
  });

  it('nfev4 doc missing → destinatario null', async () => {
    nfeData = undefined;
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.destinatario).toBeNull();
  });

  it('an opaque odd-segment ref ({ path: "clientes" }) makes doc() throw → cliente null, destinatário kept', async () => {
    // The REAL dereference, against a real Firestore: `doc(db, 'clientes')`
    // throws SYNCHRONOUSLY (a document path needs even segments) — a
    // FirebaseError, the class the loader narrows on.
    const { dereferenceOuterRef: real } = await vi.importActual<
      typeof import('@/lib/data/dereferenceOuterRef')
    >('@/lib/data/dereferenceOuterRef');
    const opaco = { path: 'clientes' };
    expect(() => real(realDb, opaco)).toThrow(FirebaseError);
    h.dereferenceOuterRef.mockImplementation(real);
    pedidoData = { clientePedidoOuterRef: opaco };

    const contexto = await carregadorContextoRejeicao(realDb)(alvo);

    expect(contexto).toEqual({
      destinatario: { idDest: ID_DEST.interna, indIEDest: IND_IE_DEST.isento, uf: 'SP' },
      cliente: null,
    });
    expect(h.readClienteByRef).not.toHaveBeenCalled();
  });

  it('a ref into ANOTHER collection → cliente null (no /clientes link to a different doc), no read', async () => {
    // Same id, other collection: `/clientes/cli-1` would open a DIFFERENT document.
    h.dereferenceOuterRef.mockReturnValue({
      id: 'cli-1',
      path: 'fornecedores/cli-1',
      parent: { id: 'fornecedores' },
    });
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toBeNull();
    expect(contexto.destinatario).toEqual({ idDest: '1', indIEDest: '2', uf: 'SP' });
    expect(h.readClienteByRef).not.toHaveBeenCalled();
  });

  // `doc()`'s path validation throws a FirestoreError — a FirebaseError subclass
  // whose constructor the public typings keep private, hence the base class here.
  it('the nfev4 docRef throwing a FirebaseError synchronously → destinatario null, cliente still loaded', async () => {
    h.docRef.mockImplementation((kind: FakeRef['kind']) => {
      if (kind === 'nfe') throw new FirebaseError('invalid-argument', 'Invalid document reference');
    });
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.destinatario).toBeNull();
    expect(contexto.cliente?.id).toBe('cli-1');
    // Only the pedido was read — the nfev4 ref never existed.
    expect(h.getDoc).toHaveBeenCalledTimes(1);
  });

  it('the pedido docRef throwing a FirebaseError synchronously → cliente null, destinatário kept', async () => {
    h.docRef.mockImplementation((kind: FakeRef['kind']) => {
      if (kind === 'pedido')
        throw new FirebaseError('invalid-argument', 'Invalid document reference');
    });
    const contexto = await carregadorContextoRejeicao(db)(alvo);
    expect(contexto.cliente).toBeNull();
    expect(contexto.destinatario).toEqual({ idDest: '1', indIEDest: '2', uf: 'SP' });
    expect(h.readClienteByRef).not.toHaveBeenCalled();
  });

  it('a non-Firebase rejection from getDoc (a TypeError) is rethrown', async () => {
    const bug = new TypeError('boom');
    h.getDoc.mockImplementation(async (ref: FakeRef) => {
      if (ref.kind === 'nfe') throw bug;
      return snap(pedidoData);
    });
    await expect(carregadorContextoRejeicao(db)(alvo)).rejects.toBe(bug);
  });

  it('a non-Firebase rejection from the pedido read is rethrown too', async () => {
    const bug = new RangeError('boom');
    h.getDoc.mockImplementation(async (ref: FakeRef) => {
      if (ref.kind === 'pedido') throw bug;
      return snap(nfeData);
    });
    await expect(carregadorContextoRejeicao(db)(alvo)).rejects.toBe(bug);
  });

  it('a non-Firebase rejection from the cliente read is rethrown', async () => {
    const bug = new TypeError('boom');
    h.readClienteByRef.mockRejectedValue(bug);
    await expect(carregadorContextoRejeicao(db)(alvo)).rejects.toBe(bug);
  });
});
