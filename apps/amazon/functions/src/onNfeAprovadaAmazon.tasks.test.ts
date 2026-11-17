/**
 * The NF-e trigger, end to end, against the real emulators (`ci-amazon.yml`):
 * a write to `pedidos/{pedidoId}/nfev4/{nfeId}` from THIS process → the
 * Firestore emulator → the Functions emulator → `onNfeAprovadaAmazon` (the
 * real deployed `onDocumentWritten`) → its ONE named enqueue through the
 * functions codebase's NF-e root → the Cloud Tasks emulator →
 * `processAmazonNfeUpload` (the real deployed `onTaskDispatched`) → P1–P6 →
 * the NF-e valve OFF (`AMAZON_MODO_NFE` unset in the lane) → the aviso
 * `nfeUploadRejeitado` with motivo `envio-nao-ligado`, read back RAW.
 *
 * What it proves, with nothing mocked: the trigger binds the path the schema
 * meta names; a proved pedido's approved SALE note is enqueued (the named
 * enqueue, the region-qualified path, the payload schema the queue parses); the
 * dispatched task reaches P6 and stops there — before the context, so before
 * the read switch and before ANY Amazon call (D11 holds twice: the valve here,
 * `AMAZON_CHAMADAS=off` behind it).
 *
 * The two DROP cases run FIRST, each stopped by exactly ONE rung of T3, and
 * each keyed so that the rung's regression would write a row the suite reads:
 *
 * - a pedido CLAIMING this conta (its stored ref names it, its order number is
 *   grammar-valid) whose id is NOT that pair's digest — only the ownership
 *   proof stops it; a broken proof would enqueue, and the dispatched task
 *   (which runs the same proof) would write `envio-nao-ligado` under
 *   (this conta, that pedido);
 * - a PROVED pedido of this conta whose STORED evidence says NOT Delivery by
 *   Amazon (`marketplace.fulfilledBy: 'AMAZON'` — the fourth sharing rule's
 *   own seeding, run here against the REAL trigger): only T3's stored
 *   pre-filter stops it; the task decides DBA live, so a broken pre-filter
 *   would reach P6 and write the same row under that pedido.
 *
 * Their absences are asserted only AFTER the sentinel's row was seen — an
 * emulator cannot show that a function did nothing, so an absence is read only
 * behind a positive.
 *
 * ⚠️ NOT covered here: the database binding (pinned offline in `index.test.ts`),
 * Eventarc redelivery and the named enqueue's `ALREADY_EXISTS` (offline, in
 * `gatilhoNfe.test.ts` and `agendadorNfe.test.ts`), `scheduleDelaySeconds`
 * (firebase-tools#8254), and every arm past P6 (in-process, in
 * `lib/amazon/nfe/processarNfe.test.ts` and `processarNfe.firestore.test.ts`).
 *
 * ⚠️ THE FOURTH EMULATOR SHARING RULE (`vitest.tasks.config.ts`): this is the
 * ONE trigger suite of the NF-e trigger — the only file that seeds a pedido the
 * trigger PASSES. It awaits its dispatched row before it ends, and its ids
 * (`conta-amazon-nfe-gatilho-ci`) are seeded by no other suite.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ESTADO_NFE, ESTADO_PEDIDO } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveAvisoNfeAmazon } from '../../lib/amazon/nfe/avisoNfe';
import { makePedidoIdAmazon } from '../../lib/amazon/pedidos/orderIds';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, seeded by no other emulator suite. */
const CONTA = 'conta-amazon-nfe-gatilho-ci';
const ORDER = '171-9876543-2109876';
const PEDIDO_PROVADO = makePedidoIdAmazon(CONTA, ORDER);
/** A pedido CLAIMING the conta: a 64-hex id that is NOT the digest of the pair it holds. */
const PEDIDO_ALHEIO = '0b'.repeat(32);
const ORDER_ALHEIO = '171-9876543-2109878';
/** A PROVED pedido of the conta, stored as NOT Delivery by Amazon (the fourth sharing rule). */
const ORDER_NAO_DBA = '171-9876543-2109877';
const PEDIDO_NAO_DBA = makePedidoIdAmazon(CONTA, ORDER_NAO_DBA);
const NFE_ID = 's1';

/** A synthetic approved SALE proc (tpAmb 1) — no party, no access key. */
const XML =
  '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
  '</infNFe></NFe></nfeProc>';

function db(): Firestore {
  return getAdminFirestore();
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Per case: CI headroom for the functions emulator's cold start and a dispatch, not a budget. */
const PRAZO_DO_CASO_MS = 120_000;

/** Poll a document until `pronto` holds or the deadline passes; answers the last read. */
async function esperarDocumento(
  caminho: string,
  pronto: (dados: DocumentData | undefined) => boolean,
  prazoMs = 60_000,
): Promise<DocumentData | undefined> {
  const limite = Date.now() + prazoMs;
  let dados: DocumentData | undefined;
  while (Date.now() < limite) {
    dados = (await db().doc(caminho).get()).data();
    if (pronto(dados)) return dados;
    await aguardar(250);
  }
  return dados;
}

const avisoDe = (pedidoId: string) => `avisos/${chaveAvisoNfeAmazon(CONTA, pedidoId)}`;

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  for (const pedidoId of [PEDIDO_PROVADO, PEDIDO_ALHEIO, PEDIDO_NAO_DBA]) {
    await db().recursiveDelete(db().doc(`pedidos/${pedidoId}`));
    await db().doc(avisoDe(pedidoId)).delete();
  }
}

describe.skipIf(!EMULATED || !TASKS)(
  'onNfeAprovadaAmazon → processAmazonNfeUpload (emulator)',
  () => {
    beforeAll(() => {
      db();
    });

    beforeEach(async () => {
      await limpar();
    });

    afterEach(async () => {
      await limpar();
    });

    it(
      '★ an approved sale NF-e of a PROVED pedido ⇒ the named task ⇒ P6 stops at the valve ⇒ the aviso envio-nao-ligado; an UNPROVED pedido and a stored not-DBA one write nothing',
      { timeout: PRAZO_DO_CASO_MS },
      async () => {
        // D11, asserted where it matters: the switch is not on in this process.
        expect(process.env.AMAZON_CHAMADAS).not.toBe('on');

        // 1. The DROP cases FIRST, each stopped by ONE rung of T3 (header).
        //    (a) the ownership proof: the pair it holds does not digest to its id.
        await db()
          .doc(`pedidos/${PEDIDO_ALHEIO}`)
          .set({
            numero: ORDER_ALHEIO,
            integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
            estado: ESTADO_PEDIDO.pago,
          });
        await db()
          .doc(`pedidos/${PEDIDO_ALHEIO}/nfev4/${NFE_ID}`)
          .set({ estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML });
        //    (b) the stored pre-filter: proved, but stored as NOT Delivery by Amazon.
        await db()
          .doc(`pedidos/${PEDIDO_NAO_DBA}`)
          .set({
            numero: ORDER_NAO_DBA,
            integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
            estado: ESTADO_PEDIDO.pago,
            marketplace: { tipo: 'amazon', fulfilledBy: 'AMAZON' },
          });
        await db()
          .doc(`pedidos/${PEDIDO_NAO_DBA}/nfev4/${NFE_ID}`)
          .set({ estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML });

        // 2. The SENTINEL: a proved Amazon pedido (no stored marketplace: a
        //    migrated pedido, which the trigger's stored pre-filter lets through).
        await db()
          .doc(`pedidos/${PEDIDO_PROVADO}`)
          .set({
            numero: ORDER,
            integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
            estado: ESTADO_PEDIDO.pago,
          });
        await db()
          .doc(`pedidos/${PEDIDO_PROVADO}/nfev4/${NFE_ID}`)
          .set({ estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML });

        // 3. The dispatched task's row — the chain's LAST write: awaited.
        const aviso = await esperarDocumento(
          avisoDe(PEDIDO_PROVADO),
          (d) => d?.motivo === 'envio-nao-ligado',
        );
        // The row's identity is its KEY (conta + pedido): the document id itself.
        expect(aviso).toMatchObject({
          tipo: 'nfeUploadRejeitado',
          canal: 'amazon',
          severidade: 'atencao',
          motivo: 'envio-nao-ligado',
          params: { pedido: ORDER },
          resolvidoEm: null,
        });
        // The aviso clock: the task's P3 pedido read time, in µs on the Firestore timeline.
        expect(typeof aviso?.relogioEvento).toBe('number');
        expect(aviso?.relogioEvento).toBeGreaterThan(1e15);

        // 4. Only now, behind that positive read: neither drop wrote its row.
        expect((await db().doc(avisoDe(PEDIDO_ALHEIO)).get()).exists).toBe(false);
        expect((await db().doc(avisoDe(PEDIDO_NAO_DBA)).get()).exists).toBe(false);
        // And P6 stopped the task before the context: the pedido is untouched.
        const pedido = (await db().doc(`pedidos/${PEDIDO_PROVADO}`).get()).data();
        expect(pedido).toEqual({
          numero: ORDER,
          integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
          estado: ESTADO_PEDIDO.pago,
        });
      },
    );
  },
);
