import { describe, expect, it } from 'vitest';

import {
  contaPathLegacyMl,
  dartUtcDateTimeToString,
  generateUid,
  makeAttachmentMensagemId,
  makeClaimMessageId,
  makeConversaIdClaim,
  makeIncidenteIdClaim,
  usuarioExternalIdMl,
} from './claimIds';

// Golden vectors — hand-derived from the legacy preimage formulas and
// re-verified with `node -e` sha256 runs before pinning. A change to ANY of
// these digests forks the doc history the Flutter app wrote for years.
const CONTA_ID = 'conta_abc123';
const RESOURCE_ID = 2000004048276990;
const CLAIM_ID = 5142940410;

describe('contaPathLegacyMl', () => {
  it('is the legacy Flutter DocumentId.path — LEADING slash included', () => {
    expect(contaPathLegacyMl(CONTA_ID)).toBe('/documents/integracao/conta_abc123');
  });
});

describe('generateUid', () => {
  it('is sha256 over "key-id" (global/utils.dart:75-79)', () => {
    // sha256('a-b') — independently verified.
    expect(generateUid('a', 'b')).toBe(
      'd44362d67d921091c7b9674d752e9e23c1f9ec8a4f0b82741bf01364eb97c830',
    );
  });
});

describe('makeIncidenteIdClaim', () => {
  it('digests "/documents/integracao/{conta}-{resourceId}({claimId})"', () => {
    expect(makeIncidenteIdClaim(CONTA_ID, RESOURCE_ID, CLAIM_ID)).toBe(
      '475a7050c4842fad50396bc05e2a57964f528239f7bf7b8e7459d358b4ae64f5',
    );
  });
});

describe('makeConversaIdClaim', () => {
  it('digests "/documents/integracao/{conta}-claims{resourceId}{claimId}"', () => {
    expect(makeConversaIdClaim(CONTA_ID, RESOURCE_ID, CLAIM_ID)).toBe(
      'a0d34b489647f24eb081a127118cb95630278f32a2ce227d21944b071c8e1568',
    );
  });
});

describe('makeClaimMessageId', () => {
  it('reproduces the Dart enum-toString preimage (_RolePlayes./_StageClaims. tokens + Dart DateTime.toString)', () => {
    expect(
      makeClaimMessageId(CONTA_ID, {
        sender_role: 'complainant',
        receiver_role: 'respondent',
        stage: 'claim',
        date_created: '2022-08-23T20:30:52.000-04:00',
        message: 'Hola',
      }),
    ).toBe('0e9a6bfb5aa9847ab6d5b8e6b606d57b69a9f107a52328071e31eb3e542e2e85');
  });

  it('null vocabulary interpolates as an empty raw value (deterministic; legacy crashed here)', () => {
    const a = makeClaimMessageId(CONTA_ID, {
      sender_role: null,
      receiver_role: 'respondent',
      stage: 'claim',
      date_created: '2022-08-23T20:30:52.000-04:00',
      message: 'Hola',
    });
    // '_RolePlayes.' + '' — the token itself stays in the preimage.
    expect(a).toBe(
      generateUid(
        contaPathLegacyMl(CONTA_ID),
        '_RolePlayes._RolePlayes.respondent_StageClaims.claim2022-08-24 00:30:52.000ZHola',
      ),
    );
  });
});

describe('makeAttachmentMensagemId', () => {
  it('digests "/documents/integracao/{conta}-{filename}"', () => {
    expect(
      makeAttachmentMensagemId(CONTA_ID, 'fa8d559e-b6c9-4a9d-9824-aba4607bd869_301110805.jpg'),
    ).toBe('8c859556c03408877834c445359a90f8f0995b70b8414c0f2a6211e8bbce5919');
  });
});

describe('usuarioExternalIdMl', () => {
  it('digests "/documents/integracao/{conta}-{mlUserId}"', () => {
    expect(usuarioExternalIdMl(CONTA_ID, 301110805)).toBe(
      '92ba54c7fac91eaa2221b4f07a155f846bf42642e9e16daa4eb9964a6d501014',
    );
  });
});

describe('dartUtcDateTimeToString', () => {
  it('offset string → UTC instant, "yyyy-MM-dd HH:mm:ss.mmmZ" (day rollover included)', () => {
    expect(dartUtcDateTimeToString('2022-08-23T20:09:16.000-04:00')).toBe(
      '2022-08-24 00:09:16.000Z',
    );
  });

  it('appends the µs digits from the SOURCE string only when non-zero', () => {
    expect(dartUtcDateTimeToString('2022-08-23T20:09:16.123456-04:00')).toBe(
      '2022-08-24 00:09:16.123456Z',
    );
  });

  it('no fraction → ".000" (Dart always prints the ms block)', () => {
    expect(dartUtcDateTimeToString('2022-08-23T20:09:16-04:00')).toBe('2022-08-24 00:09:16.000Z');
  });

  it('Z suffix parses as UTC like an explicit offset', () => {
    expect(dartUtcDateTimeToString('2022-08-24T00:09:16.500Z')).toBe('2022-08-24 00:09:16.500Z');
  });

  it('defensive: no offset → same wall-clock parts, NO trailing Z (Dart local parse)', () => {
    expect(dartUtcDateTimeToString('2022-08-23T20:09:16.250')).toBe('2022-08-23 20:09:16.250');
    expect(dartUtcDateTimeToString('2022-08-23T20:09:16')).toBe('2022-08-23 20:09:16.000');
  });

  it('defensive: an unparseable string is returned verbatim (deterministic id, no crash)', () => {
    expect(dartUtcDateTimeToString('not-a-date')).toBe('not-a-date');
  });
});
