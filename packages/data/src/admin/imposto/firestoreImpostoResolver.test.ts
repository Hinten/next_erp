import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { createFirestoreImpostoResolver, lerResolverBundle } from './firestoreImpostoResolver';
import type { ResolverBundle } from './resolverImposto';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
/**
 * Per-suite in-memory double, this package's convention
 * (`resolveProdutoPorSku.test.ts`, `findOrCreateCliente.test.ts`) — packages/data
 * cannot import from apps/.
 *
 * ⚠️ It models the HANDLE shape: the whole resolved path arrives as ONE
 * argument, every segment included. That is precisely why `apps/nfe`'s own
 * suite could not drive this binding — its double models the nested
 * root → doc → subcollection chain instead — and why the app keeps its own copy
 * of these 25 lines (C38).
 */
type DocData = Record<string, unknown>;

class FakeDb {
  private readonly cols = new Map<string, Map<string, DocData>>();
  /** Every path read, in order — lets a test assert the SHAPE and the COUNT. */
  readonly lidos: string[] = [];

  seed(colPath: string, id: string, data: DocData): this {
    let col = this.cols.get(colPath);
    if (!col) this.cols.set(colPath, (col = new Map()));
    col.set(id, data);
    return this;
  }

  collection(colPath: string) {
    const col = this.cols.get(colPath) ?? new Map<string, DocData>();
    const self = this;
    return {
      doc(id: string) {
        return {
          async get() {
            self.lidos.push(`${colPath}/${id}`);
            const data = col.get(id);
            return { exists: data != null, data: () => data };
          },
        };
      },
      async get() {
        self.lidos.push(colPath);
        return {
          docs: [...col.entries()].map(([id, data]) => ({
            id,
            ref: { path: `${colPath}/${id}` },
            data: () => data,
          })),
        };
      },
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

const ACTIVE_OPERACAO = 'op-active';
const VALID_IMPOSTO_BLOB = { origem: '0', configuracaoICMS: { crt: '1', csosn: '102' } } as const;
const BLOB_400 = { origem: '0', configuracaoICMS: { crt: '1', csosn: '400' } } as const;
const bundleVazio: ResolverBundle = { operacaoId: ACTIVE_OPERACAO, regrasImposto: [] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFirestoreImpostoResolver — as três leituras pelos handles', () => {
  it('resolve exatamente os caminhos legados: produtos/{id}, produtos/{id}/imposto e categorias/{id}/imposto', async () => {
    const db = new FakeDb()
      .seed('produtos', 'p1', { categoriaProdutoOuterRef: 'categorias/cat-7' })
      .seed('categorias/cat-7/imposto', ACTIVE_OPERACAO, {
        impostoCategoriaOperacaoOuterRef: `operacao/${ACTIVE_OPERACAO}`,
        ...BLOB_400,
      });

    const out = await createFirestoreImpostoResolver(asDb(db), bundleVazio).resolve('p1', null);

    expect(out?.configuracaoICMS?.csosn).toBe('400');
    expect(db.lidos).toEqual(['produtos/p1/imposto', 'produtos/p1', 'categorias/cat-7/imposto']);
  });

  it('o produto é lido CRU — NCM e categoriaProdutoOuterRef viajam no passthrough de produtoSchema', async () => {
    // Nenhum dos dois é campo declarado de `produtoSchema`. Uma leitura validada
    // os perderia e a cascata pararia na camada 2 para sempre.
    const db = new FakeDb()
      .seed('produtos', 'p1', { NCM: '6109.10.00', categoriaProdutoOuterRef: 'categorias/cat-7' })
      .seed('categorias/cat-7/imposto', 'c1', {
        impostoCategoriaOperacaoOuterRef: null,
        ...BLOB_400,
      });

    const out = await createFirestoreImpostoResolver(asDb(db), bundleVazio).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('400');
  });

  it('um doc que falha o seu PRÓPRIO schema é DESCARTADO com um warn nomeando o path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // `NVE` tem de ser uma lista; um número não é nem a forma do wire nem um
    // escalar legado, então o doc genuinamente não pode ser lido.
    const db = new FakeDb().seed('produtos/p1/imposto', ACTIVE_OPERACAO, {
      NVE: 42,
      ...VALID_IMPOSTO_BLOB,
    });

    const out = await createFirestoreImpostoResolver(asDb(db), bundleVazio).resolve('p1', null);

    expect(out).toBeNull();
    const mensagens = warn.mock.calls.map((c) => String(c[0]));
    expect(mensagens.some((m) => m.includes(`produtos/p1/imposto/${ACTIVE_OPERACAO}`))).toBe(true);
    expect(mensagens.some((m) => m.includes('does not match its collection schema'))).toBe(true);
  });

  it('⛔ QUASE-IGUAL: um doc com as formas LEGADAS (NVE lista, indEscala boolean) CHEGA à cascata', async () => {
    // O oposto do caso acima, e o motivo de o drop ser por `safeParse` do schema
    // da COLEÇÃO e não por uma checagem à mão: a tolerância de leitura do #466
    // tem de sobreviver.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new FakeDb().seed('produtos/p1/imposto', ACTIVE_OPERACAO, {
      NVE: ['AB1234'],
      indEscala: true,
      ...VALID_IMPOSTO_BLOB,
    });

    const out = await createFirestoreImpostoResolver(asDb(db), bundleVazio).resolve('p1', null);

    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).not.toContain(
      'does not match its collection schema',
    );
  });
});

describe('lerResolverBundle', () => {
  it('operação ausente ⇒ null, e as regras NEM são lidas', async () => {
    const db = new FakeDb();
    expect(await lerResolverBundle(asDb(db), ACTIVE_OPERACAO)).toBeNull();
    expect(db.lidos).toEqual([`operacao/${ACTIVE_OPERACAO}`]);
  });

  it('a operação vai CRUA para o bundle — nada de operacaoSchema no caminho', async () => {
    // A camada 5 roda `impostoSchema.safeParse(operacao)` ela mesma e descarta
    // os campos que não são do Imposto. Parsear aqui com `operacaoSchema`
    // perderia as chaves do passthrough que essa camada lê — e este documento
    // nem sequer satisfaz `operacaoSchema`.
    const bruto = { campoLegadoQueNinguemModela: 'x', ...BLOB_400 };
    const db = new FakeDb().seed('operacao', ACTIVE_OPERACAO, bruto);

    const bundle = await lerResolverBundle(asDb(db), ACTIVE_OPERACAO);

    expect(bundle?.operacao).toEqual(bruto);
    expect(bundle?.operacaoId).toBe(ACTIVE_OPERACAO);
    // e a camada 5 resolve a partir dele
    const out = await createFirestoreImpostoResolver(asDb(new FakeDb()), bundle!).resolve(
      'p1',
      null,
    );
    expect(out?.configuracaoICMS?.csosn).toBe('400');
  });

  it('uma regra inválida é descartada com um warn; as válidas sobrevivem', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new FakeDb()
      .seed('operacao', ACTIVE_OPERACAO, { ...VALID_IMPOSTO_BLOB })
      .seed('operacao/op-active/regras', 'boa', { produtos: ['p1'], ...BLOB_400 })
      .seed('operacao/op-active/regras', 'ruim', { produtos: 'p1', ...VALID_IMPOSTO_BLOB });

    const bundle = await lerResolverBundle(asDb(db), ACTIVE_OPERACAO);

    expect(bundle?.regrasImposto.map((r) => r.id)).toEqual(['boa']);
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).toContain(
      'operacao/op-active/regras/ruim',
    );
  });

  it('duas leituras, sempre: o doc da operação e a subcoleção regras', async () => {
    const db = new FakeDb().seed('operacao', ACTIVE_OPERACAO, { ...VALID_IMPOSTO_BLOB });
    await lerResolverBundle(asDb(db), ACTIVE_OPERACAO);
    expect(db.lidos).toEqual([`operacao/${ACTIVE_OPERACAO}`, `operacao/${ACTIVE_OPERACAO}/regras`]);
  });
});
