import { describe, expect, it } from 'vitest';
import { historicoFreteInicialMeta, historicoFreteInicialSchema } from './historicoFtIni';

describe('historicoFreteInicialSchema', () => {
  it('requires estado and defaults the rest to null', () => {
    expect(historicoFreteInicialSchema.safeParse({}).success).toBe(false);
    const out = historicoFreteInicialSchema.parse({ estado: 'postado' });
    expect(out.estado).toBe('postado');
    expect(out.obs).toBeNull();
    expect(out.data).toBeNull();
    expect(out.usuarioHistoricoFreteInicialOuterRef).toBeNull();
    expect(out.eventId).toBeNull();
  });

  it('rejects an unknown estado', () => {
    expect(historicoFreteInicialSchema.safeParse({ estado: 'zzz' }).success).toBe(false);
  });

  it('parses a bare legacy row and KEEPS its millisecond `data` untouched', () => {
    // The legacy Dart writer emits estado/obs/data only, with `data` as a
    // ms epoch (`maybeDateTimeToJson`). If the tolerant preprocess ever
    // reclassified this value as µs — or if the field were switched to
    // `microsSinceEpoch` — the stored sort key would drift by ~1000× and the
    // limit-50 defaultQuery would hide every legacy row behind the new ones.
    const legacyMillis = 1_712_345_678_901; // 2024-04-05T18:14:38.901Z
    const out = historicoFreteInicialSchema.parse({
      estado: 'postado',
      obs: null,
      data: legacyMillis,
    });
    expect(out.data).toBe(legacyMillis);
  });

  it('keeps the legacy base-model keys `.passthrough()` exists for', () => {
    // Every key here is one the Dart writer emits but this schema does not
    // declare. Without `.passthrough()` they are stripped on read, which the
    // previous case would NOT catch — it parses only declared fields, so it
    // stays green while a legacy row silently loses its Firestore metadata.
    const legacyMillis = 1_712_345_678_901;
    const out = historicoFreteInicialSchema.parse({
      estado: 'postado',
      data: legacyMillis,
      docId: 'documents/pedidos/p1/historicoFtIni/h1',
      createTime: legacyMillis,
      updateTime: legacyMillis,
    });
    expect(out.docId).toBe('documents/pedidos/p1/historicoFtIni/h1');
    expect(out.createTime).toBe(legacyMillis);
    expect(out.updateTime).toBe(legacyMillis);
  });

  it('lives at pedidos/{pedidoId}/historicoFtIni with pedido perms', () => {
    expect(historicoFreteInicialMeta.collectionPath).toBe('pedidos/{pedidoId}/historicoFtIni');
    expect(historicoFreteInicialMeta.permissions.write).toBe(1n << 17n);
  });

  it('is server-owned and declares the newest-first default query', () => {
    expect(historicoFreteInicialMeta.serverOwned).toBe(true);
    expect(historicoFreteInicialMeta.defaultQuery).toEqual({
      orderBy: [{ field: 'data', direction: 'desc' }],
      limit: 50,
    });
  });
});
