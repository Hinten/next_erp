import { describe, expect, it } from 'vitest';

import { FieldValue } from 'firebase-admin/firestore';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  adicionarContaShopee,
  contaDoLinkShopee,
  planejarMudancaDeLinkShopee,
  removerContaShopeeSeOrfa,
  sobrevivemAnunciosDoProduto,
} from './integracoesComProdutoShopee';

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'prod-1';
const CONTA = 'int-1';
const OUTRA = 'int-2';
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_OUTRA = `documents/integracao/${OUTRA}`;
const ITEM_ID = 2500139861;
const CAMPO = 'integracoesComProduto';

/** A published Shopee listing link on {@link CONTA} — the shape that COUNTS. */
function link(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...extra,
  };
}

function semearLink(db: FakeDb, id: string, extra: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PRODUTO}/prodshopee/${id}`, link(extra));
}

/**
 * A read-only `tx`, enough for a survivor closure — which only reads.
 *
 * ⚠️ Deliberately a hand-built double rather than the double's own engine: the
 * wave gate greps this whole folder as RAW TEXT for the multi-document
 * atomic-write API, so naming it here — even to drive a test — would red the
 * guard the folder discipline exists to enforce. The REAL engine is still
 * exercised end to end, through {@link removerContaShopeeSeOrfa}, whose
 * guarded write lives in the promoted core.
 */
function txLeitura(): FirebaseFirestore.Transaction {
  return {
    get: (alvo: { get: () => Promise<unknown> }) => alvo.get(),
  } as unknown as FirebaseFirestore.Transaction;
}

/** The last query the double recorded, whole. */
function ultimaConsulta(db: FakeDb): FakeDb['consultasCompletas'][number] {
  const linha = db.consultasCompletas.at(-1);
  if (linha === undefined) throw new Error('fixture: nenhuma consulta registrada');
  return linha;
}

/** Which array sentinel a recorded patch carries, named rather than compared. */
function sentinelaDe(valor: unknown): 'arrayUnion' | 'arrayRemove' | 'outro' {
  if (FieldValue.arrayUnion(CONTA).isEqual(valor as FieldValue)) return 'arrayUnion';
  if (FieldValue.arrayRemove(CONTA).isEqual(valor as FieldValue)) return 'arrayRemove';
  return 'outro';
}

/* -------------------------------------------------------------------------- */
/*                    (1) contaDoLinkShopee — the field NAME                   */
/* -------------------------------------------------------------------------- */

describe('contaDoLinkShopee', () => {
  it('lê contaProdutoShopeeOuterRef — não contaOuterRef', () => {
    expect(contaDoLinkShopee(link())).toBe(CONTA);
  });

  it('⛔ QUASE-IGUAL: um doc carregando contaOuterRef (a forma do Mercado Livre) resolve NULL', () => {
    // THE regression this module exists to prevent, and it is one identifier
    // apart from correct. A copy-paste of the ML binding compiles; it resolves
    // `null` for every Shopee link, both sides of the plan's comparison become
    // `null`, the zero-cost fast path is taken, and the trigger becomes a no-op
    // that logs NOTHING. So the near-miss is asserted at BOTH altitudes — the
    // fold, and the plan built on it — because only the second one dies if the
    // binding stops passing its own reader and falls back to a default.
    const comoNoMercadoLivre = { contaOuterRef: REF_CONTA, item_id: ITEM_ID };

    expect(contaDoLinkShopee(comoNoMercadoLivre)).toBeNull();
    expect(planejarMudancaDeLinkShopee(null, comoNoMercadoLivre)).toEqual({ add: [], check: [] });
  });

  it("aceita as duas formas de ref armazenadas ('documents/integracao/x' e 'integracao/x')", () => {
    // The canonical form every app writes, and the bare one readers accept
    // defensively — the migrated corpus carries both.
    expect(contaDoLinkShopee(link({ contaProdutoShopeeOuterRef: REF_CONTA }))).toBe(CONTA);
    expect(contaDoLinkShopee(link({ contaProdutoShopeeOuterRef: `integracao/${CONTA}` }))).toBe(
      CONTA,
    );
  });

  it('⛔ um documento ilegível não LANÇA — nem o fold da conta, nem o da vitalidade', () => {
    // Both folds are handed `event.data.after.data()`, i.e. whatever is on
    // disk. A throw inside the trigger's zero-read fast path would ride the
    // Eventarc `retry: true` redelivery for ever.
    for (const bruto of [
      {},
      { contaProdutoShopeeOuterRef: null },
      { contaProdutoShopeeOuterRef: 42 },
      { contaProdutoShopeeOuterRef: 'documents/produtos/p1' },
      { contaProdutoShopeeOuterRef: REF_CONTA, item_id: 'nao-e-numero' },
    ]) {
      expect(() => contaDoLinkShopee(bruto)).not.toThrow();
      expect(() => planejarMudancaDeLinkShopee(bruto, bruto)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*              (2) planejarMudancaDeLinkShopee — the payload plan             */
/* -------------------------------------------------------------------------- */

describe('planejarMudancaDeLinkShopee', () => {
  it('um link novo e vivo ADICIONA a conta', () => {
    expect(planejarMudancaDeLinkShopee(null, link())).toEqual({ add: [CONTA], check: [] });
  });

  it('um link que deixou de contar marca a conta para CHECK', () => {
    const removido = link({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    expect(planejarMudancaDeLinkShopee(link(), removido)).toEqual({ add: [], check: [CONTA] });
  });

  it('um documento APAGADO checa a conta que ele servia', () => {
    expect(planejarMudancaDeLinkShopee(link(), null)).toEqual({ add: [], check: [CONTA] });
  });

  it('uma remerge que não move nada devolve {add:[],check:[]} (o caminho de custo zero)', () => {
    // The load-bearing case, not an edge one: step 9's importer merges this
    // document on EVERY re-import and step 11's publisher writes it up to three
    // times per publish. None of those can move membership, and none of them
    // may cost a Firestore read.
    const antes = link();
    const depois = link({ ultimaModificacao: 1_757_000_000_000, item_status: 'NORMAL' });
    expect(planejarMudancaDeLinkShopee(antes, depois)).toEqual({ add: [], check: [] });
  });

  it('um link que nunca foi publicado (item_id null) não custa nada, escrito e reescrito', () => {
    const rascunho = link({ item_id: null, estadoAnuncio: null });
    expect(planejarMudancaDeLinkShopee(null, rascunho)).toEqual({ add: [], check: [] });
    expect(planejarMudancaDeLinkShopee(rascunho, { ...rascunho, item_sku: 'SKU-1' })).toEqual({
      add: [],
      check: [],
    });
  });

  it('re-apontar o ref da conta ADICIONA a nova e CHECA a antiga', () => {
    expect(
      planejarMudancaDeLinkShopee(link(), link({ contaProdutoShopeeOuterRef: REF_OUTRA })),
    ).toEqual({ add: [OUTRA], check: [CONTA] });
  });

  it('um link importado sem estadoAnuncio conta como VIVO — a direção da super-inclusão', () => {
    // `null`/absent means NEVER FOLDED, which is not evidence of anything: a
    // false positive costs one skipped sweep row, a false negative is a silent
    // stock + price outage.
    const importado = link({ estadoAnuncio: null });
    expect(planejarMudancaDeLinkShopee(null, importado)).toEqual({ add: [CONTA], check: [] });
  });
});

/* -------------------------------------------------------------------------- */
/*            (3) sobrevivemAnunciosDoProduto — the UNFILTERED scan            */
/* -------------------------------------------------------------------------- */

describe('sobrevivemAnunciosDoProduto', () => {
  it('um irmão vivo da MESMA conta impede a remoção', async () => {
    const db = new FakeDb();
    semearLink(db, 'link-1', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    semearLink(db, 'link-2');

    await expect(sobrevivemAnunciosDoProduto(asDb(db), PRODUTO, CONTA)(txLeitura())).resolves.toBe(
      true,
    );
  });

  it('⛔ um irmão vivo de OUTRA conta NÃO impede a remoção', async () => {
    // The conta filter runs in MEMORY (see the next test for why), so this is
    // the assertion that it runs at all. Without it an unfiltered scan would
    // answer "still live" for a produto whose only surviving listing belongs to
    // somebody else, and the array entry would never be dropped.
    const db = new FakeDb();
    semearLink(db, 'link-1', { contaProdutoShopeeOuterRef: REF_OUTRA });

    await expect(sobrevivemAnunciosDoProduto(asDb(db), PRODUTO, CONTA)(txLeitura())).resolves.toBe(
      false,
    );
  });

  it('um link REMOVIDO da própria conta não é sobrevivente', async () => {
    const db = new FakeDb();
    semearLink(db, 'link-1', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });

    await expect(sobrevivemAnunciosDoProduto(asDb(db), PRODUTO, CONTA)(txLeitura())).resolves.toBe(
      false,
    );
  });

  it('uma subcoleção vazia responde false sem inventar sobrevivente nenhum', async () => {
    const db = new FakeDb();

    await expect(sobrevivemAnunciosDoProduto(asDb(db), PRODUTO, CONTA)(txLeitura())).resolves.toBe(
      false,
    );
  });

  it('lê a subcoleção INTEIRA, sem where', async () => {
    // ⚠️ THE INDEX DECISION, pinned. `firestore.indexes.json` declares a
    // `prodshopee` COLLECTION_GROUP composite `(item_id,
    // contaProdutoShopeeOuterRef)` and NO COLLECTION index on the conta ref, so
    // a `where` here would be an UNDECLARED predicate — which on Firestore
    // Enterprise does not throw: it silently full-scans, billed by data
    // SCANNED. Step 11 declares no new index, so the scan must stay unfiltered
    // and the conta filter must stay in memory.
    const db = new FakeDb();
    semearLink(db, 'link-1');
    semearLink(db, 'link-2', { contaProdutoShopeeOuterRef: REF_OUTRA });

    await sobrevivemAnunciosDoProduto(asDb(db), PRODUTO, CONTA)(txLeitura());

    const consulta = ultimaConsulta(db);
    expect(consulta.fonte).toBe(`produtos/${PRODUTO}/prodshopee`);
    expect(consulta.clausulas).toEqual([]);
    expect(consulta.ordens).toEqual([]);
    expect(consulta.limite).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                  (4) the two app wrappers — the bound seams                 */
/* -------------------------------------------------------------------------- */

describe('adicionarContaShopee / removerContaShopeeSeOrfa', () => {
  it('adicionarContaShopee acrescenta a conta com arrayUnion, e só essa chave', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta Básica' });

    await expect(adicionarContaShopee(asDb(db), PRODUTO, CONTA)).resolves.toBe(true);

    const patch = db.patches.at(-1);
    expect(patch?.path).toBe(`produtos/${PRODUTO}`);
    expect(Object.keys(patch?.patch ?? {})).toEqual([CAMPO]);
    expect(sentinelaDe(patch?.patch[CAMPO])).toBe('arrayUnion');
    // The double applies a REAL `FieldValue.arrayUnion`, so the stored value is
    // the observable one too.
    expect(db.store[`produtos/${PRODUTO}`]?.data[CAMPO]).toEqual([CONTA]);
  });

  it('adicionarContaShopee responde false quando o produto já foi apagado', async () => {
    // The cascade beat us; re-creating the produto as a husk carrying one field
    // would be far worse than a missing entry.
    const db = new FakeDb();

    await expect(adicionarContaShopee(asDb(db), PRODUTO, CONTA)).resolves.toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('removerContaShopeeSeOrfa liga o leitor de sobreviventes — um anúncio vivo ABORTA a remoção', async () => {
    // The wrapper binds the survivor reader itself, so this is also the proof
    // that the reader it binds is the Shopee one: the surviving link is found
    // through the unfiltered `prodshopee` scan, on this conta.
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta Básica', [CAMPO]: [CONTA] });
    semearLink(db, 'link-1');

    await expect(removerContaShopeeSeOrfa(asDb(db), PRODUTO, CONTA)).resolves.toBe(false);
    expect(db.patches).toEqual([]);
    expect(db.store[`produtos/${PRODUTO}`]?.data[CAMPO]).toEqual([CONTA]);
  });

  it('removerContaShopeeSeOrfa remove com arrayRemove quando nada sobrevive', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta Básica', [CAMPO]: [CONTA] });
    semearLink(db, 'link-1', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });

    await expect(removerContaShopeeSeOrfa(asDb(db), PRODUTO, CONTA)).resolves.toBe(true);

    const patch = db.patches.at(-1);
    expect(patch?.path).toBe(`produtos/${PRODUTO}`);
    expect(Object.keys(patch?.patch ?? {})).toEqual([CAMPO]);
    // ⚠️ The sentinel is named, not compared against a stored array: this
    // double applies `arrayUnion` for real but leaves `arrayRemove` as a plain
    // overwrite, so asserting the resulting array would pin the double's gap
    // instead of the write's intent.
    expect(sentinelaDe(patch?.patch[CAMPO])).toBe('arrayRemove');
  });

  it('⛔ a remoção lê ANTES de escrever, e a leitura é a subcoleção inteira', async () => {
    // The verdict has to come from the guarded read, never from anything
    // captured before the write opened — an OCC retry re-runs the callback but
    // re-applies an outer closure verbatim, and losing here is the
    // silent-outage direction.
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta Básica', [CAMPO]: [CONTA] });

    await removerContaShopeeSeOrfa(asDb(db), PRODUTO, CONTA);

    expect(db.opLog.map((o) => o.op)).toEqual(['get', 'update']);
    expect(db.opLog[0]?.path).toBe(`produtos/${PRODUTO}/prodshopee`);
    expect(ultimaConsulta(db).clausulas).toEqual([]);
  });

  it('removerContaShopeeSeOrfa responde false quando o produto já foi apagado', async () => {
    const db = new FakeDb();
    semearLink(db, 'link-1', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });

    await expect(removerContaShopeeSeOrfa(asDb(db), PRODUTO, CONTA)).resolves.toBe(false);
  });
});
