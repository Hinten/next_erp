/**
 * The anchor trigger's EFFECT, awaited — for the emulator suites only (`*.tasks.test.ts`,
 * `*.firestore.test.ts`; master plan step 9, PR 9-v). Test-only, like everything under
 * `testing/`.
 *
 * `onProdutoLojaIntegradaLinkChanged` loads with the whole functions codebase in the lane's
 * functions emulator, so it fires on EVERY suite's
 * `produtos/{produtoId}/produtolojaintegrada/{linkId}` writes, not only its own suite's. A write travels this process → the Firestore emulator → the
 * functions emulator → the trigger → `produtos/{id}.integracoesComProduto`, so there is no
 * promise to await, only the effect. A suite that writes link documents therefore:
 *
 *  - awaits the anchor's write on each produto it seeded links under, UNCONDITIONALLY, before it
 *    asserts on that produto or races a precondition on it — never "only if it fails"; and
 *  - before it ends, removes those links and awaits the anchor's LAST write (the conta leaving
 *    the array), so no anchor write of one file lands inside the next file's run, and
 *    `emulators:exec` never tears the emulators down mid-write.
 *
 * Polling for the expected POSITIVE state is the only form this takes: an absence ("the trigger
 * did not touch it") is never polled for — it is proved by a later sentinel's positive.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';

/** The produto field the anchor owns. */
export const CAMPO_ANCORA_LI = 'integracoesComProduto';

/** How long a suite waits for one anchor write before it fails with the diagnosis below. */
export const PRAZO_ANCORA_LI_MS = 40_000;

/** Between two reads of the produto while waiting. */
const INTERVALO_MS = 250;

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The produto's anchor array as stored — `[]` when the field is absent or not an array — or
 * `null` when the produto itself is absent.
 */
export async function contasDaAncoraLi(
  db: Firestore,
  produtoId: string,
): Promise<readonly unknown[] | null> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!snap.exists) return null;
  const valor: unknown = snap.data()?.[CAMPO_ANCORA_LI];
  return Array.isArray(valor) ? (valor as unknown[]) : [];
}

/**
 * Poll the produto until its anchor array satisfies `pronto`, and return the array. An ABSENT
 * produto never satisfies it: the anchor never re-creates a produto, so waiting on one that is
 * gone could only time out.
 */
export async function aguardarAncoraLi(
  db: Firestore,
  produtoId: string,
  pronto: (contas: readonly unknown[]) => boolean,
  esperado: string,
  timeoutMs = PRAZO_ANCORA_LI_MS,
): Promise<readonly unknown[]> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const contas = await contasDaAncoraLi(db, produtoId);
    if (contas !== null && pronto(contas)) return contas;
    if (Date.now() > prazo) {
      throw new Error(
        `produtos/${produtoId}.${CAMPO_ANCORA_LI} não chegou a "${esperado}" em ` +
          `${String(timeoutMs)}ms; estado atual: ` +
          `${contas === null ? '<produto ausente>' : JSON.stringify(contas)}. ` +
          'Se a conta nunca chega, o gatilho de âncora não disparou: confira que ' +
          'prepare-deploy.mjs rodou antes do emulators:exec (o artefato carrega ' +
          'onProdutoLojaIntegradaLinkChanged), que o emulador de functions está no --only, e a ' +
          'saída do emulador de functions — uma falha do núcleo integracoesComProduto aparece ali.',
      );
    }
    await aguardar(INTERVALO_MS);
  }
}

/** The anchor holds `contaId`. */
export function comConta(contaId: string): (contas: readonly unknown[]) => boolean {
  return (contas) => contas.includes(contaId);
}

/** The anchor does not hold `contaId`. */
export function semConta(contaId: string): (contas: readonly unknown[]) => boolean {
  return (contas) => !contas.includes(contaId);
}
