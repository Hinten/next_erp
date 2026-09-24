/**
 * The Firestore-backed {@link CarregarContextoRejeicao} (#852): everything
 * `orientacaoRejeicaoNFe` needs to explain one rejected emission, read with the
 * client SDK. Injected into the pure mapping in `./errors`, which calls it ONLY
 * for a cStat that needs context (805 today) — every other rejection pays
 * nothing.
 *
 * Three reads, at most:
 *
 *  1. the rejected nfev4 doc and the pedido, in parallel (`Promise.allSettled`,
 *     so one failing never discards the other);
 *  2. the cliente the pedido points at, through {@link readClienteByRef} — the
 *     SAME reader, and so the same provenance, as `ClienteCell` (#1303) — and
 *     only when the ref really points into `clientes` ({@link ehRefDeCliente}):
 *     the cadastro link is `/clientes/{id}`, and the same id under another
 *     collection is a different document.
 *
 * The destinatário comes from `lerDestinatarioDoNfev4` — `xml_assinado` (EXACTLY
 * the NF-e the SEFAZ judged, kept on `rejeitada`), else `xml_nfe_proc`, never
 * `xml_epec_proc` — the same reader the NF column's badge uses.
 *
 * ⚠️ Every read goes through a converter that SOFT-parses (`parseSoftRead`): a
 * document that does not match its schema comes back RAW, never as a
 * `ZodError`. So each field is re-checked — `nome`/`ie` only when they are
 * strings, `tipo` only when it is a `TIPO_CLIENTE` code (here, in
 * {@link cadastroClienteRejeicao}), an XML only when it is a non-empty string (in
 * `lerDestinatarioDoNfev4`) — and anything else reads as unknown (`null`).
 *
 * Failure policy (root CLAUDE.md rule 6): a `FirebaseError` — permission-denied
 * on `clientes`, an offline `unavailable` — degrades THAT part to `null`, so
 * the toast still shows what it can (a failed cliente read keeps the id-only
 * cadastro link). That includes the FirestoreErrors `doc()` throws
 * SYNCHRONOUSLY for a malformed path — an odd-segment legacy outer ref, an id
 * with a `/` — which is why every ref is built inside the guarded region, not
 * before it. Anything else is a defect and is rethrown.
 */
import { FirebaseError } from 'firebase/app';
import { getDoc, type DocumentReference, type Firestore } from 'firebase/firestore';
import { TIPO_CLIENTE, type TipoCliente } from '@delfrance/schemas';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { ehRefDeCliente, readClienteByRef } from '@/lib/data/readClienteByRef';

import { lerDestinatarioDoNfev4 } from './destinatarioNFe';
import type {
  CadastroClienteRejeicao,
  CarregarContextoRejeicao,
  ClienteDaRejeicao,
  ContextoRejeicaoNFe,
} from './errors';

const TIPOS_CLIENTE: ReadonlySet<string> = new Set<string>(Object.values(TIPO_CLIENTE));

function ehTipoCliente(valor: unknown): valor is TipoCliente {
  return typeof valor === 'string' && TIPOS_CLIENTE.has(valor);
}

function stringOuNull(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

/** The settled value, `null` for a `FirebaseError`, and a rethrow for anything else. */
function valorOuNull<T>(resultado: PromiseSettledResult<T>): T | null {
  if (resultado.status === 'fulfilled') return resultado.value;
  if (resultado.reason instanceof FirebaseError) return null;
  throw resultado.reason;
}

/** The cliente fields the guidance reads, each `unknown` until re-checked. */
export interface CamposClienteRejeicao {
  readonly nome?: unknown;
  readonly tipo?: unknown;
  readonly ie?: unknown;
}

/**
 * Map a (possibly RAW) cliente document to the three fields the guidance reads.
 * Shared with NFCell's `OrientacaoRejeicaoCliente`, which reads the same
 * document under the same `clienteQueryKey`: a non-string `ie` would otherwise
 * throw out of `normalizarIe` (it calls `.normalize()`) during a cell's render.
 */
export function cadastroClienteRejeicao(doc: CamposClienteRejeicao): CadastroClienteRejeicao {
  return {
    nome: stringOuNull(doc.nome),
    tipo: ehTipoCliente(doc.tipo) ? doc.tipo : null,
    ie: stringOuNull(doc.ie),
  };
}

async function carregarCliente(
  db: Firestore,
  outerRef: unknown,
): Promise<ClienteDaRejeicao | null> {
  let ref: DocumentReference | null = null;
  try {
    // ⚠️ Inside the try: an opaque `{ path }` ref with an odd segment count
    // makes `doc()` throw a FirestoreError SYNCHRONOUSLY, and that must degrade
    // like a failed read — never reject the loader and cost the toast.
    ref = dereferenceOuterRef(db, outerRef);
    // Only a ref INTO `clientes` names the cadastro `/clientes/{id}` opens; the
    // same id elsewhere is a different document, so no link rather than a wrong one.
    if (ref == null || !ehRefDeCliente(ref)) return null;
    const doc = await readClienteByRef<Record<string, unknown>>(db, ref);
    return { id: ref.id, cadastro: doc == null ? null : cadastroClienteRejeicao(doc) };
  } catch (err) {
    // A failed read keeps the id-only cadastro link; a ref that did not even
    // dereference has no id to link to.
    if (err instanceof FirebaseError) return ref == null ? null : { id: ref.id, cadastro: null };
    throw err;
  }
}

/**
 * Build the loader `notificationForNFeErrorComContexto` (and the NF column /
 * lote dialog) inject. One instance per `db`; each call is independent.
 */
export function carregadorContextoRejeicao(db: Firestore): CarregarContextoRejeicao {
  return async ({ pedidoId, nfeId }): Promise<ContextoRejeicaoNFe> => {
    const [nfeSettled, pedidoSettled] = await Promise.allSettled([
      // Each ref is built INSIDE its settled promise: `docRef` validates the
      // path and throws a FirestoreError synchronously for a malformed id, which
      // outside would escape `allSettled` and reject the whole loader.
      Promise.resolve().then(() => getDoc(nfeCollection.docRef(db, { pedidoId }, nfeId))),
      Promise.resolve().then(() => getDoc(pedidoCollection.docRef(db, {}, pedidoId))),
    ]);
    const nfe = valorOuNull(nfeSettled)?.data();
    const pedido = valorOuNull(pedidoSettled)?.data();

    const destinatario = lerDestinatarioDoNfev4(nfe);
    const cliente = pedido ? await carregarCliente(db, pedido.clientePedidoOuterRef) : null;
    return { destinatario, cliente };
  };
}
