import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteField, doc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import { PERM, rulesClaimsFromBits } from '@delfrance/auth';
import {
  chatArquivoId,
  chatMediaPath,
  derivativeArquivoId,
  mediaPath,
  productAnexoPath,
  productArquivoId,
  productDerivativePath,
  productOriginalPath,
  productVideoPath,
  tabMediArquivoId,
  tabMediOriginalPath,
  whatsappArquivoId,
  whatsappMediaPath,
} from '@delfrance/schemas';
import { createTestEnv, EMULATED } from './helpers';

/**
 * `arquivos` path binding (`src/writeGuards.ts`). `onArquivoDeleted` (Admin)
 * deletes the object a deleted doc names, so a client that could create a doc
 * naming ANY object could make the server delete it. The rule binds a created
 * doc's `filepath`/`filename` to what its id implies and freezes both on
 * update.
 *
 * Every allowed case is built with the SAME `storagePaths` helpers the client
 * writers in `@delfrance/storage` (`upload.ts`, `putArquivo`) use, and writes
 * the same shapes: a full create-first anchor, then `{ url }` and the dedup
 * heal's `{ resizeState: 'pending' }`.
 */
const WRITER = rulesClaimsFromBits(PERM.arquivo.read | PERM.arquivo.write);
const SUPERUSER = rulesClaimsFromBits((1n << 128n) - 1n);
const READ_ONLY = rulesClaimsFromBits(PERM.arquivo.read);

const sha = (s: string): string => createHash('sha512').update(s).digest('hex');
const H = sha('bytes-1');
const H2 = sha('bytes-2');

/** `<dir>/<file>` → the `{ filepath, filename }` split `putArquivo` stores. */
function split(storagePath: string): { filepath: string; filename: string } {
  const slash = storagePath.lastIndexOf('/');
  return { filepath: storagePath.slice(0, slash), filename: storagePath.slice(slash + 1) };
}

/** The create-first anchor `putArquivo` writes. */
function anchor(storagePath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filetype: 'image',
    ...split(storagePath),
    originalFilename: 'foto.png',
    contentType: 'image/png',
    url: null,
    externalIds: [],
    criadoEm: 1_700_000_000_000_000,
    resizeState: null,
    uploadState: 'pending',
    markedForDeletionAt: null,
    ...extra,
  };
}

describe.skipIf(!EMULATED)('arquivos: storage path bound to the doc id', () => {
  let env: RulesTestEnvironment;

  function db(claims: Record<string, unknown> = WRITER): Firestore {
    const uid = `u${Math.random().toString(36).slice(2)}`;
    return env.authenticatedContext(uid, claims).firestore() as unknown as Firestore;
  }

  async function seed(id: string, data: Record<string, unknown>): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore() as unknown as Firestore, `arquivos/${id}`), data);
    });
  }

  const create = (id: string, data: Record<string, unknown>, claims?: Record<string, unknown>) =>
    setDoc(doc(db(claims), `arquivos/${id}`), data);

  beforeAll(async () => {
    env = await createTestEnv();
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  describe('create — every client writer still passes', () => {
    it('uploadProductImage / uploadProductVideo / uploadProductAnexo (with and without ext)', async () => {
      await assertSucceeds(
        create(
          productArquivoId('P1', H),
          anchor(productOriginalPath('P1', H, 'png'), { resizeState: 'pending' }),
        ),
      );
      await assertSucceeds(
        create(productArquivoId('P2', H), anchor(productVideoPath('P2', H, 'mp4'))),
      );
      await assertSucceeds(
        create(productArquivoId('P3', H), anchor(productAnexoPath('P3', H, 'pdf'))),
      );
      await assertSucceeds(
        create(productArquivoId('P4', H), anchor(productAnexoPath('P4', H, null))),
      );
    });

    it('accepts an owner id that itself contains an underscore', async () => {
      await assertSucceeds(
        create(productArquivoId('legacy_P', H), anchor(productOriginalPath('legacy_P', H, 'jpeg'))),
      );
    });

    it('uploadTabMediImage', async () => {
      await assertSucceeds(
        create(
          tabMediArquivoId('T1', H),
          anchor(tabMediOriginalPath('T1', H, 'png'), { resizeState: 'pending' }),
        ),
      );
    });

    it('uploadChatFile (chat_<hash>) and its pre-namespace legacy id (<hash>)', async () => {
      await assertSucceeds(create(chatArquivoId(H), anchor(chatMediaPath(H, 'png'))));
      await assertSucceeds(create(H2, anchor(chatMediaPath(H2, 'pdf'))));
    });

    it('uploadFile / uploadFromUrl (bare <hash> under media/)', async () => {
      await assertSucceeds(create(H, anchor(mediaPath(H, 'png'))));
      await assertSucceeds(create(H2, anchor(mediaPath(H2, null))));
    });

    it('the full create-first flow: anchor, then the url patch', async () => {
      const id = productArquivoId('P1', H);
      await assertSucceeds(create(id, anchor(productOriginalPath('P1', H, 'png'))));
      await assertSucceeds(updateDoc(doc(db(), `arquivos/${id}`), { url: 'https://x/y' }));
    });
  });

  describe('create — a doc naming an object its id does not imply is denied', () => {
    it("the attack: another produto's photo, under an id the attacker owns", async () => {
      await assertFails(
        create(productArquivoId('ATTACKER', H), anchor(productOriginalPath('VICTIM', H, 'png'))),
      );
      // …and with the victim's hash under a different one of the attacker's hashes.
      await assertFails(
        create(productArquivoId('VICTIM', H2), anchor(productOriginalPath('VICTIM', H, 'png'))),
      );
    });

    it('is denied for a super user too (the guard sits outside the su bypass)', async () => {
      await assertFails(
        create(
          productArquivoId('ATTACKER', H),
          anchor(productOriginalPath('VICTIM', H, 'png')),
          SUPERUSER,
        ),
      );
    });

    it('never names a server-owned prefix: derivatives, whatsapp/', async () => {
      await assertFails(
        create(productArquivoId('P1', H), anchor(productDerivativePath('P1', H, '200'))),
      );
      await assertFails(
        create(derivativeArquivoId('P1', H, '200'), anchor(productDerivativePath('P1', H, '200'))),
      );
      await assertFails(create(whatsappArquivoId('m1'), anchor(whatsappMediaPath('conta1', 'm1'))));
      await assertFails(create(H, { ...anchor(mediaPath(H, 'png')), filepath: 'whatsapp/conta1' }));
    });

    it('rejects a mismatched root for the id shape', async () => {
      await assertFails(create(H, anchor(productOriginalPath('P1', H, 'png')))); // bare id, owned path
      await assertFails(create(productArquivoId('P1', H), anchor(mediaPath(H, 'png')))); // owned id, media
      await assertFails(create(chatArquivoId(H), anchor(mediaPath(H, 'png')))); // chat id, media
      await assertFails(create(tabMediArquivoId('T1', H), anchor(`tabMedi/T1/videos/${H}.mp4`)));
      await assertFails(create(productArquivoId('P1', H), anchor(`produtos/P1/outro/${H}.png`)));
      await assertFails(create(productArquivoId('P1', H), anchor(`fotos/P1/originals/${H}.png`)));
      await assertFails(
        create(productArquivoId('P1', H), anchor(`produtos/P1/originals/x/${H}.png`)),
      );
      await assertFails(create(`_${H}`, anchor(`produtos//originals/${H}.png`)));
    });

    it('rejects a filename that is not the id hash, content-addressed', async () => {
      const path = (file: string) => ({ filepath: 'produtos/P1/originals', filename: file });
      const id = productArquivoId('P1', H);
      await assertFails(create(id, { ...anchor(mediaPath(H)), ...path(`${H2}.png`) }));
      await assertFails(create(id, { ...anchor(mediaPath(H)), ...path('foto.png') }));
      await assertFails(create(id, { ...anchor(mediaPath(H)), ...path(`${H.toUpperCase()}.png`) }));
      await assertFails(create(id, { ...anchor(mediaPath(H)), ...path(`${H}.png/../../x`) }));
      await assertFails(create(id, { ...anchor(mediaPath(H)), ...path(`${H}_200.jpeg`) }));
      await assertFails(create(id, { ...anchor(mediaPath(H)), ...path(`${H.slice(0, 127)}.png`) }));
    });

    it('rejects a missing, null or non-string filepath/filename', async () => {
      const id = productArquivoId('P1', H);
      const ok = anchor(productOriginalPath('P1', H, 'png'));
      const { filepath: _fp, ...noPath } = ok;
      const { filename: _fn, ...noName } = ok;
      await assertFails(create(id, noPath));
      await assertFails(create(id, noName));
      await assertFails(create(id, { ...ok, filepath: null }));
      await assertFails(create(id, { ...ok, filepath: ['produtos', 'P1', 'originals'] }));
      await assertFails(create(H, { ...anchor(mediaPath(H, 'png')), filepath: null })); // root-level object
    });

    it('a chat object can have only ONE owning doc: <hash> and chat_<hash> exclude each other', async () => {
      // chat_<hash> exists → a bare <hash> naming the same object is refused…
      await seed(chatArquivoId(H), anchor(chatMediaPath(H, 'png')));
      await assertFails(create(H, anchor(chatMediaPath(H, 'png'))));
      // …and a legacy bare <hash> exists → chat_<hash> is refused.
      await seed(H2, anchor(chatMediaPath(H2, 'png')));
      await assertFails(create(chatArquivoId(H2), anchor(chatMediaPath(H2, 'png'))));
      // Near-miss: a bare <hash> under media/ owns a DIFFERENT object, so it must
      // not block chat_<hash> — uploadChatFile falls through to it exactly then.
      const H3 = sha('bytes-3');
      await seed(H3, anchor(mediaPath(H3, 'png')));
      await assertFails(create(H3, anchor(chatMediaPath(H3, 'png')))); // H3 exists: an update, path frozen
      await assertSucceeds(create(chatArquivoId(H3), anchor(chatMediaPath(H3, 'png'))));
    });

    it('still needs the arquivo write bit', async () => {
      await assertFails(create(H, anchor(mediaPath(H, 'png')), READ_ONLY));
    });
  });

  describe('update — filepath/filename are frozen, everything else stays writable', () => {
    it('putArquivo dedup heals on an imported legacy doc (no filepath, ISO criadoEm, unmodelled keys)', async () => {
      const id = productArquivoId('P1', H);
      await seed(id, {
        filetype: 'image',
        filename: 'IMG_0001.JPG',
        criadoEm: '2021-03-04T05:06:07.000Z',
        fotoFlutter: true,
      });
      await assertSucceeds(updateDoc(doc(db(), `arquivos/${id}`), { resizeState: 'pending' }));
      await assertSucceeds(updateDoc(doc(db(), `arquivos/${id}`), { url: 'https://x/y' }));
    });

    it('heals a legacy doc whose stored path the guard would never accept on create', async () => {
      await seed('legacy-id', anchor('fotos/antigas/IMG_0001.JPG'));
      await assertSucceeds(updateDoc(doc(db(), 'arquivos/legacy-id'), { url: 'https://x/y' }));
    });

    it("uploadChatFile's legacy branch: a bare <hash> chat anchor gets its url", async () => {
      await seed(H, anchor(chatMediaPath(H, 'png')));
      await assertSucceeds(updateDoc(doc(db(), `arquivos/${H}`), { url: 'https://x/y' }));
    });

    it('denies re-pointing filepath or filename — for a super user too', async () => {
      const id = productArquivoId('P1', H);
      await seed(id, anchor(productOriginalPath('P1', H, 'png')));
      const ref = (claims?: Record<string, unknown>) => doc(db(claims), `arquivos/${id}`);
      await assertFails(updateDoc(ref(), { filepath: 'produtos/VICTIM/originals' }));
      await assertFails(updateDoc(ref(), { filename: `${H}.jpeg` }));
      await assertFails(updateDoc(ref(), { filepath: deleteField() }));
      await assertFails(updateDoc(ref(SUPERUSER), { filepath: 'produtos/VICTIM/originals' }));
      // A full overwrite carrying the SAME location is not a change.
      await assertSucceeds(
        setDoc(ref(), anchor(productOriginalPath('P1', H, 'png'), { url: 'u' })),
      );
    });

    it('denies ADDING a location to a legacy doc that never had one', async () => {
      await seed('legacy-sem-path', { filetype: 'image', filename: 'x.jpg' });
      await assertFails(
        updateDoc(doc(db(), 'arquivos/legacy-sem-path'), { filepath: 'produtos/VICTIM/originals' }),
      );
    });
  });
});
