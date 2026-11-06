/**
 * The bucket double's own contract (`fakeBucket.ts`): what the shared uploader sends is recorded
 * byte for byte, and everything the uploader never sends THROWS — a double that quietly accepted
 * an unmodelled call would make every photo suite read green over it. Each refusal is pinned
 * beside the accepted call it is a near-miss of.
 */
import { describe, expect, it } from 'vitest';
import { FILETYPE } from '@delfrance/schemas';
import { putArquivoAdmin } from '@delfrance/storage/admin';

import { FakeBucket, asBucket } from './fakeBucket';
import { FakeDb, asDb } from './fakeDb';

const CAMINHO = 'produtos/p1/originals/abc.png';
const OPCOES = { contentType: 'image/png', metadata: { metadata: { arquivoId: 'p1_abc' } } };

describe('FakeBucket — what it records', () => {
  it('a save lands with its path, a COPY of its bytes, its content type and its metadata', async () => {
    const bucket = new FakeBucket();
    const bytes = new Uint8Array([1, 2, 3]);
    await bucket.file(CAMINHO).save(bytes, OPCOES);
    // The caller's buffer changing afterwards changes nothing recorded.
    bytes[0] = 9;
    expect(bucket.salvos).toEqual([
      {
        caminho: CAMINHO,
        bytes: Buffer.from([1, 2, 3]),
        contentType: 'image/png',
        metadata: OPCOES.metadata,
      },
    ]);
    expect(bucket.caminhos).toEqual([CAMINHO]);
    expect(bucket.file(CAMINHO).name).toBe(CAMINHO);
  });

  it('carries a plausible default-bucket name, never a marker', () => {
    expect(new FakeBucket().name).toBe('demo-erp.firebasestorage.app');
    expect(new FakeBucket('outro.firebasestorage.app').name).toBe('outro.firebasestorage.app');
  });

  it('the REAL uploader runs on it: create-first anchor, then the object, then the tokened url', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    await putArquivoAdmin({
      db: asDb(db),
      bucket: asBucket(bucket),
      docId: 'p1_abc',
      storagePath: CAMINHO,
      bytes: Buffer.from([0x89, 0x50]),
      contentType: 'image/png',
      filetype: FILETYPE.image,
      resizeState: 'pending',
    });
    expect(bucket.caminhos).toEqual([CAMINHO]);
    const arquivo = db.ler('arquivos/p1_abc');
    expect(arquivo?.url).toEqual(expect.stringContaining('demo-erp.firebasestorage.app'));
    expect(bucket.salvos[0]?.metadata).toEqual({
      metadata: expect.objectContaining({ arquivoId: 'p1_abc' }) as unknown,
    });
  });
});

describe('FakeBucket — it THROWS on anything else', () => {
  it('an injected failure rejects that path only; a save never fails by default', async () => {
    const bucket = new FakeBucket();
    bucket.falhaAoSalvar.set(CAMINHO, new Error('storage fora'));
    await expect(bucket.file(CAMINHO).save(Buffer.from([1]), OPCOES)).rejects.toThrow(
      'storage fora',
    );
    // NEAR-MISS: another path is untouched by it.
    await bucket.file('produtos/p1/originals/outro.png').save(Buffer.from([1]), OPCOES);
    expect(bucket.caminhos).toEqual(['produtos/p1/originals/outro.png']);
  });

  it.each(['', '/produtos/p1/x.png', 'produtos//x.png', 'produtos/p1/'])(
    'refuses the object path %j (the uploader never builds one)',
    (caminho) => {
      expect(() => new FakeBucket().file(caminho)).toThrow(TypeError);
    },
  );

  it('refuses a body that is not bytes, a save with no options or no content type', async () => {
    const arquivo = new FakeBucket().file(CAMINHO);
    await expect(arquivo.save('texto' as unknown as Buffer, OPCOES)).rejects.toThrow(/bytes/);
    await expect(arquivo.save(Buffer.from([1]))).rejects.toThrow(/sem opções/);
    await expect(arquivo.save(Buffer.from([1]), { metadata: {} })).rejects.toThrow(/contentType/);
    await expect(
      arquivo.save(Buffer.from([1]), { contentType: 'image/png', metadata: 'x' }),
    ).rejects.toThrow(/metadata/);
  });

  it('refuses any option the uploader never passes (a resumable flag, a precondition)', async () => {
    const arquivo = new FakeBucket().file(CAMINHO);
    await expect(arquivo.save(Buffer.from([1]), { ...OPCOES, resumable: false })).rejects.toThrow(
      /resumable/,
    );
    await expect(
      arquivo.save(Buffer.from([1]), { ...OPCOES, preconditionOpts: { ifGenerationMatch: 0 } }),
    ).rejects.toThrow(/preconditionOpts/);
  });

  it('the bucket and the file handle have nothing but what the uploader uses', () => {
    const bucket = asBucket(new FakeBucket());
    expect(() => bucket.upload('x')).toThrow(TypeError);
    expect(() => bucket.getFiles()).toThrow(TypeError);
    const arquivo = bucket.file(CAMINHO);
    expect(() => arquivo.delete()).toThrow(TypeError);
    expect(() => arquivo.exists()).toThrow(TypeError);
    expect(() => arquivo.download()).toThrow(TypeError);
  });
});

describe('FakeBucket — a held save (the upload that does not answer)', () => {
  it('waits until released, then lands; nothing is recorded while it is held', async () => {
    const bucket = new FakeBucket();
    const seguro = bucket.segurar(CAMINHO);
    expect(seguro.chamado).toBe(false);
    let terminou = false;
    const envio = bucket
      .file(CAMINHO)
      .save(Buffer.from([7]), OPCOES)
      .then(() => {
        terminou = true;
      });
    await Promise.resolve();
    expect(seguro.chamado).toBe(true);
    expect(terminou).toBe(false);
    expect(bucket.salvos).toEqual([]);
    seguro.soltar();
    await envio;
    expect(bucket.caminhos).toEqual([CAMINHO]);
  });

  it('a held save failed by the suite records nothing; the hold is one-shot', async () => {
    const bucket = new FakeBucket();
    const seguro = bucket.segurar(CAMINHO);
    const envio = bucket.file(CAMINHO).save(Buffer.from([7]), OPCOES);
    seguro.falhar(new Error('caiu'));
    await expect(envio).rejects.toThrow('caiu');
    expect(bucket.salvos).toEqual([]);
    // The next save on the same path is not held.
    await bucket.file(CAMINHO).save(Buffer.from([8]), OPCOES);
    expect(bucket.salvos.map((s) => [...s.bytes])).toEqual([[8]]);
  });
});
