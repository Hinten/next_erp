/**
 * The conta trigger, end to end, against the real emulators (`ci-loja-integrada.yml`) — and the
 * FIRST run of the shared `int_frete` core (`@delfrance/data/admin/frete`) against a real
 * Firestore: its transactional lookup query, its `tx.create` at the deterministic id, its
 * `readTime` stamp and its field-level patch.
 *
 * What runs for real here, with nothing mocked:
 *
 *   a write to integracao/{id} from THIS process
 *     → the Firestore emulator → the Functions emulator
 *     → onIntegracaoLojaIntegradaChanged             the real deployed onDocumentWritten
 *     → syncIntFreteLi.deveReconciliar → reconciliarIntFreteDaConta (the core)
 *     → a real int_frete doc, read back RAW
 *
 * Four positives, one per behaviour the conta screen relies on:
 *   - a complete conta CREATES `int_frete/lojaIntegrada-<id>` with the mirrored fields and the
 *     canonical back-ref;
 *   - a rename PATCHES it, and the operator's configuration (`mapa`, `horarioDeCorte`) survives;
 *   - a delete DEACTIVATES it, and never deletes it;
 *   - a pre-seeded auto-id doc carrying the canonical back-ref (a migrated doc) is ADOPTED, and no
 *     `lojaIntegrada-<id>` is created beside it.
 *
 * ⚠️ NOT covered here, and deliberately so:
 *   - every ABSENCE — a write of another channel, or one that moves nothing mirrored, costing
 *     zero reads. An emulator cannot prove that a function did nothing; those are pinned offline
 *     (`onIntegracaoLojaIntegradaChanged.test.ts`).
 *   - the DATABASE binding. The emulator serves whatever database it is asked for, so a wrong
 *     one is not proven to fail here; `index.test.ts` pins `eventFilters.database` to exactly
 *     `'default'`. The positive existence reads below are what stop a mis-targeted suite from
 *     passing on "not found".
 *   - Eventarc's ordering and redelivery. The reconcile is state-driven, which is the argument
 *     (the core's suite covers the out-of-order and replay cases); the emulator delivers each
 *     write once.
 *
 * ⚠️ This suite SHARES its emulators with every other `*.tasks.test.ts` / `*.firestore.test.ts`
 * file, and its trigger fires on THEIR `integracao` writes too. Three rules keep the files apart:
 *   - its conta ids (`conta-li-gatilho-ci-*`) are seeded by no other suite, so no other file's
 *     whole-collection wipe or seed can meet its freight docs;
 *   - the other suites seed Loja Integrada contas with no filial and no `dataCadastro`, which the
 *     core plans as `incompleto`: the trigger only READS there, and a deleted conta with no
 *     freight doc is `nao-encontrado`;
 *   - every case polls for its EXPECTED POSITIVE state — the doc's fields, or `ativo: false` —
 *     and the teardown deletes its contas and waits for the deactivation that delete causes
 *     before removing the freight docs, so no reconcile of this file is still writing when the
 *     next file starts.
 */
import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRACAO_FRETE, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The functions emulator is mandatory in this lane's run; the tasks host proves the `--only` set. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const CONTAS = 'integracao';
const INT_FRETE = 'int_frete';

/** Obviously fake conta ids, seeded by no other emulator suite. */
const CONTA = {
  criar: 'conta-li-gatilho-ci-criar',
  renomear: 'conta-li-gatilho-ci-renomear',
  apagar: 'conta-li-gatilho-ci-apagar',
  adotar: 'conta-li-gatilho-ci-adotar',
} as const;

/** A migrated doc's id: random in the legacy (no doc id on save), fixed here for the cleanup. */
const ID_ADOTADO = 'AutoIdGatilhoCiAdotar';

const FILIAL = 'documents/filiais/f-gatilho-ci';
const DATA_CADASTRO = 1_760_000_000_000;

/** A row the mapa helper appends, written out by hand. */
const LINHA_MAPA = {
  nomeOriginal: 'Gateway A - Transportadora',
  idOriginal: '141909---PAC',
  observacao: 'Origem: Pedido 1001',
  nomeTarget: null,
  targetData: null,
  integracaoUid: null,
  targetTipoIntegracao: 'outros',
};

const HORARIO = {
  diaDaSemana: 1,
  horaDeCorte: 14,
  minutosDeCorte: 0,
  prazoDePostagem: 1,
  horaPostagem: 17,
  minutosPostagem: 0,
};

function db(): Firestore {
  return getAdminFirestore();
}

function contaRef(conta: string): DocumentReference {
  return db().collection(CONTAS).doc(conta);
}

function idDeterministico(conta: string): string {
  return `${INTEGRACAO_FRETE.lojaIntegrada}-${conta}`;
}

function freteRef(id: string): DocumentReference {
  return db().collection(INT_FRETE).doc(id);
}

function backRef(conta: string): string {
  return `documents/${CONTAS}/${conta}`;
}

/** A Loja Integrada conta with every field the freight doc mirrors. */
function contaCompleta(nome: string): DocumentData {
  return {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome,
    ativo: true,
    filialIntegracaoPedidoOuterRef: FILIAL,
    dataCadastro: DATA_CADASTRO,
  };
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll the freight doc until `pronto` holds, and return its RAW data.
 *
 * The write travels this process → Firestore emulator → functions emulator → trigger, so there is
 * no promise to await, only the effect. Waiting on the effect is also what keeps a reconcile of
 * this file from landing inside the next one, and what keeps `emulators:exec` from tearing the
 * emulators down mid-write.
 */
async function aguardarFrete(
  id: string,
  pronto: (data: DocumentData | null) => boolean,
  esperado: string,
  timeoutMs = 40_000,
): Promise<DocumentData> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const snap = await freteRef(id).get();
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (data != null && pronto(data)) return data;
    if (Date.now() > prazo) {
      throw new Error(
        `int_frete/${id} não chegou a "${esperado}" em ${String(timeoutMs)}ms; ` +
          `estado atual: ${data == null ? '<ausente>' : JSON.stringify(data)}. ` +
          'Um doc AUSENTE que nunca chega significa que o gatilho não disparou: confira que ' +
          'prepare-deploy.mjs rodou antes do emulators:exec (o artefato carrega ' +
          'onIntegracaoLojaIntegradaChanged), que o emulador de functions está no --only, e a ' +
          'saída do emulador de functions — uma falha do núcleo int_frete aparece ali.',
      );
    }
    await aguardar(250);
  }
}

/** Every freight doc this conta can own: the ones its back-ref names, plus the deterministic id. */
async function fretesDaConta(conta: string): Promise<DocumentReference[]> {
  const porBackRef = await db()
    .collection(INT_FRETE)
    .where('contaLojaIntegradaEnviosOuterRef', '==', backRef(conta))
    .get();
  const refs = new Map(porBackRef.docs.map((d) => [d.id, d.ref]));
  refs.set(idDeterministico(conta), freteRef(idDeterministico(conta)));
  return [...refs.values()];
}

/**
 * Delete the conta, wait for the DEACTIVATION its delete causes on every live freight doc (the
 * trigger's last write for this conta), then remove the freight docs. In that order, so no
 * reconcile of this file is still writing when the next file starts: with the freight doc removed
 * first, the delete's reconcile would still run after this file ended, with nothing left to wait
 * on.
 */
async function encerrar(conta: string): Promise<void> {
  const existia = (await contaRef(conta).get()).exists;
  if (existia) await contaRef(conta).delete();
  for (const ref of await fretesDaConta(conta)) {
    const snap = await ref.get();
    if (existia && snap.exists && snap.data()?.ativo === true) {
      await aguardarFrete(ref.id, (d) => d?.ativo === false, 'desativado (encerramento)');
    }
    await ref.delete();
  }
}

describe.skipIf(!EMULATED || !TASKS)(
  'onIntegracaoLojaIntegradaChanged → o int_frete da conta segue a conta (emuladores)',
  () => {
    beforeAll(() => {
      db();
    });

    /**
     * Wipes exactly what it reads: the contas FIRST (awaiting their deactivation), the freight
     * docs after — `encerrar` already removes the adopted doc through its back-ref, and the
     * explicit delete covers only a doc whose back-ref a failed case left altered.
     */
    async function limpar(): Promise<void> {
      for (const conta of Object.values(CONTA)) await encerrar(conta);
      await freteRef(ID_ADOTADO).delete();
    }

    // In a fresh emulator nothing here exists yet, so these deletes fire no trigger; they only
    // matter after an earlier case failed mid-way.
    beforeEach(limpar);
    // The teardown that keeps this file's reconciles inside this file.
    afterEach(limpar);

    it('uma conta completa CRIA int_frete/lojaIntegrada-<id> com os campos espelhados e a back-ref canônica', async () => {
      const conta = CONTA.criar;
      await contaRef(conta).set(contaCompleta('Loja de teste A'));

      const doc = await aguardarFrete(idDeterministico(conta), (d) => d != null, 'criado');

      expect(doc).toMatchObject({
        tipo: INTEGRACAO_FRETE.lojaIntegrada,
        nome: 'Loja de teste A',
        ativo: true,
        contaLojaIntegradaEnviosOuterRef: backRef(conta),
        // Rebased from the conta's `filialIntegracaoPedidoOuterRef`.
        filialIntegracaoFreteOuterRef: FILIAL,
        // The conta's own registration date, in ms — not the save time.
        dataCadastro: DATA_CADASTRO,
        // A create writes the operator configuration at its schema default.
        mapa: null,
        horarioDeCorte: null,
        // The other channels' back-refs stay null on this tipo.
        contaMercadoLivreMercadoEnviosOuterRef: null,
        contaShopeeFreteOuterRef: null,
      });
      // The conta read's `readTime` in ms (display only; no sync decision reads it).
      expect(typeof doc.ultimaModificacao).toBe('number');
      expect(doc.ultimaModificacao).toBeGreaterThan(DATA_CADASTRO);
    }, 120_000);

    it('um rename PATCHA o doc, e a configuração do operador (mapa, horarioDeCorte) sobrevive', async () => {
      const conta = CONTA.renomear;
      const id = idDeterministico(conta);
      await contaRef(conta).set(contaCompleta('Nome 1'));
      const criado = await aguardarFrete(id, (d) => d?.nome === 'Nome 1', 'criado');

      // What the mapa helper and the conta screen write: the core never writes either field on a
      // patch, so both must come back byte-equal.
      await freteRef(id).update({ mapa: [LINHA_MAPA], horarioDeCorte: [HORARIO] });
      await contaRef(conta).update({ nome: 'Nome 2' });

      const doc = await aguardarFrete(id, (d) => d?.nome === 'Nome 2', 'renomeado');

      expect(doc.mapa).toEqual([LINHA_MAPA]);
      expect(doc.horarioDeCorte).toEqual([HORARIO]);
      expect(doc).toMatchObject({
        ativo: true,
        contaLojaIntegradaEnviosOuterRef: backRef(conta),
        filialIntegracaoFreteOuterRef: FILIAL,
        dataCadastro: DATA_CADASTRO,
      });
      // The stamp moved with the patch: a later conta read, a later `readTime`.
      expect(doc.ultimaModificacao).toBeGreaterThan(criado.ultimaModificacao as number);
    }, 120_000);

    it('um delete DESATIVA o doc — nunca o apaga', async () => {
      const conta = CONTA.apagar;
      const id = idDeterministico(conta);
      await contaRef(conta).set(contaCompleta('Loja de teste C'));
      await aguardarFrete(id, (d) => d?.ativo === true, 'criado');

      await contaRef(conta).delete();

      // Polling for `ativo: false` reads the doc, so it also proves the doc still EXISTS:
      // historical pedidos keep references to it.
      const doc = await aguardarFrete(id, (d) => d?.ativo === false, 'desativado');
      expect(doc).toMatchObject({
        nome: 'Loja de teste C',
        contaLojaIntegradaEnviosOuterRef: backRef(conta),
      });
    }, 120_000);

    it('um doc migrado (id automático, back-ref canônica) é ADOTADO — e nenhum lojaIntegrada-<id> nasce ao lado', async () => {
      const conta = CONTA.adotar;
      // The legacy shape: an auto id, the canonical back-ref, an older name and date, and the
      // operator's configuration.
      await freteRef(ID_ADOTADO).set({
        tipo: INTEGRACAO_FRETE.lojaIntegrada,
        nome: 'Nome legado',
        ativo: true,
        contaLojaIntegradaEnviosOuterRef: backRef(conta),
        filialIntegracaoFreteOuterRef: FILIAL,
        dataCadastro: 1,
        ultimaModificacao: 1,
        mapa: [LINHA_MAPA],
        horarioDeCorte: [HORARIO],
      });

      await contaRef(conta).set(contaCompleta('Nome atual'));

      const doc = await aguardarFrete(
        ID_ADOTADO,
        (d) => d?.nome === 'Nome atual' && d?.dataCadastro === DATA_CADASTRO,
        'adotado',
      );
      expect(doc).toMatchObject({
        tipo: INTEGRACAO_FRETE.lojaIntegrada,
        ativo: true,
        contaLojaIntegradaEnviosOuterRef: backRef(conta),
        filialIntegracaoFreteOuterRef: FILIAL,
      });
      expect(doc.mapa).toEqual([LINHA_MAPA]);
      expect(doc.horarioDeCorte).toEqual([HORARIO]);

      // Sound after the positive: the ONE reconcile this conta write caused is the one that
      // patched the adopted doc, and every later one finds it by the same lookup — a create
      // needs a reconcile that missed it.
      expect((await freteRef(idDeterministico(conta)).get()).exists).toBe(false);
      const porBackRef = await db()
        .collection(INT_FRETE)
        .where('contaLojaIntegradaEnviosOuterRef', '==', backRef(conta))
        .get();
      expect(porBackRef.docs.map((d) => d.id)).toEqual([ID_ADOTADO]);
    }, 120_000);
  },
);
