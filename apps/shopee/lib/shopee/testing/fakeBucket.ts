/**
 * A fake Cloud Storage bucket, **for tests only** — the double the Shopee photo
 * import (#1517, step 9) drives `putArquivoAdmin` against.
 *
 * ⚠️ Nothing under `lib/shopee/**` outside a `*.test.ts` may import this module,
 * and nothing does — the `fakeDb.ts` / `fixtures/piiScan.ts` precedent. It ships
 * in the app tree rather than beside one suite because the importer, the job and
 * the CLI suites all need it, and a second copy is exactly the shape the root
 * `CLAUDE.md` names: two files that read as agreeing while drifting toward
 * plausible.
 *
 * It exists so a photo suite runs through the **real**
 * `@delfrance/storage/admin` uploader rather than a mock of it — the property
 * under test is what the importer hands the uploader (the object PATH, the
 * content type, the download token and the `arquivoId` metadata the deployed
 * `onObjectFinalized` / `resizeProductImage` triggers read), and a mocked
 * uploader cannot show that.
 *
 * ## The surface, and why it is exactly this
 *
 * `putArquivoAdmin` (`packages/storage/src/admin/upload.ts`) touches precisely
 * two things on a bucket:
 *
 *  - `bucket.name`, which it interpolates into the tokened download URL
 *    (`firebaseDownloadUrl`), so the name has to be a plausible bucket name
 *    rather than a marker — a test asserting the stored `url` reads it back;
 *  - `bucket.file(path).save(bytes, { contentType, metadata })`, the upload.
 *
 * ⚠️ {@link FakeBucket.saved} keeps the BYTES as well as the path, because the
 * import is content-addressed: the arquivo doc id and the object name are both
 * `sha512(bytes)`, so a suite has to be able to prove that what was hashed is
 * what was uploaded. Recording only the path would let a swapped-bytes mutant
 * pass.
 *
 * ⚠️ `save` never throws on its own. A Storage failure is INFRA — the importer
 * must let it propagate and fail the item, rather than counting it as a skipped
 * picture — so a suite that wants one injects it with
 * {@link FakeBucket.falhaAoSalvar}, keyed by the object path, and the absence of
 * a default failure is what keeps the happy path honest.
 */

import type { Bucket } from '@delfrance/storage/admin';

/** One recorded upload. */
export interface SalvoNoFakeBucket {
  readonly path: string;
  readonly bytes: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Record<string, unknown> | undefined;
}

interface OpcoesDeSave {
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export class FakeBucket {
  /**
   * A plausible bucket name, in the post-2024 default spelling — the one the
   * derived `<projectId>.appspot.com` gets WRONG on a project created after late
   * 2024, so a test reading a stored `url` sees the shape that actually ships.
   */
  readonly name: string;
  readonly saved: SalvoNoFakeBucket[] = [];
  /** Injected upload failures, keyed by the FULL object path. */
  readonly falhaAoSalvar = new Map<string, Error>();

  constructor(name = 'demo-erp.firebasestorage.app') {
    this.name = name;
  }

  /** The object paths uploaded, in order — the common assertion, spelled once. */
  get caminhos(): string[] {
    return this.saved.map((s) => s.path);
  }

  /**
   * The Admin SDK hands back a file HANDLE, so `save` closes over the bucket
   * (an arrow function, capturing `this` lexically) rather than being a method
   * on it — the ML `importPhotos.test.ts` double has the same shape.
   */
  file(path: string) {
    return {
      name: path,
      save: (bytes: Buffer | Uint8Array, opts?: OpcoesDeSave): Promise<void> => {
        const falha = this.falhaAoSalvar.get(path);
        if (falha) return Promise.reject(falha);
        this.saved.push({
          path,
          bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
          contentType: opts?.contentType,
          metadata: opts?.metadata,
        });
        return Promise.resolve();
      },
    };
  }
}

/** The cast every suite needs exactly once — `Bucket` is the Admin SDK's own shape. */
export function asBucket(bucket: FakeBucket): Bucket {
  return bucket as unknown as Bucket;
}
