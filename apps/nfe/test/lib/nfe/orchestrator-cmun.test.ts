import { describe, expect, it, vi } from 'vitest';
import type { DocumentReference } from 'firebase-admin/firestore';
import { decodeCMunTable, encodeCMunTable } from '@delfrance/core/cep/cmun';
import { ensureCodigoMunicipio } from '@/lib/nfe/orchestrator/cmun';
import { NFeOrchestratorError } from '@/lib/nfe/orchestrator/errors';

/**
 * `ensureCodigoMunicipio` is the emission-time backstop for #785: the NF-e
 * generator hard-requires `cMun` for `enderDest`, `enderEmit` AND `cMunFG`, but
 * nothing on any server path used to produce it.
 *
 * An explicit fixture table + a ViaCEP stub that throws if consulted keeps
 * these tests offline and independent of whether the real table is vendored.
 */
const TABLE = decodeCMunTable(
  encodeCMunTable([{ cepInicial: 1_310_000, cepFinal: 1_319_999, cMun: 3_550_308 }]),
);

const RESOLVE = {
  table: TABLE,
  viaCep: {
    buscarCep: vi.fn(() => {
      throw new Error('ViaCEP must not be consulted in these tests');
    }),
  },
} as const;

function fakeRef(update = vi.fn().mockResolvedValue(undefined)) {
  return { update } as unknown as DocumentReference & { update: typeof update };
}

/** A gRPC NOT_FOUND — the one write failure that must NOT fail an emission. */
function notFoundError(): Error {
  return Object.assign(new Error('NOT_FOUND'), { code: 5 });
}

describe('ensureCodigoMunicipio', () => {
  it('short-circuits on a stored 7-digit code without writing or resolving', async () => {
    const ref = fakeRef();

    const result = await ensureCodigoMunicipio(
      { cep: '99999999', codigoMunicipio: '3550308', estado: 'SP' },
      { persist: { ref, field: 'codigoMunicipio' }, contexto: 'endereco test', resolve: RESOLVE },
    );

    // The CEP is outside the fixture table and ViaCEP throws, so a pass proves
    // neither leg ran.
    expect(result.codigoMunicipio).toBe('3550308');
    expect(ref.update).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty string', ''],
    ['a 6-digit value', '355030'],
    ['null', null],
  ])('treats %s as missing and resolves', async (_label, stored) => {
    // `enderecoSchema.codigoMunicipio` is `.max(8).regex(/^\d*$/)`, so '' is
    // storable — and it used to reach the generator as `<cMun></cMun>`.
    const ref = fakeRef();

    const result = await ensureCodigoMunicipio(
      { cep: '01310100', codigoMunicipio: stored, estado: 'SP' },
      { persist: { ref, field: 'codigoMunicipio' }, contexto: 'endereco test', resolve: RESOLVE },
    );

    expect(result.codigoMunicipio).toBe('3550308');
    expect(ref.update).toHaveBeenCalledWith({ codigoMunicipio: '3550308' });
  });

  it('persists an embedded endereço through the DOTTED leaf path', async () => {
    // The anti-clobber guarantee: `filiais` is human-managed config, so the
    // write must touch exactly `sede.codigoMunicipio` and never the whole
    // `sede` map, which would overwrite a concurrent edit.
    const ref = fakeRef();

    await ensureCodigoMunicipio(
      { cep: '01310100', codigoMunicipio: null, estado: 'SP' },
      {
        persist: { ref, field: 'sede.codigoMunicipio' },
        contexto: "filial 'f1'.sede",
        resolve: RESOLVE,
      },
    );

    expect(ref.update).toHaveBeenCalledWith({ 'sede.codigoMunicipio': '3550308' });
  });

  it('resolves without writing when no persist target is given', async () => {
    const result = await ensureCodigoMunicipio(
      { cep: '01310100', codigoMunicipio: null, estado: 'SP' },
      { contexto: 'endereco test', resolve: RESOLVE },
    );

    expect(result.codigoMunicipio).toBe('3550308');
  });

  describe('write failures', () => {
    it('does not fail the emission when the document vanished (NOT_FOUND)', async () => {
      const ref = fakeRef(vi.fn().mockRejectedValue(notFoundError()));

      const result = await ensureCodigoMunicipio(
        { cep: '01310100', codigoMunicipio: null, estado: 'SP' },
        { persist: { ref, field: 'codigoMunicipio' }, contexto: 'endereco test', resolve: RESOLVE },
      );

      // The emission already has the value it needs; only the cache write lost.
      expect(result.codigoMunicipio).toBe('3550308');
    });

    it('rethrows any other write failure', async () => {
      // A permission failure here is a real service-account misconfiguration on
      // the highest-stakes path in the system — surface it, do not swallow it.
      const boom = Object.assign(new Error('PERMISSION_DENIED'), { code: 7 });
      const ref = fakeRef(vi.fn().mockRejectedValue(boom));

      await expect(
        ensureCodigoMunicipio(
          { cep: '01310100', codigoMunicipio: null, estado: 'SP' },
          {
            persist: { ref, field: 'codigoMunicipio' },
            contexto: 'endereco test',
            resolve: RESOLVE,
          },
        ),
      ).rejects.toBe(boom);
    });
  });

  describe('unresolvable', () => {
    it('names the document, the CEP and the reason', async () => {
      const err = await ensureCodigoMunicipio(
        { cep: '123', codigoMunicipio: null, estado: 'SP' },
        { contexto: "endereco 'clientes/c1/enderecos/e1'", resolve: RESOLVE },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NFeOrchestratorError);
      const message = (err as Error).message;
      expect(message).toContain('clientes/c1/enderecos/e1');
      expect(message).toContain('123');
      expect(message).toContain('cep-invalido');
    });

    it('reports a CEP that falls outside every faixa', async () => {
      const err = await ensureCodigoMunicipio(
        { cep: '99999999', codigoMunicipio: null, estado: 'SP' },
        { contexto: 'endereco test', resolve: { ...RESOLVE, offline: true } },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NFeOrchestratorError);
      expect((err as Error).message).toContain('fora-das-faixas');
    });
  });
});
