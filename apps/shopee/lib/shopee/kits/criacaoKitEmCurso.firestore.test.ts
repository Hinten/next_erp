/**
 * The native-kit create LEASE (`./criacaoKitEmCurso.ts`, #1912) against a REAL
 * Firestore — the emulator lane, `ci-shopee.yml`'s ONE job
 * (`vitest.tasks.config.ts` collects the `.firestore.` suffix).
 *
 * `criacaoKitEmCurso.test.ts` covers every decision over `FakeDb`; the draft
 * suite (`anuncios/rascunho.firestore.test.ts`) already proves on this engine
 * that `create()` answers `ALREADY_EXISTS` and that a stale
 * `update`/`delete({ lastUpdateTime })` is refused. This file covers only what
 * the lease's whole promise rests on and only the real engine can confirm:
 *
 *  1. **Concurrent takers ⇒ exactly ONE lease.** N runs racing on one
 *     (conta, kit produto) — the double click, two tabs, the CLI — leave one
 *     winner; every other one is refused `SHOPEE_KIT_CRIACAO_EM_ANDAMENTO`.
 *  2. **The identity fence holds on the engine.** A holder whose lease was taken
 *     over is refused at its pre-send stamp, and never stamps the new lease.
 *  3. **The `default` database wiring**, through the PRODUCTION accessor
 *     `getAdminFirestore()`, with POSITIVE existence assertions (a mis-targeted
 *     `(default)` database silently exists in the emulator).
 *
 * ⚠️ Shared emulators: `kitCriacaoShopee` has no trigger in this codebase, every
 * produto id is a fresh `kit-lease-<uuid>` and the conta is minted for this file
 * (`int-lease-1`); `afterEach` deletes every lease it may have written. No
 * network and no Shopee.
 */
import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { kitCriacaoShopeeCollection } from '@delfrance/data/admin/collections';
import { CODIGO_CRIACAO_KIT_SHOPEE } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  ConflitoDeCriacaoDeKitShopeeError,
  liberarParaEnvio,
  liberarReserva,
  reservarCriacaoDeKit,
  type ControlesDaReservaDeKit,
} from './criacaoKitEmCurso';
import { idDaCriacaoDeKit } from './idsKit';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const CONTA = 'int-lease-1';
const AGORA = 1_760_000_000_000;

const db = (): Firestore => getAdminFirestore();
const escritos = new Set<string>();

function produto(): string {
  const id = `kit-lease-${randomUUID()}`;
  escritos.add(idDaCriacaoDeKit(CONTA, id));
  return id;
}

function controles(agora: number): ControlesDaReservaDeKit {
  return {
    agora: () => agora,
    prazoDaRequisicao: null,
    aquecerCredencial: () => Promise.resolve(),
  };
}

async function lease(produtoId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await kitCriacaoShopeeCollection
    .docRef(db(), {}, idDaCriacaoDeKit(CONTA, produtoId))
    .get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
}

afterEach(async () => {
  for (const id of escritos) await kitCriacaoShopeeCollection.docRef(db(), {}, id).delete();
  escritos.clear();
});

describe.skipIf(!EMULATED)('the native-kit create lease on the Firestore emulator', () => {
  it('five concurrent takers of ONE kit produto ⇒ exactly one lease; every other one is refused em-andamento', async () => {
    const id = produto();
    const alvo = { integracaoId: CONTA, produtoId: id, arma: 'kit-criar' } as const;

    const r = await Promise.allSettled(
      Array.from({ length: 5 }, () => reservarCriacaoDeKit(db(), alvo, controles(AGORA))),
    );

    const vencedores = r.filter((x) => x.status === 'fulfilled');
    expect(vencedores).toHaveLength(1);
    for (const x of r) {
      if (x.status === 'rejected') {
        expect(x.reason).toBeInstanceOf(ConflitoDeCriacaoDeKitShopeeError);
        expect(x.reason).toMatchObject({ code: CODIGO_CRIACAO_KIT_SHOPEE.emAndamento });
      }
    }
    const venc = vencedores[0]?.status === 'fulfilled' ? vencedores[0].value : null;
    // POSITIVE: the lease exists in the `default` database, and it is the winner's.
    expect(await lease(id)).toMatchObject({ token: venc?.token, enviadoEmMs: null });
  });

  it('a holder whose lease was taken over is refused at its pre-send stamp, and never stamps the NEW lease', async () => {
    const id = produto();
    const alvo = { integracaoId: CONTA, produtoId: id, arma: 'kit-criar' } as const;
    const velho = await reservarCriacaoDeKit(db(), alvo, controles(AGORA));
    const novo = await reservarCriacaoDeKit(db(), alvo, controles(velho.ateMs));

    const erro = await liberarParaEnvio(db(), velho, 'KIT-1').then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toMatchObject({ code: CODIGO_CRIACAO_KIT_SHOPEE.expirada });
    expect(await lease(id)).toMatchObject({ token: novo.token, enviadoEmMs: null });

    // The old holder's release never deletes the new lease; the new one's does.
    await liberarReserva(db(), velho);
    expect(await lease(id)).toMatchObject({ token: novo.token });
    await liberarReserva(db(), novo);
    expect(await lease(id)).toBeUndefined();
  });
});
