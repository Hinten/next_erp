import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import type { LeitorDeImpostoPorOperacao, LeituraImposto } from '@delfrance/data/admin/imposto';
import { ORIGEM, type Imposto } from '@delfrance/schemas';

import { type AlvoFiscal, enviarDadosFiscais, registradoFiscal } from './dadosFiscais';
import { MOTIVO_DADOS_FISCAIS } from './dadosFiscaisPayload';

/* ------------------------------------------------------------------------ */
/* An in-memory db: just what `mergeIfExists` reaches — `update()` on a doc  */
/* that must exist (gRPC NOT_FOUND, code 5, otherwise).                       */
/* ------------------------------------------------------------------------ */
type DocData = Record<string, unknown>;

class FakeDb {
  readonly docs = new Map<string, DocData>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];

  seed(path: string, data: DocData = {}): this {
    this.docs.set(path, data);
    return this;
  }

  collection(colPath: string) {
    return {
      doc: (id: string) => {
        const path = `${colPath}/${id}`;
        return {
          update: async (patch: DocData) => {
            const atual = this.docs.get(path);
            if (atual == null) {
              throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
            }
            this.updates.push({ path, patch });
            this.docs.set(path, { ...atual, ...patch });
          },
        };
      },
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

const IMPOSTO: Imposto = {
  origem: ORIGEM.nacional,
  cfop: '5101',
  NCM: '61091000',
  unidade: 'UN',
  configuracaoICMS: { crt: '1', csosn: '102' },
};

function leitorFixo(
  por: Record<string, LeituraImposto> = {},
  padrao: LeituraImposto = { imposto: IMPOSTO, operacao: null, motivo: null },
): LeitorDeImpostoPorOperacao & { ler: ReturnType<typeof vi.fn> } {
  return { ler: vi.fn(async (id: string) => por[id] ?? padrao) };
}

function makeApi(over: Partial<Record<keyof MercadoLivreApi, unknown>> = {}) {
  return {
    updateFiscalInformation: vi.fn(async () => ({})),
    createFiscalInformation: vi.fn(async () => ({})),
    linkFiscalInformationItem: vi.fn(async () => ({ status: 'active' })),
    getCanInvoice: vi.fn(async () => ({ status: true })),
    ...over,
  } as unknown as MercadoLivreApi & Record<string, ReturnType<typeof vi.fn>>;
}

function alvo(
  produtoId: string,
  over: Partial<AlvoFiscal> & { sku?: string | null } = {},
): AlvoFiscal {
  const { sku = `SKU-${produtoId}`, ...resto } = over;
  return {
    produtoId,
    produto: { sku, nome: `Produto ${produtoId}`, gtin: null, pesoBrutoKg: 0.2 },
    pai: null,
    titulo: `Anúncio ${produtoId}`,
    itemId: `MLB${produtoId.replace(/\D/g, '') || '1'}`,
    variationId: null,
    link: { colecao: 'variacaoMercadoLivre', produtoId, docId: `v-${produtoId}` },
    registrado: { sku: null, itemId: null },
    ...resto,
  };
}

const linkPath = (a: AlvoFiscal) => `produtos/${a.produtoId}/variacaoMercadoLivre/${a.link.docId}`;

function dbCom(...alvos: AlvoFiscal[]): FakeDb {
  const db = new FakeDb();
  for (const a of alvos) db.seed(linkPath(a));
  return db;
}

const deps = (db: FakeDb, api: MercadoLivreApi, leitor = leitorFixo()) => ({
  db: asDb(db),
  api,
  operacaoOuterRef: 'operacao/op-venda',
  leitor,
  nowMs: () => 1_700_000_000_000,
});

describe('enviarDadosFiscais — the happy path', () => {
  it('PUTs the SKU, links it to the item, reads can_invoice and stamps `enviado`', async () => {
    const a = alvo('p1');
    const db = dbCom(a);
    const api = makeApi();

    const resumo = await enviarDadosFiscais(deps(db, api), [a]);

    expect(resumo).toEqual({ enviados: 1, omitidos: [], erros: [] });
    expect(api.updateFiscalInformation).toHaveBeenCalledWith(
      'SKU-p1',
      expect.objectContaining({ type: 'single', title: 'Anúncio p1' }),
    );
    expect(api.createFiscalInformation).not.toHaveBeenCalled();
    expect(api.linkFiscalInformationItem).toHaveBeenCalledWith({
      sku: 'SKU-p1',
      itemId: 'MLB1',
      variationId: null,
    });
    expect(db.docs.get(linkPath(a))).toEqual({
      dadosFiscaisEstado: 'enviado',
      dadosFiscaisMotivo: null,
      dadosFiscaisEm: 1_700_000_000_000,
      dadosFiscaisSku: 'SKU-p1',
      dadosFiscaisItemId: 'MLB1',
      podeFaturar: true,
    });
  });

  it('resolves the imposto of the CHILD produto, not the pai — like the nota', async () => {
    const a = alvo('filho-1', { pai: { sku: 'PAI' } });
    const leitor = leitorFixo();
    await enviarDadosFiscais(deps(dbCom(a), makeApi(), leitor), [a]);
    expect(leitor.ler).toHaveBeenCalledWith('filho-1');
  });

  it('weight and cost fall back to the pai’s when the child has none', async () => {
    const a = alvo('f1', {
      produto: { sku: 'S', pesoBrutoKg: null, custo: null },
      pai: { pesoBrutoKg: 0.35, custo: 12 },
    });
    const api = makeApi();
    await enviarDadosFiscais(deps(dbCom(a), api), [a]);
    const [, body] = vi.mocked(api.updateFiscalInformation).mock.calls[0]!;
    expect(body.cost).toBe(12);
    expect(body.tax_information).toMatchObject({ gross_weight: 0.35 });
  });

  it('a legacy variation links WITH its variation id', async () => {
    const a = alvo('f1', { variationId: 174390848694 });
    const api = makeApi();
    await enviarDadosFiscais(deps(dbCom(a), api), [a]);
    expect(api.linkFiscalInformationItem).toHaveBeenCalledWith(
      expect.objectContaining({ variationId: 174390848694 }),
    );
    expect(api.getCanInvoice).toHaveBeenCalledWith('MLB1', 174390848694);
  });
});

describe('enviarDadosFiscais — upsert', () => {
  it.each([
    ['a 404', new MercadoLivreHttpError('ML 404', 404, { error_code: '404 NOT_FOUND' })],
    [
      'a 400 carrying code 10086',
      new MercadoLivreHttpError('ML 400', 400, { message: 'Sku not found', error_code: '10086' }),
    ],
  ])('the PUT answering %s (unknown SKU) falls back to the POST', async (_caso, erro) => {
    const a = alvo('p1');
    const api = makeApi({ updateFiscalInformation: vi.fn(async () => Promise.reject(erro)) });

    const resumo = await enviarDadosFiscais(deps(dbCom(a), api), [a]);

    expect(api.createFiscalInformation).toHaveBeenCalledWith(
      expect.objectContaining({ sku: 'SKU-p1' }),
    );
    expect(resumo.enviados).toBe(1);
  });

  it('a 400 that is NOT "unknown SKU" is an error — never a blind POST', async () => {
    const erro = new MercadoLivreHttpError('ML 400', 400, {
      message: 'Many errors',
      error_code: 'json_validation_error',
      fields: [
        { field: 'tax_information.fci', message: 'A valid FCI is required', error_code: '10294' },
      ],
    });
    const a = alvo('p1');
    const db = dbCom(a);
    const api = makeApi({ updateFiscalInformation: vi.fn(async () => Promise.reject(erro)) });

    const resumo = await enviarDadosFiscais(deps(db, api), [a]);

    expect(api.createFiscalInformation).not.toHaveBeenCalled();
    expect(api.linkFiscalInformationItem).not.toHaveBeenCalled();
    // ML's own words, naming the field — not just `ML 400`.
    expect(resumo.erros[0]!.mensagem).toBe(
      'ML 400: Many errors; tax_information.fci: A valid FCI is required',
    );
    expect(db.docs.get(linkPath(a))).toMatchObject({
      dadosFiscaisEstado: 'erro',
      dadosFiscaisMotivo: resumo.erros[0]!.mensagem,
    });
    // An error leaves the recorded link pair alone.
    expect(db.docs.get(linkPath(a))).not.toHaveProperty('dadosFiscaisSku');
  });
});

describe('enviarDadosFiscais — the link call', () => {
  it('is SKIPPED while the link doc already records this exact SKU ↔ item pair', async () => {
    const a = alvo('p1', { registrado: { sku: 'SKU-p1', itemId: 'MLB1' } });
    const api = makeApi();
    await enviarDadosFiscais(deps(dbCom(a), api), [a]);
    expect(api.updateFiscalInformation).toHaveBeenCalled();
    expect(api.linkFiscalInformationItem).not.toHaveBeenCalled();
  });

  it.each([
    ['the SKU changed', { sku: 'SKU-antigo', itemId: 'MLB1' }],
    ['the item changed', { sku: 'SKU-p1', itemId: 'MLB999' }],
  ])('is made again when %s', async (_caso, registrado) => {
    const a = alvo('p1', { registrado });
    const api = makeApi();
    await enviarDadosFiscais(deps(dbCom(a), api), [a]);
    expect(api.linkFiscalInformationItem).toHaveBeenCalledTimes(1);
  });
});

describe('enviarDadosFiscais — omissions', () => {
  it('no operação on the conta: every SKU omitido with ZERO reads, writes or ML calls', async () => {
    const a = alvo('p1');
    const db = dbCom(a);
    const api = makeApi();
    const leitor = leitorFixo();

    const resumo = await enviarDadosFiscais({ db: asDb(db), api, operacaoOuterRef: '  ', leitor }, [
      a,
    ]);

    expect(resumo.omitidos).toEqual([
      { produtoId: 'p1', sku: 'SKU-p1', motivo: MOTIVO_DADOS_FISCAIS.semOperacao },
    ]);
    expect(leitor.ler).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
    expect(api.updateFiscalInformation).not.toHaveBeenCalled();
  });

  it('no SKU → omitido and stamped, with no ML call', async () => {
    const a = alvo('p1', { sku: '  ' });
    const db = dbCom(a);
    const api = makeApi();
    const resumo = await enviarDadosFiscais(deps(db, api), [a]);
    expect(resumo.omitidos[0]).toMatchObject({ sku: null, motivo: MOTIVO_DADOS_FISCAIS.semSku });
    expect(db.docs.get(linkPath(a))).toMatchObject({ dadosFiscaisEstado: 'omitido' });
    expect(api.updateFiscalInformation).not.toHaveBeenCalled();
  });

  it('the SAME SKU on a second produto is omitido — it would overwrite the first', async () => {
    const a = alvo('p1', { sku: 'IGUAL' });
    const b = alvo('p2', { sku: 'IGUAL' });
    const api = makeApi();
    const resumo = await enviarDadosFiscais(deps(dbCom(a, b), api), [a, b]);
    expect(resumo.enviados).toBe(1);
    expect(resumo.omitidos).toEqual([
      { produtoId: 'p2', sku: 'IGUAL', motivo: MOTIVO_DADOS_FISCAIS.skuDuplicado },
    ]);
    expect(api.updateFiscalInformation).toHaveBeenCalledTimes(1);
  });

  it('an imposto the cascade cannot resolve → omitido with the reason, no ML call', async () => {
    const a = alvo('p1');
    const api = makeApi();
    const leitor = leitorFixo({ p1: { imposto: null, operacao: null, motivo: 'sem-imposto' } });
    const resumo = await enviarDadosFiscais(deps(dbCom(a), api, leitor), [a]);
    expect(resumo.omitidos[0]!.motivo).toBe(MOTIVO_DADOS_FISCAIS.semImposto);
    expect(api.updateFiscalInformation).not.toHaveBeenCalled();
  });

  it('a body refusal (no NCM) → omitido with the mapper’s reason', async () => {
    const a = alvo('p1');
    const leitor = leitorFixo({
      p1: { imposto: { ...IMPOSTO, NCM: null }, operacao: null, motivo: null },
    });
    const resumo = await enviarDadosFiscais(deps(dbCom(a), makeApi(), leitor), [a]);
    expect(resumo.omitidos[0]!.motivo).toBe(MOTIVO_DADOS_FISCAIS.semNcm);
  });
});

describe('enviarDadosFiscais — failures never stop the run, and never fail it', () => {
  it('one SKU refused, the next still sent', async () => {
    const a = alvo('p1');
    const b = alvo('p2');
    const api = makeApi({
      updateFiscalInformation: vi.fn(async (sku: string) =>
        sku === 'SKU-p1'
          ? Promise.reject(new MercadoLivreHttpError('ML 400', 400, { message: 'NCM inválido' }))
          : {},
      ),
    });
    const resumo = await enviarDadosFiscais(deps(dbCom(a, b), api), [a, b]);
    expect(resumo.enviados).toBe(1);
    expect(resumo.erros).toEqual([
      { produtoId: 'p1', sku: 'SKU-p1', mensagem: 'ML 400: NCM inválido' },
    ]);
  });

  it('a transient network error on one SKU does NOT abort the others', async () => {
    const a = alvo('p1');
    const b = alvo('p2');
    const api = makeApi({
      updateFiscalInformation: vi.fn(async (sku: string) =>
        sku === 'SKU-p1' ? Promise.reject(new MercadoLivreNetworkError('rede caiu', null)) : {},
      ),
    });
    const resumo = await enviarDadosFiscais(deps(dbCom(a, b), api), [a, b]);
    expect(resumo.enviados).toBe(1);
    expect(api.updateFiscalInformation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 403', new MercadoLivreHttpError('ML 403', 403, { message: 'forbidden' })],
    [
      'a dead credential',
      new MercadoLivreReauthRequiredError('refresh_failed', 'reconecte a conta'),
    ],
  ])(
    '%s refuses the CONTA: the rest of the run records it without calling ML',
    async (_c, erro) => {
      const a = alvo('p1');
      const b = alvo('p2');
      const db = dbCom(a, b);
      const api = makeApi({ updateFiscalInformation: vi.fn(async () => Promise.reject(erro)) });

      const resumo = await enviarDadosFiscais(deps(db, api), [a, b]);

      expect(api.updateFiscalInformation).toHaveBeenCalledTimes(1);
      expect(resumo.erros).toHaveLength(2);
      expect(resumo.erros[1]!.mensagem).toBe(resumo.erros[0]!.mensagem);
      expect(db.docs.get(linkPath(b))).toMatchObject({ dadosFiscaisEstado: 'erro' });
    },
  );

  it('a non-ML error is NOT swallowed (rule 6) — it is a bug or Firestore, not ML’s refusal', async () => {
    const a = alvo('p1');
    const api = makeApi({
      updateFiscalInformation: vi.fn(async () => Promise.reject(new TypeError('bug'))),
    });
    await expect(enviarDadosFiscais(deps(dbCom(a), api), [a])).rejects.toThrow(TypeError);
  });

  it('a failed can_invoice read records `podeFaturar: null`, never false — the SKU is still sent', async () => {
    const a = alvo('p1');
    const db = dbCom(a);
    const api = makeApi({
      getCanInvoice: vi.fn(async () =>
        Promise.reject(new MercadoLivreHttpError('ML 500', 500, {})),
      ),
    });
    const resumo = await enviarDadosFiscais(deps(db, api), [a]);
    expect(resumo.enviados).toBe(1);
    expect(db.docs.get(linkPath(a))).toMatchObject({
      dadosFiscaisEstado: 'enviado',
      podeFaturar: null,
    });
  });

  it('a link doc deleted meanwhile is NOT resurrected as a ghost', async () => {
    const a = alvo('p1');
    const db = new FakeDb(); // no link doc seeded
    const resumo = await enviarDadosFiscais(deps(db, makeApi()), [a]);
    expect(resumo.enviados).toBe(1);
    expect(db.docs.size).toBe(0);
  });
});

describe('registradoFiscal', () => {
  it('reads the stored pair; a link that predates #745 has none', () => {
    expect(registradoFiscal({ dadosFiscaisSku: 'S', dadosFiscaisItemId: 'MLB1' })).toEqual({
      sku: 'S',
      itemId: 'MLB1',
    });
    expect(registradoFiscal({})).toEqual({ sku: null, itemId: null });
    expect(registradoFiscal(undefined)).toEqual({ sku: null, itemId: null });
  });
});
