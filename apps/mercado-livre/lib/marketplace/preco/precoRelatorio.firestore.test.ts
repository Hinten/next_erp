/**
 * The report's SHARD MERGE against a REAL Firestore (the emulator lane).
 *
 * `precoSync.test.ts` proves what the job records — a success carrying
 * `precoAnterior → preco`, a retry overwriting rather than duplicating, the
 * shard rollover — against a FakeDb. What it cannot prove is the single
 * Firestore behaviour every one of those rests on: that
 * `set({ linhas: { k: row } }, { merge: true })` DEEP-merges the nested map,
 * keeping the rows already stored, instead of replacing `linhas` wholesale.
 *
 * ⚠️ That is not a detail. If maps replaced, every checkpoint would erase every
 * row written before it, each shard would end up holding exactly ONE row, and
 * the offline suite would stay green throughout — because the fake merges
 * however whoever wrote it decided. A fake can only agree with its author, so
 * this is the assertion that is not circular.
 *
 * ⚠️ `db` comes from the production accessor `getAdminFirestore()`, never a local
 * copy — that puts the project/database wiring under test too. Every `it`
 * carries a POSITIVE existence assertion: in the emulator a mis-targeted
 * database silently auto-creates, so a file made only of "not found" assertions
 * passes identically against the wrong one.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_RESULTADO,
  type LinhaRelatorioEnvioPreco,
  relatorioEnvioPrecoRowKey,
  relatorioEnvioPrecoShardId,
} from '@delfrance/schemas';
import { relatorioEnvioPrecoMercadoLivreCollection } from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '@/lib/firebase/admin';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function linha(over: Partial<LinhaRelatorioEnvioPreco> = {}): LinhaRelatorioEnvioPreco {
  return {
    produtoId: 'prod-1',
    variacaoProdutoId: null,
    anuncioId: 'MLB1',
    linkDocId: 'lnk-1',
    resultado: ENVIO_PRECO_RESULTADO.enviado,
    fase: ENVIO_PRECO_FASE.envio,
    motivo: null,
    erro: null,
    preco: 50,
    precoAnterior: 40,
    variacoes: null,
    ...over,
  };
}

/** One shard write, exactly as `checkpoint()` performs it. */
async function gravar(envioId: string, linhas: Record<string, LinhaRelatorioEnvioPreco>) {
  const db = getAdminFirestore();
  await relatorioEnvioPrecoMercadoLivreCollection
    .docRef(db, { envioId }, relatorioEnvioPrecoShardId(0))
    .set(
      relatorioEnvioPrecoMercadoLivreCollection.parseMerge({
        linhas,
        timestamp: 1_700_000_000_000,
      }),
      { merge: true },
    );
}

async function ler(envioId: string): Promise<Record<string, LinhaRelatorioEnvioPreco>> {
  const db = getAdminFirestore();
  const snap = await relatorioEnvioPrecoMercadoLivreCollection
    .docRef(db, { envioId }, relatorioEnvioPrecoShardId(0))
    .get();
  const parsed = relatorioEnvioPrecoMercadoLivreCollection.parseRead(
    snap.data(),
    relatorioEnvioPrecoMercadoLivreCollection.docPath({ envioId }, relatorioEnvioPrecoShardId(0)),
  );
  return parsed.linhas;
}

describe.skipIf(!EMULATED)('the report shard against a real Firestore', () => {
  it('⭐ a second merge ADDS its row and keeps the first — maps deep-merge', async () => {
    // The whole offline suite assumes this. If `merge: true` replaced the map,
    // every checkpoint would wipe the run's history and each shard would end up
    // with exactly one row.
    const envioId = `test-${randomUUID()}`;
    const a = linha({ anuncioId: 'MLB-A', linkDocId: 'lnk-A' });
    const b = linha({
      anuncioId: 'MLB-B',
      linkDocId: 'lnk-B',
      resultado: ENVIO_PRECO_RESULTADO.falha,
      motivo: 'X',
    });
    const chaveA = relatorioEnvioPrecoRowKey(a);
    const chaveB = relatorioEnvioPrecoRowKey(b);

    await gravar(envioId, { [chaveA]: a });
    await gravar(envioId, { [chaveB]: b });

    const linhas = await ler(envioId);
    expect(Object.keys(linhas).sort()).toEqual([chaveA, chaveB].sort());
    expect(linhas[chaveA]).toMatchObject({ resultado: 'enviado', preco: 50, precoAnterior: 40 });
    expect(linhas[chaveB]).toMatchObject({ resultado: 'falha', motivo: 'X' });
  });

  it('⭐ the same KEY overwrites — which is what makes a retry idempotent', async () => {
    const envioId = `test-${randomUUID()}`;
    const primeira = linha({ resultado: ENVIO_PRECO_RESULTADO.enviado, motivo: null });
    const chave = relatorioEnvioPrecoRowKey(primeira);
    // A replayed draft: gate 2 answers PRECO_ANTIGO_IGUAL, same identity.
    const replay = linha({ resultado: ENVIO_PRECO_RESULTADO.pulado, motivo: 'PRECO_ANTIGO_IGUAL' });

    await gravar(envioId, { [chave]: primeira });
    await gravar(envioId, { [chave]: replay });

    const linhas = await ler(envioId);
    expect(Object.keys(linhas)).toEqual([chave]);
    expect(linhas[chave]).toMatchObject({ resultado: 'pulado', motivo: 'PRECO_ANTIGO_IGUAL' });
  });

  it('a row survives the round trip through parseRead with its money intact', async () => {
    // `preco`/`precoAnterior` are the point of the whole report; a coercion that
    // dropped or stringified them would be invisible in a counters-only check.
    const envioId = `test-${randomUUID()}`;
    const l = linha({ preco: 1234.56, precoAnterior: 999.99, variacoes: 3 });
    const chave = relatorioEnvioPrecoRowKey(l);

    await gravar(envioId, { [chave]: l });

    const lido = (await ler(envioId))[chave];
    expect(lido).toBeDefined();
    expect(lido!.preco).toBe(1234.56);
    expect(lido!.precoAnterior).toBe(999.99);
    expect(lido!.variacoes).toBe(3);
  });

  it('writes under the JOB it belongs to, not a top-level collection', async () => {
    // The path carries `{envioId}`; a handle resolving it wrongly would still
    // "work" against a collection nobody reads.
    const envioId = `test-${randomUUID()}`;
    const l = linha();
    await gravar(envioId, { [relatorioEnvioPrecoRowKey(l)]: l });

    const db = getAdminFirestore();
    const snap = await db.doc(`enviosPrecoMercadoLivre/${envioId}/relatorios/0000`).get();
    expect(snap.exists).toBe(true);
  });
});
