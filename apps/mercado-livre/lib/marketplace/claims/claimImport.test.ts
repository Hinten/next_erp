import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlClaim,
  type MlClaimMessage,
} from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  ORIGEM_CONVERSA,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  TIPO_MENSAGEM,
  TIPO_RESOLUCAO,
} from '@delfrance/schemas';

// Package C seams (`vincularClienteMercadoLivre` / `ensureClaimAttachmentArquivo`)
// and the Step 9 order-import fallback are mocked with hoisted handles — this
// file proves the CLAIMS orchestration only; those modules have their own
// dedicated tests.
const h = vi.hoisted(() => ({
  vincularCliente: vi.fn(async () => ({
    clienteOuterRef: 'documents/clientes/cli-1',
    carimbouIdMercadoLivre: false,
  })),
  ensureClaimAttachmentArquivo: vi.fn(
    async (): Promise<
      { ok: true; arquivoOuterRef: string } | { ok: false; skipped: 'http-error' | 'empty-body' }
    > => ({ ok: true, arquivoOuterRef: 'documents/arquivos/arq-1' }),
  ),
  importPedidoMercadoLivre: vi.fn(
    async (_deps: { nowUs: number; nowMs: number; integracaoId: string }, _orderId: number) => ({
      pedidoId: null as string | null,
      created: false,
      skipped: 'no-buyer' as string | null,
    }),
  ),
}));
vi.mock('./claimCliente', () => ({ vincularClienteMercadoLivre: h.vincularCliente }));
vi.mock('./claimAttachments', () => ({
  ensureClaimAttachmentArquivo: h.ensureClaimAttachmentArquivo,
}));
vi.mock('../pedidos/orderImport', () => ({ importPedidoMercadoLivre: h.importPedidoMercadoLivre }));

import type { Bucket } from '../core/arquivoUpload';
import { importClaimMercadoLivre, type ClaimImportDeps } from './claimImport';
import {
  makeAttachmentMensagemId,
  makeClaimMessageId,
  makeConversaIdClaim,
  makeIncidenteIdClaim,
} from './claimIds';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy (in-repo convention: FakeDbs are deliberately NOT shared across
// test files) — the notificacao.test.ts style (doc get/set-with-merge over a
// path-keyed col map), plus `limit` on collectionGroup queries (the shared
// `resolvePedidoIdByOrderId` chains where→limit→get) with docs carrying
// `ref.parent.parent.id` (the owning pedido id).

type DocData = Record<string, unknown>;

interface FakeRef {
  id: string;
  __col: Map<string, DocData>;
}
interface FakeTx {
  get: (ref: FakeRef) => Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  set: (ref: FakeRef, data: DocData, opts?: { merge?: boolean }) => void;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  collection(path: string) {
    const col = this.col(path);
    return {
      // The doc-id RANGE chain `limparMensagensProvisorias` uses. Strict on
      // purpose: an unexpected field throws instead of quietly matching all,
      // which would let a broken cleanup read as a working one.
      where: function whereRange(campo: unknown, op: string, valor: unknown) {
        if (String(campo) !== '__name__') {
          throw new Error(`unexpected where on ${String(campo)}`);
        }
        const faixa: { min: string | null; max: string | null } = { min: null, max: null };
        const q = {
          where: (c2: unknown, o2: string, v2: unknown) => {
            if (String(c2) !== '__name__') throw new Error('unexpected where');
            if (o2 === '>=') faixa.min = String(v2);
            else if (o2 === '<') faixa.max = String(v2);
            return q;
          },
          get: async () => ({
            docs: [...col.entries()]
              .filter(
                ([id]) =>
                  (faixa.min == null || id >= faixa.min) && (faixa.max == null || id < faixa.max),
              )
              .map(([id, data]) => ({
                id,
                data: () => data,
                ref: {
                  delete: async () => {
                    col.delete(id);
                  },
                },
              })),
          }),
        };
        return q.where(campo, op, valor);
      },
      doc: (id: string) => ({
        id,
        __col: col,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
      }),
    };
  }

  /** How many transactions ran — pins that the conversa write uses one. */
  transacoes = 0;

  /**
   * Enough of a transaction for the out-of-order guard: reads see current
   * state, writes apply immediately. It does NOT model OCC contention, so it
   * proves the guard READS INSIDE the transaction and drops an older
   * snapshot — not that two writers serialise, which is Firestore's job.
   */
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    this.transacoes += 1;
    return fn({
      get: async (ref: FakeRef) => ({
        exists: ref.__col.has(ref.id),
        id: ref.id,
        data: () => ref.__col.get(ref.id),
      }),
      set: (ref: FakeRef, data: DocData, opts?: { merge?: boolean }) => {
        ref.__col.set(
          ref.id,
          opts?.merge ? { ...(ref.__col.get(ref.id) ?? {}), ...data } : { ...data },
        );
      },
    });
  }

  collectionGroup(groupId: string) {
    const entries: Array<[string, DocData, string]> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) {
        for (const [id, d] of col) entries.push([id, d, path]);
      }
    }
    const clauses: Array<{ field: string; value: unknown }> = [];
    let lim: number | null = null;
    const q = {
      where: (field: string, _op: string, value: unknown) => {
        clauses.push({ field, value });
        return q;
      },
      limit: (n: number) => {
        lim = n;
        return q;
      },
      get: async () => {
        let rows = entries.filter(([, d]) => clauses.every((c) => d[c.field] === c.value));
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map(([id, d, colPath]) => {
            const segs = colPath.split('/').filter(Boolean);
            return {
              id,
              data: () => d,
              exists: true,
              ref: { parent: { parent: { id: segs[segs.length - 2] ?? '' } } },
            };
          }),
        };
      },
    };
    return q;
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */
// The canonical claim sample (models.dart:3762-3825) — same transcription as
// claimMapping.test.ts, whose builder tests own the field-level assertions.

const CONTA_ID = 'conta_abc123';
const CLAIM_ID = 5142940410;
const ORDER_ID = 2000004048276990;
const BUYER_ID = 301110805;
const SELLER_ID = 397242111;
const PEDIDO_ID = 'ped-1';

const DATE_CREATED_MS = Date.parse('2022-08-23T20:09:16.000-04:00');
const LAST_UPDATED_MS = Date.parse('2022-08-24T16:10:26.000-04:00');
const NOW_MS = Date.parse('2026-08-01T00:00:00.000Z');
const NOW_US = NOW_MS * 1000;

const INCIDENTE_ID = makeIncidenteIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID);
const CONVERSA_ID = makeConversaIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID);
const INCIDENTES_PATH = `pedidos/${PEDIDO_ID}/incidentes`;
const MENSAGENS_PATH = `chat/${CONVERSA_ID}/mensagem`;

const FAKE_BUCKET = { __bucket: true } as unknown as Bucket;

function makeClaim(over: DocData = {}): MlClaim {
  return {
    id: CLAIM_ID,
    // `mediations`, not `returns`: a return claim carries no messages at all
    // (ML: "Neste caso, não há mensagens"), so the old fixture contradicted its
    // own `getClaimMessages` stub the moment the actionability gate existed.
    type: 'mediations',
    stage: 'claim',
    // ⚠️ OPEN, and it has to be: this fixture also carries a send action, and a
    // closed claim listing one is a state ML does not produce.
    status: 'opened',
    parent_id: null,
    client_id: 3728194611110859,
    resource_id: ORDER_ID,
    resource: 'order',
    reason_id: 'PDD9545',
    fulfilled: true,
    players: [
      { role: 'complainant', type: 'buyer', user_id: BUYER_ID, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: SELLER_ID,
        // The seller can still write — what makes this claim own a conversa.
        available_actions: [
          { action: 'send_message_to_complainant', mandatory: true, due_date: null },
        ],
      },
    ],
    resolution: {
      reason: 'item_returned',
      date_created: '2022-08-24T16:10:18.000-04:00',
      decision: null,
      closed_by: 'mediator',
    },
    site_id: 'MLB',
    date_created: '2022-08-23T20:09:16.000-04:00',
    last_updated: '2022-08-24T16:10:26.000-04:00',
    ...over,
  } as unknown as MlClaim;
}

function makeMessage(over: DocData = {}): MlClaimMessage {
  return {
    sender_role: 'complainant',
    receiver_role: 'respondent',
    stage: 'claim',
    date_created: '2022-08-23T20:30:52.000-04:00',
    message: 'Hola',
    attachments: [],
    ...over,
  } as unknown as MlClaimMessage;
}

function makeApi(over: Partial<Record<string, unknown>> = {}): MercadoLivreApi {
  return {
    getClaim: vi.fn(async () => makeClaim()),
    getClaimMessages: vi.fn(async () => [makeMessage()]),
    getClaimReason: vi.fn(async () => ({
      id: 'PDD9545',
      detail: 'O produto chegou danificado',
      name: 'Produto danificado',
      date_created: '2022-08-23T20:09:16.000-04:00',
      last_updated: '2022-08-24T16:10:26.000-04:00',
    })),
    getShipment: vi.fn(async () => ({ id: 777, order_id: ORDER_ID })),
    getUser: vi.fn(async () => ({ id: BUYER_ID, nickname: 'buyer_nick' })),
    ...over,
  } as unknown as MercadoLivreApi;
}

function deps(
  db: FakeDb,
  api: MercadoLivreApi,
  over: Partial<ClaimImportDeps> = {},
): ClaimImportDeps {
  return {
    db: asDb(db),
    api,
    integracaoId: CONTA_ID,
    conta: { userId: SELLER_ID, cor: 7 },
    nowUs: NOW_US,
    nowMs: NOW_MS,
    bucket: FAKE_BUCKET,
    ...over,
  };
}

/** The same claim with the seller holding exactly `acoes`. */
function claimComAcoes(acoes: string[], over: DocData = {}): MlClaim {
  return makeClaim({
    players: [
      { role: 'complainant', type: 'buyer', user_id: BUYER_ID, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: SELLER_ID,
        available_actions: acoes.map((action) => ({ action, mandatory: false, due_date: null })),
      },
    ],
    ...over,
  });
}

function seedPedido(db: FakeDb, over: DocData = {}): void {
  db.seed('pedidos', PEDIDO_ID, {
    clientePedidoOuterRef: 'documents/clientes/cli-1',
    ...over,
  });
}
function seedOrderMl(db: FakeDb, opts: { packId?: number | null } = {}): void {
  db.seed(`pedidos/${PEDIDO_ID}/orderML`, String(ORDER_ID), {
    id: ORDER_ID,
    pack_id: opts.packId ?? null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.vincularCliente.mockResolvedValue({
    clienteOuterRef: 'documents/clientes/cli-1',
    carimbouIdMercadoLivre: false,
  });
  h.ensureClaimAttachmentArquivo.mockResolvedValue({
    ok: true as const,
    arquivoOuterRef: 'documents/arquivos/arq-1',
  });
  h.importPedidoMercadoLivre.mockResolvedValue({
    pedidoId: null,
    created: false,
    skipped: 'no-buyer',
  });
});

/* --------------------------------- tests ---------------------------------- */

describe('importClaimMercadoLivre — happy create path', () => {
  it('writes the incidente (µs) + conversa (ms) + reason/claim/attachment mensagens at the legacy ids', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const withAttachment = makeMessage({
      attachments: [{ filename: 'foto.jpg', original_filename: 'original.jpg' }],
    });
    const plain = makeMessage({
      message: 'Segunda',
      date_created: '2022-08-24T10:00:00.000-04:00',
    });
    const api = makeApi({ getClaimMessages: vi.fn(async () => [withAttachment, plain]) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result).toEqual({
      pedidoId: PEDIDO_ID,
      incidenteId: INCIDENTE_ID,
      conversaId: CONVERSA_ID,
      skipped: null,
      // What the seller can still do — the caller logs it, and the respond
      // half of #768 reads the action list instead of re-deriving it.
      acao: expect.objectContaining({
        podeResponder: true,
        acaoMensagem: 'send_message_to_complainant',
      }),
    });

    // Incidente — MICROSECONDS.
    const incidente = db.docs(INCIDENTES_PATH).get(INCIDENTE_ID)!;
    expect(incidente).toMatchObject({
      origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
      tipo: TIPO_INCIDENTE.mediacaoDoMarketplace,
      motivoDoIncidente: 'O produto chegou danificado',
      comentarios: 'order 2000004048276990(5142940410) - Aberta Reclamação',
      timestamp: DATE_CREATED_MS * 1000,
      ultimaModificacao: LAST_UPDATED_MS * 1000,
      externalId: String(CLAIM_ID),
    });
    expect(incidente.resolucao).toMatchObject({ tipo: TIPO_RESOLUCAO.itemDevolvido });

    // Conversa — MILLISECONDS; estadoConversa fills from the schema default.
    const conversa = db.docs('chat').get(CONVERSA_ID)!;
    expect(conversa).toMatchObject({
      origem: ORIGEM_CONVERSA.mercadoLivreReclamacoes,
      id: String(CLAIM_ID),
      nome: 'Pedido 2000004048276990(5142940410) - Reclamação Aberta',
      sender_id: String(BUYER_ID),
      // The seller still holds a send action, so the thread is NOT handled.
      atendido: false,
      cor_etiqueta: 7,
      estadoConversa: ESTADO_CONVERSA.naoRespondido,
      data_cadastro: DATE_CREATED_MS,
      ultima_modificacao: LAST_UPDATED_MS,
      clienteOuterRef: 'documents/clientes/cli-1',
      respostaBloqueada: null,
      integracaoOuterRef: `documents/integracao/${CONTA_ID}`,
      pedidoOuterRef: `documents/pedidos/${PEDIDO_ID}`,
      incidenteOuterRef: `documents/pedidos/${PEDIDO_ID}/incidentes/${INCIDENTE_ID}`,
    });

    // µs vs ms crossing — the SAME instants, three orders of magnitude apart.
    expect(incidente.timestamp).toBe((conversa.data_cadastro as number) * 1000);
    expect(incidente.ultimaModificacao).toBe((conversa.ultima_modificacao as number) * 1000);

    // Mensagens — reason (RAW id) + 2 claim messages + 1 attachment.
    const mensagens = db.docs(MENSAGENS_PATH);
    expect(mensagens.size).toBe(4);
    expect(mensagens.get('PDD9545')).toMatchObject({
      // The BUYER wrote the reason; legacy filed it as our unsent draft.
      estadoEnvio: ESTADO_ENVIO.recebido,
      conteudo: 'O produto chegou danificado',
      mid: 'PDD9545',
      clienteMensagemOuterRef: 'documents/clientes/cli-1',
    });
    const withAttachmentId = makeClaimMessageId(CONTA_ID, withAttachment);
    expect(mensagens.get(withAttachmentId)).toMatchObject({
      // sender_role complainant ⇒ inbound. Legacy stamped EVERY claim message
      // 'enviado', so the buyer's own words rendered as ours.
      estadoEnvio: ESTADO_ENVIO.recebido,
      tipo: TIPO_MENSAGEM.comum,
      conteudo: 'Hola',
      mid: withAttachmentId,
      midGroup: withAttachmentId, // has attachments → groups on itself
      data_cadastro: Date.parse('2022-08-23T20:30:52.000-04:00'),
      timestamp: Date.parse('2022-08-23T20:30:52.000-04:00'),
    });
    const plainId = makeClaimMessageId(CONTA_ID, plain);
    expect(mensagens.get(plainId)).toMatchObject({ conteudo: 'Segunda', midGroup: null });
    expect(mensagens.get(makeAttachmentMensagemId(CONTA_ID, 'foto.jpg'))).toMatchObject({
      estadoEnvio: ESTADO_ENVIO.recebido, // takes the PARENT message's direction
      tipo: TIPO_MENSAGEM.comum, // legacy quirk kept — NOT arquivo
      mid: 'foto.jpg',
      midGroup: withAttachmentId,
      anexoStorage: 'documents/arquivos/arq-1',
      clienteMensagemOuterRef: 'documents/clientes/cli-1',
    });

    // Package C seams received the pinned shapes.
    expect(h.vincularCliente).toHaveBeenCalledWith(asDb(db), {
      clienteOuterRef: 'documents/clientes/cli-1',
      buyerUserId: BUYER_ID,
    });
    expect(h.ensureClaimAttachmentArquivo).toHaveBeenCalledWith(
      { db: asDb(db), api, bucket: FAKE_BUCKET },
      { contaId: CONTA_ID, claimId: CLAIM_ID, filename: 'foto.jpg' },
    );
    expect(h.importPedidoMercadoLivre).not.toHaveBeenCalled(); // orderML resolved directly
  });
});

describe('importClaimMercadoLivre — redelivery idempotency', () => {
  it('an EXISTING incidente gets ONLY {ultimaModificacao, resolucao} — operator edits survive', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    db.seed(INCIDENTES_PATH, INCIDENTE_ID, {
      origem: ORIGEM_INCIDENTE.outros,
      tipo: TIPO_INCIDENTE.outros,
      motivoDoIncidente: 'editado pelo operador',
      comentarios: 'comentário do operador',
      timestamp: 111, // must NEVER be rewritten on update
      ultimaModificacao: 222,
      externalId: 'kept',
      resolucao: null,
    });

    const result = await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const incidente = db.docs(INCIDENTES_PATH).get(INCIDENTE_ID)!;
    expect(incidente).toMatchObject({
      motivoDoIncidente: 'editado pelo operador',
      comentarios: 'comentário do operador',
      timestamp: 111,
      externalId: 'kept',
      // the two legacy-updated fields — resolucao re-derived with the FIXED table
      ultimaModificacao: LAST_UPDATED_MS * 1000,
      resolucao: expect.objectContaining({ tipo: TIPO_RESOLUCAO.itemDevolvido }),
    });
  });

  it('a still-OPEN claim (resolution null) preserves a stored/operator resolucao — legacy copyWith null-coalesced', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const operatorResolucao = {
      data: 555,
      tipo: TIPO_RESOLUCAO.outro,
      comentarios: 'do operador',
      valor: 10,
      frete: null,
    };
    db.seed(INCIDENTES_PATH, INCIDENTE_ID, {
      timestamp: 111,
      ultimaModificacao: 222,
      resolucao: operatorResolucao,
    });
    const api = makeApi({
      getClaim: vi.fn(async () => makeClaim({ resolution: null, status: 'opened' })),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const incidente = db.docs(INCIDENTES_PATH).get(INCIDENTE_ID)!;
    expect(incidente.resolucao).toEqual(operatorResolucao); // NOT wiped to null
    expect(incidente.ultimaModificacao).toBe(LAST_UPDATED_MS * 1000); // still refreshed
  });

  it('a null last_updated never regresses a stored ultimaModificacao (empty patch → no merge)', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    db.seed(INCIDENTES_PATH, INCIDENTE_ID, {
      timestamp: 111,
      ultimaModificacao: 999_999_999_999_999, // later than the date_created fallback
      resolucao: null,
    });
    const api = makeApi({
      getClaim: vi.fn(async () => makeClaim({ resolution: null, last_updated: null })),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const incidente = db.docs(INCIDENTES_PATH).get(INCIDENTE_ID)!;
    expect(incidente.ultimaModificacao).toBe(999_999_999_999_999);
    expect(incidente.resolucao).toBeNull();
  });

  it('a STALE stored conversa (newer provider watermark) skips the merge AND the reason mensagem; claim messages still overwrite', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    db.seed('chat', CONVERSA_ID, {
      nome: 'nome local',
      estadoConversa: ESTADO_CONVERSA.emResposta,
      // ⚠️ The guard reads `ultimaModificacaoIntegracao`, NOT
      // `ultima_modificacao` — the latter is a mixed clock operators also
      // write, so an edited conversa looked permanently newer than the wire.
      ultimaModificacaoIntegracao: LAST_UPDATED_MS + 60_000, // NEWER than the claim's
      data_cadastro: 12345,
    });
    const message = makeMessage();
    const api = makeApi({ getClaimMessages: vi.fn(async () => [message]) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const conversa = db.docs('chat').get(CONVERSA_ID)!;
    expect(conversa.nome).toBe('nome local'); // merge skipped
    expect(conversa.estadoConversa).toBe(ESTADO_CONVERSA.emResposta);
    expect(conversa.ultimaModificacaoIntegracao).toBe(LAST_UPDATED_MS + 60_000);
    // Reason mensagem gated on the conversa create/update — NOT written.
    expect(db.docs(MENSAGENS_PATH).has('PDD9545')).toBe(false);
    // Claim message still set at its deterministic id (legacy forceAdd parity).
    expect(db.docs(MENSAGENS_PATH).has(makeClaimMessageId(CONTA_ID, message))).toBe(true);
  });

  it('an OLDER stored conversa merges the mapped fields but preserves estadoConversa + data_cadastro; reason mensagem written', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    db.seed('chat', CONVERSA_ID, {
      nome: 'nome antigo',
      estadoConversa: ESTADO_CONVERSA.atendimentoFinalizado, // operator triage state
      ultimaModificacaoIntegracao: 1_000, // OLDER than the claim's
      data_cadastro: 12345, // set once on create — never merged
    });

    const result = await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const conversa = db.docs('chat').get(CONVERSA_ID)!;
    expect(conversa.nome).toBe('Pedido 2000004048276990(5142940410) - Reclamação Aberta');
    expect(conversa.ultimaModificacaoIntegracao).toBe(LAST_UPDATED_MS);
    expect(conversa.estadoConversa).toBe(ESTADO_CONVERSA.atendimentoFinalizado); // preserved
    expect(conversa.data_cadastro).toBe(12345); // preserved
    expect(db.docs(MENSAGENS_PATH).has('PDD9545')).toBe(true);
  });

  it('a stored conversa with a NULL provider watermark always merges', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    db.seed('chat', CONVERSA_ID, {
      nome: 'nome antigo',
      ultimaModificacaoIntegracao: null,
      data_cadastro: 12345,
    });

    await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(db.docs('chat').get(CONVERSA_ID)!.nome).toBe(
      'Pedido 2000004048276990(5142940410) - Reclamação Aberta',
    );
  });
});

describe('importClaimMercadoLivre — deterministic skips', () => {
  it('claim-404: a 404 on getClaim acks without writing anything', async () => {
    const db = new FakeDb();
    const api = makeApi({
      getClaim: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 404: not found', 404, null);
      }),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result).toEqual({
      pedidoId: null,
      incidenteId: null,
      conversaId: null,
      skipped: 'claim-404',
    });
    expect(db.cols.size).toBe(0);
  });

  it("resource-nao-suportado: a 'payment' resource acks before any lookup (legacy :1793-1795)", async () => {
    const db = new FakeDb();
    const api = makeApi({ getClaim: vi.fn(async () => makeClaim({ resource: 'payment' })) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBe('resource-nao-suportado');
    expect(api.getShipment).not.toHaveBeenCalled();
    expect(h.importPedidoMercadoLivre).not.toHaveBeenCalled();
  });

  it('reclamacao-do-vendedor: an unresolvable pedido whose complainant IS the seller acks silently', async () => {
    const db = new FakeDb(); // no orderML → resolve misses; import fallback skips
    const api = makeApi();

    const result = await importClaimMercadoLivre(
      // The fixture's complainant is the buyer — make the conta THAT user.
      deps(db, api, { conta: { userId: BUYER_ID, cor: 7 } }),
      CLAIM_ID,
    );

    expect(result.skipped).toBe('reclamacao-do-vendedor');
    expect(db.docs('chat').size).toBe(0);
  });

  it('pedido-nao-encontrado: an unresolvable pedido with a buyer-side complainant warns + acks', async () => {
    const db = new FakeDb();

    const result = await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(result.skipped).toBe('pedido-nao-encontrado');
    expect(h.importPedidoMercadoLivre).toHaveBeenCalledWith(
      expect.objectContaining({ integracaoId: CONTA_ID, nowUs: NOW_US, nowMs: NOW_MS }),
      ORDER_ID,
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[mercado-livre] claim: pedido não encontrado',
      expect.objectContaining({ claimId: CLAIM_ID }),
    );
  });

  it('sem-cliente: a cliente-less pedido triggers ONE re-import, re-reads, then acks', async () => {
    const db = new FakeDb();
    seedPedido(db, { clientePedidoOuterRef: null });
    seedOrderMl(db);
    h.importPedidoMercadoLivre.mockResolvedValue({
      pedidoId: PEDIDO_ID,
      created: false,
      skipped: null,
    }); // the re-import runs but does NOT fill the cliente

    const result = await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(result.skipped).toBe('sem-cliente');
    expect(h.importPedidoMercadoLivre).toHaveBeenCalledTimes(1); // the :1836-1844 retry only
    expect(h.importPedidoMercadoLivre).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
  });

  it('sem-cliente re-import that DOES fill the cliente proceeds to the full import', async () => {
    const db = new FakeDb();
    seedPedido(db, { clientePedidoOuterRef: null });
    seedOrderMl(db);
    h.importPedidoMercadoLivre.mockImplementation(async () => {
      seedPedido(db); // the re-import filled cliente/endereço
      return { pedidoId: PEDIDO_ID, created: false, skipped: null };
    });

    const result = await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(db.docs(INCIDENTES_PATH).has(INCIDENTE_ID)).toBe(true);
  });

  it('sem-cliente: a claim with NO buyer-side player skips before any write (legacy getClientId threw)', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({
      getClaim: vi.fn(async () =>
        makeClaim({
          players: [{ role: 'respondent', type: 'seller', user_id: SELLER_ID }],
        }),
      ),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBe('sem-cliente');
    expect(db.docs(INCIDENTES_PATH).size).toBe(0);
    expect(db.docs('chat').size).toBe(0);
  });

  it('does NOT misread a null-user_id complainant as the seller when conta.userId is null', async () => {
    const db = new FakeDb(); // unresolvable pedido
    const api = makeApi({
      getClaim: vi.fn(async () =>
        makeClaim({
          players: [
            { role: 'complainant', type: 'buyer', user_id: BUYER_ID },
            { role: 'complainant', type: 'seller', user_id: null },
          ],
        }),
      ),
    });

    const result = await importClaimMercadoLivre(
      deps(db, api, { conta: { userId: null, cor: 7 } }),
      CLAIM_ID,
    );

    // String(null) === String(null) must not silence the operator warn.
    expect(result.skipped).toBe('pedido-nao-encontrado');
  });
});

describe('importClaimMercadoLivre — pedido resolution routes', () => {
  it('order-import fallback: no orderML mirror → full import creates the pedido, claim proceeds onto it', async () => {
    const db = new FakeDb();
    h.importPedidoMercadoLivre.mockImplementation(async () => {
      seedPedido(db);
      seedOrderMl(db);
      return { pedidoId: PEDIDO_ID, created: true, skipped: null };
    });

    const result = await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);

    expect(result).toMatchObject({ pedidoId: PEDIDO_ID, skipped: null });
    expect(h.importPedidoMercadoLivre).toHaveBeenCalledTimes(1);
    expect(h.importPedidoMercadoLivre).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
  });

  it('shipment resource: hops getShipment → order_id → the same orderML resolve; ids keyed by the SHIPMENT resource_id', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db); // orderML keyed by ORDER_ID — the shipment's order_id
    const api = makeApi({
      getClaim: vi.fn(async () => makeClaim({ resource: 'shipment', resource_id: 777 })),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(api.getShipment).toHaveBeenCalledWith(777);
    expect(result).toEqual({
      pedidoId: PEDIDO_ID,
      incidenteId: makeIncidenteIdClaim(CONTA_ID, 777, CLAIM_ID),
      conversaId: makeConversaIdClaim(CONTA_ID, 777, CLAIM_ID),
      skipped: null,
      acao: expect.objectContaining({ podeResponder: true }),
    });
  });

  it('pack resource resolves via the pack_id-FIRST two-step (shared resolver)', async () => {
    const db = new FakeDb();
    seedPedido(db);
    db.seed(`pedidos/${PEDIDO_ID}/orderML`, '111', { id: 111, pack_id: ORDER_ID });
    const api = makeApi({ getClaim: vi.fn(async () => makeClaim({ resource: 'pack' })) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result).toMatchObject({ pedidoId: PEDIDO_ID, skipped: null });
    expect(h.importPedidoMercadoLivre).not.toHaveBeenCalled();
  });

  it('shipment resource whose shipment is GONE (404) degrades to the pedido-not-found skip', async () => {
    const db = new FakeDb();
    const api = makeApi({
      getClaim: vi.fn(async () => makeClaim({ resource: 'shipment', resource_id: 777 })),
      getShipment: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 404: shipment not found', 404, null);
      }),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBe('pedido-nao-encontrado');
    expect(h.importPedidoMercadoLivre).not.toHaveBeenCalled(); // no order key to import by
  });
});

describe('importClaimMercadoLivre — reason best-effort', () => {
  it('an ML HTTP error on getClaimReason degrades to the unknown-motivo fallback (warn, no throw)', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({
      getClaimReason: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 500: boom', 500, null);
      }),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(db.docs(INCIDENTES_PATH).get(INCIDENTE_ID)!.motivoDoIncidente).toBe(
      'Motivo da reclamação desconhecido',
    );
    // The reason mensagem still rides the conversa-create gate, at the RAW
    // claim.reason_id, carrying the fallback conteúdo.
    expect(db.docs(MENSAGENS_PATH).get('PDD9545')).toMatchObject({
      conteudo: 'Motivo da reclamação desconhecido',
    });
  });

  it('a NETWORK error on getClaimReason propagates (transient → retry)', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({
      getClaimReason: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    await expect(importClaimMercadoLivre(deps(db, api), CLAIM_ID)).rejects.toThrow('network down');
  });

  it('reason_id null: skips the fetch, falls back to the unknown motivo, writes NO reason mensagem', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({ getClaim: vi.fn(async () => makeClaim({ reason_id: null })) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(api.getClaimReason).not.toHaveBeenCalled();
    expect(db.docs(INCIDENTES_PATH).get(INCIDENTE_ID)!.motivoDoIncidente).toBe(
      'Motivo da reclamação desconhecido',
    );
    // Only the one claim message — no reason mensagem at ANY id.
    expect(db.docs(MENSAGENS_PATH).size).toBe(1);
  });
});

describe('importClaimMercadoLivre — buyer profile best-effort', () => {
  it('never calls getUser — #768 removed the only consumer of the nickname', async () => {
    // ⚠️ One ML round-trip per claim notification, deleted. Its only product
    // was `usuario.apelido`, and the module that wrote it is gone. A buyer
    // whose ML profile is deleted or banned can no longer fail this import
    // at all, because it never asks.
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi();

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(api.getUser).not.toHaveBeenCalled();
  });
});

describe('importClaimMercadoLivre — attachments', () => {
  const withAttachment = () =>
    makeMessage({ attachments: [{ filename: 'foto.jpg' }, { filename: 'nota.pdf' }] });

  it('a failed ensure (ok:false) skips THAT attachment mensagem; the claim message still lands', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    h.ensureClaimAttachmentArquivo
      .mockResolvedValueOnce({ ok: false as const, skipped: 'http-error' as const })
      .mockResolvedValueOnce({ ok: true as const, arquivoOuterRef: 'documents/arquivos/arq-2' });
    const message = withAttachment();
    const api = makeApi({ getClaimMessages: vi.fn(async () => [message]) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const mensagens = db.docs(MENSAGENS_PATH);
    expect(mensagens.has(makeAttachmentMensagemId(CONTA_ID, 'foto.jpg'))).toBe(false); // skipped
    expect(mensagens.get(makeAttachmentMensagemId(CONTA_ID, 'nota.pdf'))).toMatchObject({
      anexoStorage: 'documents/arquivos/arq-2',
    });
    expect(mensagens.has(makeClaimMessageId(CONTA_ID, message))).toBe(true);
  });

  it('bucket null: ALL attachments skipped with ONE loud warn; ensure never called; messages still land', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const messages = [
      withAttachment(),
      makeMessage({ message: 'Outra', attachments: [{ filename: 'x.png' }] }),
    ];
    const api = makeApi({ getClaimMessages: vi.fn(async () => messages) });

    const result = await importClaimMercadoLivre(deps(db, api, { bucket: null }), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(h.ensureClaimAttachmentArquivo).not.toHaveBeenCalled();
    const bucketWarns = vi
      .mocked(console.warn)
      .mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('bucket de Storage indisponível'),
      );
    expect(bucketWarns).toHaveLength(1); // one loud warn for the whole run
    const mensagens = db.docs(MENSAGENS_PATH);
    expect(mensagens.has(makeAttachmentMensagemId(CONTA_ID, 'foto.jpg'))).toBe(false);
    expect(mensagens.has(makeAttachmentMensagemId(CONTA_ID, 'x.png'))).toBe(false);
    for (const message of messages) {
      expect(mensagens.has(makeClaimMessageId(CONTA_ID, message))).toBe(true);
    }
  });
});

describe('importClaimMercadoLivre — error policy', () => {
  it('a non-404 error on getClaim propagates', async () => {
    const api = makeApi({
      getClaim: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 500: server error', 500, null);
      }),
    });
    await expect(importClaimMercadoLivre(deps(new FakeDb(), api), CLAIM_ID)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('a network/generic error propagates instead of being swallowed', async () => {
    const api = makeApi({
      getClaim: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    await expect(importClaimMercadoLivre(deps(new FakeDb(), api), CLAIM_ID)).rejects.toThrow(
      'network down',
    );
  });

  it('a getClaimMessages failure propagates (after the incidente/conversa upserts)', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({
      getClaimMessages: vi.fn(async () => {
        throw new Error('ml api unavailable');
      }),
    });

    await expect(importClaimMercadoLivre(deps(db, api), CLAIM_ID)).rejects.toThrow(
      'ml api unavailable',
    );
    // The upserts before the failure are idempotent — the retry overwrites them.
    expect(db.docs(INCIDENTES_PATH).has(INCIDENTE_ID)).toBe(true);
    expect(db.docs('chat').has(CONVERSA_ID)).toBe(true);
  });
});

const WIRE_LAST_UPDATED = '2022-08-24T16:10:26.000-04:00';

describe('importClaimMercadoLivre — the conversa actionability gate (#768)', () => {
  const MENSAGENS = `chat/${makeConversaIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID)}/mensagem`;

  it('writes the INCIDENTE but NO conversa when the seller has no send action', async () => {
    // ⚠️ The asymmetry is the design. The incidente is pedido business history
    // and stays useful after the claim closes; a chat thread nobody can reply
    // on is #817 — the operator types, the reply goes nowhere.
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({ getClaim: vi.fn(async () => claimComAcoes([], { status: 'closed' })) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBe('sem-conversa-acionavel');
    expect(result.conversaId).toBeNull();
    expect(result.incidenteId).not.toBeNull();
    expect(db.docs(`pedidos/${PEDIDO_ID}/incidentes`).size).toBe(1);
    expect(db.docs('chat').size).toBe(0);
    expect(db.docs(MENSAGENS).size).toBe(0);
  });

  it('imports the conversa when a send action exists', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({
      getClaim: vi.fn(async () => claimComAcoes(['send_message_to_complainant'])),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(result.conversaId).not.toBeNull();
    expect(db.docs('chat').get(result.conversaId!)).toMatchObject({ respostaBloqueada: null });
  });

  it('a mediation-only action still opens the conversa, aimed at the mediator', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const api = makeApi({
      getClaim: vi.fn(async () =>
        claimComAcoes(['send_message_to_mediator'], { stage: 'dispute' }),
      ),
    });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    expect(result.acao?.acaoMensagem).toBe('send_message_to_mediator');
  });

  it('CLOSES an existing conversa instead of deleting it, keeping the history', async () => {
    // Decision 5: a thread that stops being actionable keeps every message it
    // ever had. Only `respostaBloqueada` + `atendido` change.
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const conversaId = makeConversaIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID);
    db.seed('chat', conversaId, {
      origem: 'mlclaims',
      ultimaModificacaoIntegracao: Date.parse(WIRE_LAST_UPDATED) - 60_000, // older than the wire
      estadoConversa: ESTADO_CONVERSA.emResposta,
      respostaBloqueada: null,
    });
    db.seed(MENSAGENS, 'antiga', { conteudo: 'histórico' });
    const api = makeApi({ getClaim: vi.fn(async () => claimComAcoes([], { status: 'closed' })) });

    const result = await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(result.skipped).toBeNull();
    const stored = db.docs('chat').get(conversaId)!;
    expect(stored.respostaBloqueada).toBe('Reclamação encerrada no Mercado Livre');
    expect(stored.atendido).toBe(true);
    // ⚠️ estadoConversa is operator triage state — a webhook must never move it.
    expect(stored.estadoConversa).toBe(ESTADO_CONVERSA.emResposta);
    expect(db.docs(MENSAGENS).get('antiga')).toBeDefined();
  });

  it('closes on an EQUAL watermark — ML does not always move last_updated', async () => {
    // ⚠️ Why the gate is `>=` and not `>`. When the seller's actions drain away
    // without ML bumping `last_updated`, a strict comparison would refuse the
    // close forever and leave an open composer on a dead claim. This is the case
    // the old out-of-band escape hatch existed for; the `>=` gate covers it
    // without a second, unguarded write path.
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const conversaId = makeConversaIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID);
    db.seed('chat', conversaId, {
      origem: 'mlclaims',
      ultimaModificacaoIntegracao: Date.parse(WIRE_LAST_UPDATED), // EXACTLY equal
      respostaBloqueada: null,
    });
    const api = makeApi({ getClaim: vi.fn(async () => claimComAcoes([], { status: 'closed' })) });

    await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    expect(db.docs('chat').get(conversaId)!.respostaBloqueada).toBe(
      'Reclamação encerrada no Mercado Livre',
    );
  });

  it('REOPENS a closed thread when the seller gets a send action back', async () => {
    // ⚠️ The direction the old escape hatch could not do at all: it only ever
    // closed, so a claim that regained a send action stayed blocked forever.
    // Both directions now ride the same guarded patch.
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const conversaId = makeConversaIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID);
    db.seed('chat', conversaId, {
      origem: 'mlclaims',
      ultimaModificacaoIntegracao: Date.parse(WIRE_LAST_UPDATED) - 60_000,
      respostaBloqueada: 'Reclamação encerrada no Mercado Livre',
      atendido: true,
    });
    const api = makeApi({
      getClaim: vi.fn(async () => claimComAcoes(['send_message_to_complainant'])),
    });

    await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    const stored = db.docs('chat').get(conversaId)!;
    expect(stored.respostaBloqueada).toBeNull();
    expect(stored.atendido).toBe(false);
  });

  it('refuses BOTH directions from a strictly older snapshot', async () => {
    // ⚠️ The race the guard exists for: a worker holding an older no-action
    // response must not close a thread another worker just reopened — and the
    // mirror image must not reopen one another worker just closed.
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    const conversaId = makeConversaIdClaim(CONTA_ID, ORDER_ID, CLAIM_ID);
    db.seed('chat', conversaId, {
      origem: 'mlclaims',
      // A NEWER snapshot already decided this thread is answerable.
      ultimaModificacaoIntegracao: Date.parse(WIRE_LAST_UPDATED) + 60_000,
      respostaBloqueada: null,
      atendido: false,
    });
    const api = makeApi({ getClaim: vi.fn(async () => claimComAcoes([], { status: 'closed' })) });

    await importClaimMercadoLivre(deps(db, api), CLAIM_ID);

    const stored = db.docs('chat').get(conversaId)!;
    expect(stored.respostaBloqueada).toBeNull();
    expect(stored.atendido).toBe(false);
  });

  it('runs the conversa write inside a TRANSACTION', async () => {
    const db = new FakeDb();
    seedPedido(db);
    seedOrderMl(db);
    await importClaimMercadoLivre(deps(db, makeApi()), CLAIM_ID);
    expect(db.transacoes).toBeGreaterThan(0);
  });
});
