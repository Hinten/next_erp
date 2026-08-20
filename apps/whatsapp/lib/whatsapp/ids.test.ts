import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_CANAL,
  contaPath,
  conversaDocId,
  externalId,
  fromNumberFromSenderId,
  generateUid,
  mensagemDocId,
  senderId,
  sha256Hex,
} from './ids';

/**
 * GOLDEN VECTORS — hand-computed, byte-for-byte fixed. These lock the WhatsApp
 * identity formulas to the legacy Flutter output so a new inbound event derives
 * the same doc id as the migrated conversa it belongs to. Each 64-char hex is
 * the lowercase SHA-256 of the documented UTF-8 input string. Recompute with:
 *   node -e 'console.log(require("crypto").createHash("sha256").update(S,"utf8").digest("hex"))'
 * A change to any of these is a WIRE BREAK, not a test to "fix".
 */

// sha256("hello")
const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
// sha256("whatsapp-5511999998888")  (externalId / generateUid of a wa_id)
const EXT_WA = '3b36c01268f281f3be4853f79792ab895b6a3f57065388ecf0a16b357d0a310e';
// sha256("documents/integracao/conta_abc123-5511888887777_5511999998888")
const CONVERSA = '6d5a88d5cb966cfc6d571f0602c2f5adbb4605b056c42c10f8a1ba20b16c9cb2';
// sha256("documents/integracao/conta_abc123-wamid.HBgNNTUxMQ==")
const MENSAGEM = 'c0ff6b2ce345c8140170fe9a137557b3e59f1dee269f27d9beadcab090344ae0';

describe('sha256Hex', () => {
  it('is the lowercase hex SHA-256 of the UTF-8 bytes', () => {
    expect(sha256Hex('hello')).toBe(HELLO);
    expect(sha256Hex('hello')).toHaveLength(64);
  });

  it('handles non-ASCII (UTF-8) input identically to node crypto', () => {
    const s = 'Anônimo-☎';
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});

describe('generateUid / externalId', () => {
  it('generateUid(canal, id) = sha256("<canal>-<id>")', () => {
    expect(generateUid('whatsapp', '5511999998888')).toBe(EXT_WA);
    expect(generateUid('a', 'b')).toBe(sha256Hex('a-b'));
  });

  it('externalId is byte-identical to generateUid (legacy generateExternalId)', () => {
    expect(externalId('whatsapp', '5511999998888')).toBe(EXT_WA);
    expect(externalId('x', 'y')).toBe(generateUid('x', 'y'));
  });

  it('exposes the whatsapp canal key', () => {
    expect(WHATSAPP_CANAL).toBe('whatsapp');
    expect(externalId(WHATSAPP_CANAL, '5511999998888')).toBe(EXT_WA);
  });
});

describe('contaPath', () => {
  it('is documents/integracao/<contaId>', () => {
    expect(contaPath('conta_abc123')).toBe('documents/integracao/conta_abc123');
  });
});

describe('senderId / fromNumberFromSenderId', () => {
  it('senderId joins displayPhone and from with an underscore', () => {
    expect(senderId('5511888887777', '5511999998888')).toBe('5511888887777_5511999998888');
  });

  it('fromNumberFromSenderId returns everything after the first underscore', () => {
    expect(fromNumberFromSenderId('5511888887777_5511999998888')).toBe('5511999998888');
  });

  it('round-trips a from that itself contains an underscore', () => {
    const s = senderId('disp', 'weird_from_value');
    expect(s).toBe('disp_weird_from_value');
    expect(fromNumberFromSenderId(s)).toBe('weird_from_value');
  });
});

describe('conversaDocId / mensagemDocId', () => {
  it('conversaDocId = generateUid(contaPath, senderId)', () => {
    const sender = senderId('5511888887777', '5511999998888');
    expect(conversaDocId('conta_abc123', sender)).toBe(CONVERSA);
    expect(conversaDocId('conta_abc123', sender)).toBe(
      generateUid(contaPath('conta_abc123'), sender),
    );
  });

  it('mensagemDocId = generateUid(contaPath, wamid) — deterministic on the wamid', () => {
    expect(mensagemDocId('conta_abc123', 'wamid.HBgNNTUxMQ==')).toBe(MENSAGEM);
    expect(mensagemDocId('conta_abc123', 'wamid.HBgNNTUxMQ==')).toBe(
      mensagemDocId('conta_abc123', 'wamid.HBgNNTUxMQ=='),
    );
  });
});
