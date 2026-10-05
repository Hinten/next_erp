import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { FakeDb, asDb } from '../../lib/shopee/testing/fakeDb';

/**
 * Isolate the trigger's WIRING from the two writes, exactly as the Mercado
 * Livre twin does — and for the same reason: the writes have their own coverage
 * (`packages/data/src/admin/produtos/integracoesComProduto.test.ts` for the
 * core, `lib/shopee/anuncios/integracoesComProdutoShopee.test.ts` for the
 * bindings), while what is only testable HERE is what the trigger decides
 * before touching Firestore at all.
 *
 * ⚠️ The mock sits on the PROMOTED CORE, not on the app wrappers. `planLinkChange`
 * and `contaIdFromRef` stay REAL — they are the trigger's free gates, and a
 * stub would make the zero-read assertions pass no matter what the trigger
 * does — and the wrappers stay real too, so these assertions also prove what
 * the wrappers bind: this app's `FieldValue` sentinels, and the Shopee survivor
 * reader.
 */
const core = vi.hoisted(() => ({
  adicionarConta: vi.fn(async () => true),
  removerContaSeOrfa: vi.fn(async () => true),
}));
vi.mock('@delfrance/data/admin/produtos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/data/admin/produtos')>();
  return { ...real, ...core };
});

const admin = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const { onProdutoShopeeLinkChanged } = await import('./onProdutoShopeeLinkChanged');

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'prod-1';
const LINK = 'link-1';
const CONTA = 'int-1';
const OUTRA = 'int-2';
const ITEM_ID = 2500139861;

/** A published Shopee listing link on {@link CONTA} — the shape that COUNTS. */
const link = (over: Record<string, unknown> = {}) => ({
  contaProdutoShopeeOuterRef: `documents/integracao/${CONTA}`,
  item_id: ITEM_ID,
  item_name: 'Camiseta Básica',
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  ...over,
});

type Snap = { exists: boolean; data: () => Record<string, unknown> };
type EventoExecutavel = {
  data: { before: Snap; after: Snap } | undefined;
  params: { produtoId: string; linkId: string };
  time: string;
};

function snap(data: Record<string, unknown> | null): Snap {
  return { exists: data != null, data: () => data ?? {} };
}

function run(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const event: EventoExecutavel = {
    data: { before: snap(before), after: snap(after) },
    params: { produtoId: PRODUTO, linkId: LINK },
    time: '2026-09-17T12:00:00.000Z',
  };
  return (
    onProdutoShopeeLinkChanged as unknown as { run(e: EventoExecutavel): Promise<unknown> }
  ).run(event);
}

/** Both array sentinels, whatever their values — what the wrappers must bind. */
const SENTINELAS = {
  arrayUnion: expect.any(Function) as unknown,
  arrayRemove: expect.any(Function) as unknown,
};

/**
 * A read-only `tx`, enough to drive a survivor closure — which only reads. A
 * hand-built double rather than the FakeDb's own engine, for the reason the
 * sibling suite under `anuncios/` records: the wave gate greps that folder as
 * raw text for the multi-document atomic-write API.
 */
function txLeitura(): FirebaseFirestore.Transaction {
  return {
    get: (alvo: { get: () => Promise<unknown> }) => alvo.get(),
  } as unknown as FirebaseFirestore.Transaction;
}

let db: FakeDb;
beforeEach(() => {
  vi.clearAllMocks();
  core.adicionarConta.mockResolvedValue(true);
  core.removerContaSeOrfa.mockResolvedValue(true);
  db = new FakeDb();
  admin.getDb.mockImplementation(() => asDb(db));
});

/* -------------------------------------------------------------------------- */

describe('onProdutoShopeeLinkChanged', () => {
  it('uma escrita que não move a filiação NÃO chama getDb', async () => {
    // THE most valuable assertion in this file. Step 9's importer merges this
    // document on EVERY re-import and step 11's publisher writes it up to three
    // times per publish (the item id, then the models, then the read-back
    // status) — none of which can move membership. If the decision were taken
    // after `getDb()`, every one of those would cost a Firestore read and a
    // guarded write.
    await run(link(), link({ ultimaModificacao: 1_757_000_000_000, item_status: 'NORMAL' }));

    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('um rascunho escrito e reescrito (nunca publicado) também não custa nada', async () => {
    const rascunho = link({ item_id: null, estadoAnuncio: null });
    await run(rascunho, { ...rascunho, item_sku: 'SKU-1' });

    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });

  it('um link novo e vivo chama adicionarConta com o produtoId do PATH', async () => {
    // ⚠️ `produtoId` comes from the event PARAMS, never from a field on the
    // link document: the middle wildcard is the only authority on which produto
    // this subcollection belongs to.
    await run(null, link());

    expect(core.adicionarConta).toHaveBeenCalledWith(asDb(db), PRODUTO, CONTA, SENTINELAS);
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('um link que morreu chama removerContaSeOrfa com o leitor de sobreviventes', async () => {
    await run(link(), link({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }));

    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      asDb(db),
      PRODUTO,
      CONTA,
      expect.any(Function),
      SENTINELAS,
    );

    // ⚠️ And the closure really is the SHOPEE reader, bound to the produto from
    // the path and this conta: driving it reads the whole `prodshopee`
    // subcollection under THAT produto, with no `where`. Asserting
    // `expect.any(Function)` alone would accept any closure at all — including
    // one bound to the wrong produto, which would conclude "no survivors" and
    // drop a conta whose listing is live.
    // ⚠️ The double cast is forced: the stub is declared as a zero-parameter
    // `vi.fn`, so its recorded call tuple is typed `[]` and index 3 is a
    // compile error. Naming the shape here keeps the argument POSITION visible,
    // which is the thing that matters — the survivor reader is the 4th
    // argument and the sentinels the 5th.
    const [, , , sobrevivem] = core.removerContaSeOrfa.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      (tx: FirebaseFirestore.Transaction) => Promise<boolean>,
      unknown,
    ];
    db.seed(`produtos/${PRODUTO}/prodshopee/link-2`, link());

    await expect(sobrevivem(txLeitura())).resolves.toBe(true);
    expect(db.consultasCompletas.at(-1)?.fonte).toBe(`produtos/${PRODUTO}/prodshopee`);
    expect(db.consultasCompletas.at(-1)?.clausulas).toEqual([]);
  });

  it('um documento apagado CHECA a conta que ele servia', async () => {
    await run(link(), null);

    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      asDb(db),
      PRODUTO,
      CONTA,
      expect.any(Function),
      SENTINELAS,
    );
    expect(core.adicionarConta).not.toHaveBeenCalled();
  });

  it('re-apontar a conta faz AS DUAS coisas', async () => {
    await run(link(), link({ contaProdutoShopeeOuterRef: `documents/integracao/${OUTRA}` }));

    expect(core.adicionarConta).toHaveBeenCalledWith(asDb(db), PRODUTO, OUTRA, SENTINELAS);
    expect(core.removerContaSeOrfa).toHaveBeenCalledWith(
      asDb(db),
      PRODUTO,
      CONTA,
      expect.any(Function),
      SENTINELAS,
    );
  });

  it('um anúncio removido que volta a viver ADICIONA de novo (auto-cura)', async () => {
    await run(link({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }), link());

    expect(core.adicionarConta).toHaveBeenCalledWith(asDb(db), PRODUTO, CONTA, SENTINELAS);
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('⛔ um documento ilegível não LANÇA — a redelivery do Eventarc não fica presa', async () => {
    // `retry: true` replays the ORIGINAL CloudEvent, so a throw over a document
    // that is permanently malformed would ride the redelivery FOR EVER. Both
    // folds are total over whatever is on disk, including a migrated Flutter
    // row whose conta ref points somewhere else entirely.
    for (const bruto of [
      {},
      { contaProdutoShopeeOuterRef: null, item_id: ITEM_ID },
      { contaProdutoShopeeOuterRef: 42, item_id: ITEM_ID },
      { contaProdutoShopeeOuterRef: 'documents/produtos/p1', item_id: ITEM_ID },
      { contaProdutoShopeeOuterRef: `documents/integracao/${CONTA}`, item_id: 'nao-e-numero' },
      { contaOuterRef: `documents/integracao/${CONTA}`, item_id: ITEM_ID },
    ]) {
      await expect(run(null, bruto)).resolves.toBeUndefined();
    }

    // None of them resolved a Shopee conta, so none of them may have cost a
    // read either — the unresolvable case takes the zero-cost path rather than
    // acting on a guess.
    expect(admin.getDb).not.toHaveBeenCalled();
    expect(core.adicionarConta).not.toHaveBeenCalled();
    expect(core.removerContaSeOrfa).not.toHaveBeenCalled();
  });

  it('um evento sem data nenhuma é um no-op silencioso', async () => {
    const event = {
      data: undefined,
      params: { produtoId: PRODUTO, linkId: LINK },
      time: '2026-09-17T12:00:00.000Z',
    } satisfies EventoExecutavel;

    await expect(
      (onProdutoShopeeLinkChanged as unknown as { run(e: EventoExecutavel): Promise<unknown> }).run(
        event,
      ),
    ).resolves.toBeUndefined();
    expect(admin.getDb).not.toHaveBeenCalled();
  });
});
