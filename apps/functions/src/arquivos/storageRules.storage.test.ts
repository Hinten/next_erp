import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { FirebaseError } from 'firebase/app';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PERM, rulesClaimsFromBits } from '@delfrance/auth';
import {
  chatArquivoId,
  chatMediaPath,
  mediaPath,
  ownedDerivativePath,
  productAnexoPath,
  productArquivoId,
  productOriginalPath,
  productVideoPath,
  tabMediArquivoId,
  tabMediOriginalPath,
  whatsappMediaPath,
} from '@delfrance/schemas';

// Behaviour suite for the hand-written root `storage.rules`. Runs only under
// `firebase emulators:exec --config firebase.functions.json` (ci-storage.yml),
// whose Storage emulator this suite reloads with the COMMITTED rules file.
//
// Every object goes to a DEDICATED bucket: the rules match `/b/{bucket}/o` for
// any bucket, but the functions emulator's `resizeProductImage` only watches the
// default one, so the fake image bytes here never reach sharp — and the shared
// default bucket other suites list stays untouched.
const EMULATED = Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const BUCKET = `gs://${projectId}-storage-rules-test`;

// src/arquivos → src → apps/functions → apps → repo root.
const RULES_PATH = fileURLToPath(new URL('../../../../storage.rules', import.meta.url));

const MiB = 1024 * 1024;

type Claims = Record<string, unknown>;
const bits = (...b: bigint[]): Claims => rulesClaimsFromBits(b.reduce((acc, x) => acc | x, 0n));

const SIGNED_OUT = null;
const SUPER_USER: Claims = { su: true }; // the `su` branch alone, no d_* claims
const ARQUIVO_ONLY = bits(PERM.arquivo.read, PERM.arquivo.write);
const PRODUTO_ONLY = bits(PERM.produto.read, PERM.produto.write);
const MENSAGEM_ONLY = bits(PERM.mensagem.read, PERM.mensagem.write);
const PRODUTO_EDITOR = bits(PERM.arquivo.read, PERM.arquivo.write, PERM.produto.write);
const CHAT_OPERATOR = bits(PERM.arquivo.read, PERM.arquivo.write, PERM.mensagem.write);
const ARQUIVO_READER = bits(PERM.arquivo.read);

/** A fresh content-addressed name: random bytes and their sha512 hex. */
function content(size = 64): { bytes: Uint8Array; hash: string } {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from(randomUUID()));
  return { bytes, hash: createHash('sha512').update(bytes).digest('hex') };
}

describe.skipIf(!EMULATED)('storage.rules (emulator)', () => {
  let env: RulesTestEnvironment;
  const written = new Set<string>();

  function storageAs(claims: Claims | null) {
    return claims === null
      ? env.unauthenticatedContext().storage(BUCKET)
      : env.authenticatedContext(`u-${randomUUID()}`, claims).storage(BUCKET);
  }

  async function put(
    claims: Claims | null,
    path: string,
    bytes: Uint8Array,
    contentType: string,
    customMetadata: Record<string, string>,
  ) {
    written.add(path);
    return await storageAs(claims).ref(path).put(bytes, { contentType, customMetadata });
  }

  /** Seed an object with rules off — the Admin SDK's view of the bucket. */
  async function seed(path: string, contentType = 'image/jpeg') {
    written.add(path);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.storage(BUCKET).ref(path).put(content().bytes, { contentType });
    });
  }

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId,
      storage: { rules: readFileSync(RULES_PATH, 'utf8') },
    });
  });

  afterAll(async () => {
    if (!env) return;
    // The emulator is shared across suites: remove exactly what this one wrote.
    await env.withSecurityRulesDisabled(async (ctx) => {
      for (const path of written) {
        try {
          await ctx.storage(BUCKET).ref(path).delete();
        } catch (err) {
          // A refused upload never created its object — nothing to remove.
          if (err instanceof FirebaseError && err.code === 'storage/object-not-found') continue;
          throw err;
        }
      }
    });
    await env.cleanup();
  });

  describe('produtos/<id>/originals — who may upload', () => {
    const produtoId = `p-${randomUUID()}`;
    const upload = (claims: Claims | null) => {
      const { bytes, hash } = content();
      return put(claims, productOriginalPath(produtoId, hash, 'jpeg'), bytes, 'image/jpeg', {
        arquivoId: productArquivoId(produtoId, hash),
      });
    };

    it('allows d_arquivo write + d_produto write', () => assertSucceeds(upload(PRODUTO_EDITOR)));
    it('allows the su claim alone', () => assertSucceeds(upload(SUPER_USER)));
    it('refuses d_arquivo alone', () => assertFails(upload(ARQUIVO_ONLY)));
    it('refuses d_produto alone', () => assertFails(upload(PRODUTO_ONLY)));
    it('refuses d_mensagem write as the owner domain', () =>
      assertFails(upload(bits(PERM.arquivo.write, PERM.mensagem.write))));
    it('refuses a signed-out client', () => assertFails(upload(SIGNED_OUT)));
  });

  describe('produtos/<id>/originals — what may be uploaded', () => {
    const produtoId = `p-${randomUUID()}`;

    it('refuses an arquivoId naming another produto', () => {
      const { bytes, hash } = content();
      return assertFails(
        put(PRODUTO_EDITOR, productOriginalPath(produtoId, hash, 'jpeg'), bytes, 'image/jpeg', {
          arquivoId: productArquivoId('outro-produto', hash),
        }),
      );
    });

    it('refuses an arquivoId naming another hash', () => {
      const { bytes, hash } = content();
      return assertFails(
        put(PRODUTO_EDITOR, productOriginalPath(produtoId, hash, 'jpeg'), bytes, 'image/jpeg', {
          arquivoId: productArquivoId(produtoId, content().hash),
        }),
      );
    });

    it('refuses an upload with no arquivoId', () => {
      const { bytes, hash } = content();
      return assertFails(
        put(PRODUTO_EDITOR, productOriginalPath(produtoId, hash, 'jpeg'), bytes, 'image/jpeg', {}),
      );
    });

    it('refuses the server-only `resized` / `originalPath` keys', async () => {
      const extras: Record<string, string>[] = [{ resized: 'true' }, { originalPath: 'x' }];
      for (const extra of extras) {
        const { bytes, hash } = content();
        await assertFails(
          put(PRODUTO_EDITOR, productOriginalPath(produtoId, hash, 'jpeg'), bytes, 'image/jpeg', {
            arquivoId: productArquivoId(produtoId, hash),
            ...extra,
          }),
        );
      }
    });

    it('refuses SVG but accepts every raster type the picker offers', async () => {
      const svg = content();
      await assertFails(
        put(
          PRODUTO_EDITOR,
          productOriginalPath(produtoId, svg.hash, 'svg'),
          svg.bytes,
          'image/svg+xml',
          {
            arquivoId: productArquivoId(produtoId, svg.hash),
          },
        ),
      );
      for (const [type, ext] of [
        ['image/png', 'png'],
        ['image/webp', 'webp'],
        ['image/gif', 'gif'],
        ['image/avif', 'avif'],
        ['image/heic', 'heic'],
        ['image/heif', 'heif'],
      ] as const) {
        const { bytes, hash } = content();
        await assertSucceeds(
          put(PRODUTO_EDITOR, productOriginalPath(produtoId, hash, ext), bytes, type, {
            arquivoId: productArquivoId(produtoId, hash),
          }),
        );
      }
    });

    it('refuses a name that is not a sha512 hex', () => {
      const { bytes } = content();
      return assertFails(
        put(PRODUTO_EDITOR, `produtos/${produtoId}/originals/foto.jpeg`, bytes, 'image/jpeg', {
          arquivoId: `${produtoId}_foto`,
        }),
      );
    });

    it('accepts exactly 20 MiB and refuses one byte more', async () => {
      const atCap = content(20 * MiB);
      await assertSucceeds(
        put(
          PRODUTO_EDITOR,
          productOriginalPath(produtoId, atCap.hash, 'jpeg'),
          atCap.bytes,
          'image/jpeg',
          {
            arquivoId: productArquivoId(produtoId, atCap.hash),
          },
        ),
      );
      const over = content(20 * MiB + 1);
      await assertFails(
        put(
          PRODUTO_EDITOR,
          productOriginalPath(produtoId, over.hash, 'jpeg'),
          over.bytes,
          'image/jpeg',
          {
            arquivoId: productArquivoId(produtoId, over.hash),
          },
        ),
      );
    });

    it('allows re-uploading over an existing object (the dedup heal path)', async () => {
      const { bytes, hash } = content();
      const path = productOriginalPath(produtoId, hash, 'jpeg');
      const meta = { arquivoId: productArquivoId(produtoId, hash) };
      await assertSucceeds(put(PRODUTO_EDITOR, path, bytes, 'image/jpeg', meta));
      await assertSucceeds(put(PRODUTO_EDITOR, path, bytes, 'image/jpeg', meta));
    });

    it('lets a d_arquivo reader get metadata, and nobody delete or list', async () => {
      const { hash } = content();
      const path = productOriginalPath(produtoId, hash, 'jpeg');
      await seed(path);
      await assertSucceeds(storageAs(ARQUIVO_READER).ref(path).getMetadata());
      await assertFails(storageAs(PRODUTO_ONLY).ref(path).getMetadata());
      await assertFails(storageAs(SIGNED_OUT).ref(path).getMetadata());
      await assertFails(storageAs(SUPER_USER).ref(path).delete());
      await assertFails(storageAs(SUPER_USER).ref(`produtos/${produtoId}/originals`).listAll());
    });
  });

  describe('the other client paths', () => {
    const produtoId = `p-${randomUUID()}`;
    const tabMediId = `t-${randomUUID()}`;

    it('videos: video/* up to 32 MiB, never an image', async () => {
      const ok = content();
      await assertSucceeds(
        put(PRODUTO_EDITOR, productVideoPath(produtoId, ok.hash, 'mp4'), ok.bytes, 'video/mp4', {
          arquivoId: productArquivoId(produtoId, ok.hash),
        }),
      );
      const img = content();
      await assertFails(
        put(
          PRODUTO_EDITOR,
          productVideoPath(produtoId, img.hash, 'jpeg'),
          img.bytes,
          'image/jpeg',
          {
            arquivoId: productArquivoId(produtoId, img.hash),
          },
        ),
      );
    });

    it('anexos: any type, with or without an extension', async () => {
      const pdf = content();
      await assertSucceeds(
        put(
          PRODUTO_EDITOR,
          productAnexoPath(produtoId, pdf.hash, 'pdf'),
          pdf.bytes,
          'application/pdf',
          {
            arquivoId: productArquivoId(produtoId, pdf.hash),
          },
        ),
      );
      const bare = content();
      await assertSucceeds(
        put(
          PRODUTO_EDITOR,
          productAnexoPath(produtoId, bare.hash, null),
          bare.bytes,
          'application/octet-stream',
          {
            arquivoId: productArquivoId(produtoId, bare.hash),
          },
        ),
      );
    });

    it('tabMedi originals: the produto editor, with the tabMedi-scoped id', async () => {
      const ok = content();
      await assertSucceeds(
        put(
          PRODUTO_EDITOR,
          tabMediOriginalPath(tabMediId, ok.hash, 'jpeg'),
          ok.bytes,
          'image/jpeg',
          {
            arquivoId: tabMediArquivoId(tabMediId, ok.hash),
          },
        ),
      );
      const chatUser = content();
      await assertFails(
        put(
          CHAT_OPERATOR,
          tabMediOriginalPath(tabMediId, chatUser.hash, 'jpeg'),
          chatUser.bytes,
          'image/jpeg',
          {
            arquivoId: tabMediArquivoId(tabMediId, chatUser.hash),
          },
        ),
      );
    });

    it('chat: d_arquivo + d_mensagem, under the chat_ id or the legacy bare hash', async () => {
      const current = content();
      await assertSucceeds(
        put(CHAT_OPERATOR, chatMediaPath(current.hash, 'pdf'), current.bytes, 'application/pdf', {
          arquivoId: chatArquivoId(current.hash),
        }),
      );
      const legacy = content();
      await assertSucceeds(
        put(CHAT_OPERATOR, chatMediaPath(legacy.hash, 'pdf'), legacy.bytes, 'application/pdf', {
          arquivoId: legacy.hash,
        }),
      );
      const foreign = content();
      await assertFails(
        put(CHAT_OPERATOR, chatMediaPath(foreign.hash, 'pdf'), foreign.bytes, 'application/pdf', {
          arquivoId: `chat_${content().hash}`,
        }),
      );
      const produtoOnly = content();
      await assertFails(
        put(
          PRODUTO_EDITOR,
          chatMediaPath(produtoOnly.hash, 'pdf'),
          produtoOnly.bytes,
          'application/pdf',
          {
            arquivoId: chatArquivoId(produtoOnly.hash),
          },
        ),
      );
      const mensagemOnly = content();
      await assertFails(
        put(
          MENSAGEM_ONLY,
          chatMediaPath(mensagemOnly.hash, 'pdf'),
          mensagemOnly.bytes,
          'application/pdf',
          {
            arquivoId: chatArquivoId(mensagemOnly.hash),
          },
        ),
      );
    });

    it('media: d_arquivo write, bare-hash id', async () => {
      const ok = content();
      await assertSucceeds(
        put(ARQUIVO_ONLY, mediaPath(ok.hash, 'png'), ok.bytes, 'image/png', { arquivoId: ok.hash }),
      );
      const reader = content();
      await assertFails(
        put(ARQUIVO_READER, mediaPath(reader.hash, 'png'), reader.bytes, 'image/png', {
          arquivoId: reader.hash,
        }),
      );
    });
  });

  describe('server-only paths', () => {
    it('refuses every client write, even a super user, but lets a reader get', async () => {
      const produtoId = `p-${randomUUID()}`;
      const { bytes, hash } = content();
      const paths = [
        ownedDerivativePath('produtos', produtoId, hash, '200'),
        ownedDerivativePath('tabMedi', `t-${randomUUID()}`, hash, 'jpeg'),
        whatsappMediaPath(`conta-${randomUUID()}`, `wamid-${randomUUID()}`),
        `mercado-livre/conta-${randomUUID()}/packs/1/anexo.pdf`,
      ];
      for (const path of paths) {
        await assertFails(put(SUPER_USER, path, bytes, 'image/jpeg', { arquivoId: 'x' }));
        await seed(path);
        await assertSucceeds(storageAs(ARQUIVO_READER).ref(path).getMetadata());
      }
    });

    it('denies a root no rule names', () => {
      const { bytes } = content();
      return assertFails(put(SUPER_USER, `outro/${randomUUID()}`, bytes, 'image/jpeg', {}));
    });
  });
});
