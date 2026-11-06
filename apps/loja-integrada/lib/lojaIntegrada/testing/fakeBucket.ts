/**
 * A fake Cloud Storage bucket, **for tests only** — the double the product import's photos
 * (master plan step 9, "complete") drive the shared uploader `putArquivoAdmin` against.
 *
 * ⚠️ Nothing under `lib/lojaIntegrada/**` outside a `*.test.ts` may import this module
 * (`estrutura.test.ts` checks it app-wide). `apps/shopee/lib/shopee/testing/fakeBucket.ts` is the
 * model, rewritten here because apps have no dependency edges between them.
 *
 * It exists so the photo suites run through the REAL `@delfrance/storage/admin` uploader rather
 * than a mock of it: what is under test is what the import hands the uploader — the object PATH,
 * the content type read from the bytes, the `arquivoId` metadata the deployed storage triggers map
 * an object back to its document by — and a mocked uploader cannot show that.
 *
 * ## Exactly what it supports — and it THROWS on anything else
 *
 * `putArquivoAdmin` (`packages/storage/src/admin/upload.ts`) touches exactly two things on a bucket:
 *
 *  - `bucket.name`, interpolated into the tokened download URL, so it is a plausible bucket name (in
 *    the `.firebasestorage.app` spelling a project created after late 2024 gets), never a marker;
 *  - `bucket.file(path).save(bytes, { contentType, metadata })`, the upload.
 *
 * Nothing else exists on either object, so any other call (`bucket.upload`, `file.delete`,
 * `file.exists`, a download) throws a `TypeError`, and `file()` and `save()` refuse what the
 * uploader never sends: an empty or absolute path, a path with an empty segment, a body that is
 * not bytes, a missing content type, and any option besides those two (a `resumable` flag, a
 * precondition). A double that quietly accepted an unmodelled call would let a suite read green
 * over a call the real bucket answers differently.
 *
 * ⚠️ {@link FakeBucket.salvos} keeps the BYTES as well as the path: the import is
 * content-addressed (the object name and the document id are the bytes' sha-512), so a suite must
 * be able to prove that what was hashed is what was uploaded. Recording only the path would let a
 * swapped-bytes mutant pass.
 *
 * ⚠️ `save` never fails on its own. A Storage failure is infrastructure — the import must let it
 * propagate (the task retries), never count it as a refused picture — so a suite injects one with
 * {@link FakeBucket.falhaAoSalvar}, keyed by the object path, and the absence of a default failure
 * keeps the happy path honest. {@link FakeBucket.segurar} holds the next save on a path until the
 * suite releases it: the upload that outlives its deadline.
 */
import type { Bucket } from '@delfrance/storage/admin';

/** One recorded upload. */
export interface SalvoNoFakeBucket {
  readonly caminho: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

/** A held save (`segurar`): released, or failed, by the suite. */
export interface SaveSeguro {
  /** Let the held save land (it is then recorded, as any save). */
  soltar(): void;
  /** Fail the held save with `erro` (nothing is recorded). */
  falhar(erro: Error): void;
  /** Whether the held save has been called yet. */
  readonly chamado: boolean;
}

/** The only options the uploader passes to `save`. */
const OPCOES_DE_SAVE = new Set(['contentType', 'metadata']);

/** The shape `save` is handed, before it is checked. */
interface OpcoesDeSave {
  readonly [chave: string]: unknown;
}

function caminhoValido(caminho: unknown): caminho is string {
  return (
    typeof caminho === 'string' &&
    caminho !== '' &&
    !caminho.startsWith('/') &&
    !caminho.endsWith('/') &&
    !caminho.includes('//')
  );
}

export class FakeBucket {
  /** A plausible default-bucket name, in the post-2024 spelling (header). */
  readonly name: string;
  /** Every upload that LANDED, in order. A failed or held one is not here. */
  readonly salvos: SalvoNoFakeBucket[] = [];
  /** Injected upload failures, keyed by the FULL object path: every save there rejects. */
  readonly falhaAoSalvar = new Map<string, Error>();
  /** The held saves (`segurar`), by path: the promise a save waits on, and whether it came. */
  private readonly seguros = new Map<
    string,
    { readonly promessa: Promise<void>; readonly estado: { chamado: boolean } }
  >();

  constructor(name = 'demo-erp.firebasestorage.app') {
    this.name = name;
  }

  /** The object paths uploaded, in order — the common assertion, spelled once. */
  get caminhos(): string[] {
    return this.salvos.map((s) => s.caminho);
  }

  /**
   * Hold the NEXT save on `caminho` (one-shot) until the suite calls `soltar` or `falhar` on the
   * handle returned: an upload that does not answer.
   */
  segurar(caminho: string): SaveSeguro {
    let soltar: () => void = () => undefined;
    let falhar: (erro: Error) => void = () => undefined;
    const promessa = new Promise<void>((resolve, reject) => {
      soltar = resolve;
      falhar = reject;
    });
    const estado = { chamado: false };
    this.seguros.set(caminho, { promessa, estado });
    return {
      soltar,
      falhar,
      get chamado() {
        return estado.chamado;
      },
    };
  }

  /**
   * The Admin SDK hands back a file HANDLE, so `save` closes over the bucket (an arrow function,
   * capturing `this`) rather than being a method on it. The handle has `name` and `save`, nothing
   * else (header).
   */
  file(caminho: string) {
    if (!caminhoValido(caminho)) {
      throw new TypeError(`FakeBucket: caminho de objeto inválido (${JSON.stringify(caminho)})`);
    }
    return {
      name: caminho,
      save: (bytes: Buffer | Uint8Array, opts?: OpcoesDeSave): Promise<void> =>
        this.salvar(caminho, bytes, opts),
    };
  }

  private async salvar(caminho: string, bytes: unknown, opts: OpcoesDeSave | undefined) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('FakeBucket: save só aceita bytes (Buffer ou Uint8Array)');
    }
    if (opts === undefined) throw new TypeError('FakeBucket: save sem opções não é modelado');
    for (const chave of Object.keys(opts)) {
      if (!OPCOES_DE_SAVE.has(chave)) {
        throw new TypeError(`FakeBucket: opção de save não modelada (${chave})`);
      }
    }
    const { contentType, metadata } = opts;
    if (typeof contentType !== 'string' || contentType === '') {
      throw new TypeError('FakeBucket: save sem contentType não é modelado');
    }
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null)) {
      throw new TypeError('FakeBucket: metadata precisa ser um objeto');
    }
    // Copied BEFORE any wait: a caller that reuses its buffer cannot change what was uploaded.
    const copia = Buffer.from(bytes);
    const seguro = this.seguros.get(caminho);
    if (seguro !== undefined) {
      this.seguros.delete(caminho);
      seguro.estado.chamado = true;
      await seguro.promessa;
    }
    const falha = this.falhaAoSalvar.get(caminho);
    if (falha !== undefined) throw falha;
    this.salvos.push({
      caminho,
      bytes: copia,
      contentType,
      metadata: metadata as Readonly<Record<string, unknown>> | undefined,
    });
  }
}

/** The cast every suite needs exactly once — `Bucket` is the Admin SDK's own shape. */
export function asBucket(bucket: FakeBucket): Bucket {
  return bucket as unknown as Bucket;
}
