import {
  ARQUIVOS_COLLECTION,
  PRODUTO_SUBDIR,
  STORAGE_ROOT,
  chatArquivoId,
} from '@delfrance/schemas';

/**
 * A hand-written write guard for ONE collection — the escape hatch for an
 * invariant the schema-derived `v_*` validators cannot express because it ties
 * a document's fields to its own id (or to another document).
 *
 * Emission (see `emitRules`): `functions` lands beside the `v_*` validators, and
 * `create` / `update` are ANDed onto that collection's allow rules OUTSIDE the
 * `isSuperUser()` bypass, exactly like a field validator — a super user writes
 * without the permission bit, never past the guard. Each expression may use
 * `docId` (the generated document wildcard), `request`, `resource` and
 * `database`.
 */
export interface WriteGuard {
  /** Complete rules function declarations, one line per entry (unindented). */
  functions: ReadonlyArray<string>;
  /** Extra condition on `allow create`. */
  create: string;
  /** Extra condition on `allow update`. */
  update: string;
}

/**
 * A content-addressed name: the lowercase-hex sha512 digest `sha512Hex`
 * (`@delfrance/storage`) produces — 64 bytes, 128 hex characters — optionally
 * followed by the lowercase alphanumeric extension `withExt` appends.
 */
const HASH_HEX_LENGTH = 128;
const CONTENT_ADDRESSED_FILENAME = `^[0-9a-f]{${HASH_HEX_LENGTH}}([.][a-z0-9]{1,16})?$`;

const OWNED_PRODUTO_KINDS = [
  PRODUTO_SUBDIR.originals,
  PRODUTO_SUBDIR.videos,
  PRODUTO_SUBDIR.anexos,
] as const;

const q = (s: string): string => `'${s}'`;
/** `chat_` — the prefix `chatArquivoId` puts before the hash. */
const CHAT_ID_PREFIX = chatArquivoId('');
const arquivoDoc = (idExpr: string): string =>
  `/databases/$(database)/documents/${ARQUIVOS_COLLECTION}/$(${idExpr})`;

/**
 * `arquivos`: a client-written doc's storage location is BOUND TO ITS ID.
 *
 * ⚠️ Why this exists: `onArquivoDeleted` (Admin, `apps/functions`) deletes
 * whatever object the deleted doc names — and cascades to an original's three
 * derivatives. Permission-only rules let anyone with the arquivo write bit
 * create a doc naming ANY object (another produto's photo, `whatsapp/` media)
 * and then delete it, so the server deletes the object for them. Storage rules
 * cannot stop that: the delete is an Admin call. The only place to stop it is
 * here, at the doc that drives it.
 *
 * The id → location map is `storagePaths.ts`:
 *   `<ownerId>_<hash>` → `produtos/<ownerId>/{originals,videos,anexos}`
 *                        or `tabMedi/<ownerId>/originals`
 *   `chat_<hash>`      → `chat`
 *   `<hash>`           → `media`, or `chat` (pre-namespace composer uploads)
 * with `filename` = `<hash>[.<ext>]` throughout. Derivative ids
 * (`<ownerId>_<hash>_<variant>`) match none of these: only the resize function
 * (Admin) writes them.
 *
 * Every object therefore has ONE possible owning id — except `chat/<hash>…`,
 * which both `<hash>` and `chat_<hash>` may name. `arquivoChatFree` closes that:
 * a chat doc can only be created while its sibling id does not ALSO name `chat`,
 * so one doc can never be created to delete the object the other owns. ⚠️ It
 * reads the sibling AFTER the write (`existsAfter`/`getAfter`): with plain
 * `exists`/`get`, one batch creating `<hash>` and `chat_<hash>` together passes
 * both checks against the pre-write state (Codex review on #2238). And it
 * has to read the sibling's `filepath`, not just test that it exists: a bare
 * `<hash>` under `media/` (a generic upload of the same bytes) owns a DIFFERENT
 * object, and `uploadChatFile` falls through to `chat_<hash>` precisely then.
 *
 * UPDATE never touches `filepath`/`filename` — not even to add them to an
 * imported legacy doc that lacks them. Every other field stays writable, so the
 * client's own heals on legacy-shaped docs (`url`, `resizeState`) still land.
 */
export const ARQUIVO_PATH_GUARD: WriteGuard = {
  functions: [
    '// arquivos: a client-created doc may only name the storage object its id implies.',
    '// d = incoming document. See packages/rules-gen/src/writeGuards.ts.',
    'function arquivoPathOk(id, d) {',
    "  let fp = d.get('filepath', null);",
    "  let fn = d.get('filename', null);",
    `  return fp is string && fn is string && fn.matches('${CONTENT_ADDRESSED_FILENAME}')`,
    "    && arquivoIdOwnsPath(id, fp, fn.split('[.]')[0]);",
    '}',
    '',
    'function arquivoIdOwnsPath(id, fp, h) {',
    "  let parts = fp.split('/');",
    `  return (fp == ${q(STORAGE_ROOT.media)} && id == h)`,
    `    || (fp == ${q(STORAGE_ROOT.chat)} && id == ${q(CHAT_ID_PREFIX)} + h && arquivoChatFree(h))`,
    `    || (fp == ${q(STORAGE_ROOT.chat)} && id == h && arquivoChatFree(${q(CHAT_ID_PREFIX)} + h))`,
    "    || (parts.size() == 3 && parts[1].size() > 0 && id == parts[1] + '_' + h",
    `      && ((parts[0] == ${q(STORAGE_ROOT.produtos)} && parts[2] in [${OWNED_PRODUTO_KINDS.map(q).join(', ')}])`,
    `        || (parts[0] == ${q(STORAGE_ROOT.tabMedi)} && parts[2] == ${q(PRODUTO_SUBDIR.originals)})));`,
    '}',
    '',
    '// True unless the sibling id names the shared chat/ object once this write',
    '// lands — post-write state, so one batch cannot create both chat anchors.',
    'function arquivoChatFree(siblingId) {',
    `  return !existsAfter(${arquivoDoc('siblingId')})`,
    `    || getAfter(${arquivoDoc('siblingId')}).data.get('filepath', null) != ${q(STORAGE_ROOT.chat)};`,
    '}',
  ],
  create: 'arquivoPathOk(docId, request.resource.data)',
  update:
    "!request.resource.data.diff(resource.data).affectedKeys().hasAny(['filename', 'filepath'])",
};
