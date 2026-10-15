/**
 * Test support for the payment-link orchestrations (#367) — **tests only**.
 *
 * ⚠️ Nothing outside a `*.test.ts` may import this module. It sits beside the
 * suites (rather than inside one) because four of them need the same two things,
 * and a second copy is how two fixtures come to read as agreeing while drifting:
 *
 *  - {@link FakeDbLeitura}, a READ-ONLY fake of the Admin Firestore. The
 *    orchestrations read the pedido, its pagamentos and its links through the
 *    REAL `defineAdminCollection` handles (so `parseRead`, the path resolution and
 *    the schema defaults run for real); every WRITE lives in `linkStore.ts`, which
 *    the suites replace. A write attempted on this fake does not exist, so it
 *    cannot happen silently.
 *  - Fixture builders that produce documents COMPLETE enough to pass their schema,
 *    so a test states only the field it is about.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  STATUS_LINK_PAGAMENTO,
  STATUS_PAGAMENTO,
} from '@delfrance/schemas';

export type Doc = Record<string, unknown>;

/** Read-only fake Admin Firestore: `collection(p).doc(id).get()` and `collection(p).get()`. */
export class FakeDbLeitura {
  private readonly colecoes = new Map<string, Map<string, Doc>>();
  /** Every path read, in order: a collection read is its path, a doc read is `path/id`. */
  readonly leituras: string[] = [];

  private colecao(path: string): Map<string, Doc> {
    let colecao = this.colecoes.get(path);
    if (!colecao) {
      colecao = new Map();
      this.colecoes.set(path, colecao);
    }
    return colecao;
  }

  /** Put a document in place before the run. */
  semear(path: string, id: string, data: Doc): void {
    this.colecao(path).set(id, data);
  }

  /** The Admin SDK's `db.collection(path)`, reduced to the reads the handles issue. */
  collection(path: string) {
    const colecao = this.colecao(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => {
          this.leituras.push(`${path}/${id}`);
          const data = colecao.get(id);
          return {
            exists: colecao.has(id),
            id,
            data: () => data,
            // Firestore's `snapshot.get(field)`: the raw stored value.
            get: (campo: string) => data?.[campo],
          };
        },
      }),
      get: async () => {
        this.leituras.push(path);
        const docs = [...colecao.entries()].map(([id, data]) => ({
          id,
          exists: true,
          data: () => data,
        }));
        return { docs };
      },
    };
  }
}

/** The fake, typed as the Admin `Firestore` the orchestrations take. */
export function comoFirestore(db: FakeDbLeitura): Firestore {
  return db as unknown as Firestore;
}

/* --------------------------------- ids ------------------------------------ */

export const PEDIDO_ID = 'pedidoAAAAAAAAAAAAAAAA';
export const METODO_ID = 'metodoMP';
export const UID = 'uidOperador';

/** A valid link doc id (`^[A-Za-z0-9]{20}$`): `linkId(1)` → `lnk00000000000000001`. */
export function linkId(n: number): string {
  return `lnk${String(n).padStart(17, '0')}`;
}

export const CAMINHO_PEDIDOS = 'pedidos';
export const CAMINHO_LINKS = `pedidos/${PEDIDO_ID}/linkPgtoMercadoPago`;
export const CAMINHO_PAGAMENTOS = `pedidos/${PEDIDO_ID}/pagamentos`;
export const CAMINHO_CLIENTES = 'clientes';

/* -------------------------------- fixtures --------------------------------- */

/** 2026-09-29T15:00:00Z — noon in São Paulo, so `hoje` is 2026-09-29 there. */
export const AGORA_MS = Date.UTC(2026, 8, 29, 15, 0, 0);
export const UM_DIA_MS = 86_400_000;

/** A pedido a link can be generated for: a saída in `iniciado`, R$ 100,00. */
export function docPedido(over: Doc = {}): Doc {
  return {
    estado: ESTADO_PEDIDO.iniciado,
    ehSaida: true,
    numero: '123',
    valorCobrado: 100,
    itensDevolvidos: null,
    clientePedidoOuterRef: null,
    ...over,
  };
}

/** A link doc the create flow wrote: traceable, individual, open, R$ 50,00. */
export function docLink(over: Doc = {}): Doc {
  return {
    contaMercadoPagoOuterRef: `documents/metodo_pgto/${METODO_ID}`,
    valorCobrado: 50,
    link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
    id: 'pref-1',
    dataCriacao: AGORA_MS,
    dataExpiracao: AGORA_MS + 3 * UM_DIA_MS,
    modo: MODO_LINK_PAGAMENTO.individual,
    nomePagador: 'Maria',
    quantidadeMaxima: 1,
    grupoId: linkId(1),
    ordem: 0,
    status: STATUS_LINK_PAGAMENTO.aberto,
    encerradoEm: null,
    encerradoPorOuterRef: null,
    erroEncerramento: null,
    criadoPorOuterRef: `documents/usuarios/${UID}`,
    tiposExcluidos: null,
    parcelasMaximas: null,
    ...over,
  };
}

/** A link doc as the LEGACY Flutter app wrote it: only the six wire fields. */
export function docLinkLegado(over: Doc = {}): Doc {
  return {
    contaMercadoPagoOuterRef: `documents/metodo_pgto/${METODO_ID}`,
    valorCobrado: 50,
    link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=legacy-1',
    id: 'legacy-1',
    dataCriacao: AGORA_MS - UM_DIA_MS,
    dataExpiracao: AGORA_MS + UM_DIA_MS,
    ...over,
  };
}

/** An approved pagamento attributed to a link, received on the Mercado Pago account. */
export function docPagamento(over: Doc = {}): Doc {
  return {
    valor: 50,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    forma_de_pagamento: FORMA_PAGAMENTO.pix,
    linkPagamentoId: linkId(1),
    metodoPagamentoOuterRef: `documents/metodo_pgto/${METODO_ID}`,
    ...over,
  };
}
