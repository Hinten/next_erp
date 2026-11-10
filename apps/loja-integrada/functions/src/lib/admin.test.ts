/**
 * The default bucket's name ladder (`admin.ts`, `nomeDoBucketPadraoLi`): the runtime's
 * `FIREBASE_CONFIG.storageBucket` first, then the admin app's own option, else `null` — never a
 * name derived from the project id, never an override variable. Pure, so offline: no app is built.
 */
import { describe, expect, it } from 'vitest';

import { nomeDoBucketPadraoLi } from './admin';

const CONFIG = JSON.stringify({
  projectId: 'demo-erp',
  storageBucket: 'demo-erp.firebasestorage.app',
});

describe('nomeDoBucketPadraoLi — the ladder', () => {
  it('tier 1: FIREBASE_CONFIG.storageBucket answers, whatever the app option says', () => {
    expect(nomeDoBucketPadraoLi(CONFIG, undefined)).toBe('demo-erp.firebasestorage.app');
    expect(nomeDoBucketPadraoLi(CONFIG, 'outro.appspot.com')).toBe('demo-erp.firebasestorage.app');
  });

  it('tier 2: the admin app’s own option, when the config names no bucket', () => {
    expect(nomeDoBucketPadraoLi(undefined, 'app.firebasestorage.app')).toBe(
      'app.firebasestorage.app',
    );
    expect(nomeDoBucketPadraoLi(JSON.stringify({ projectId: 'demo-erp' }), 'b')).toBe('b');
  });

  it('⚠️ nothing names one ⇒ null — never `<projectId>.appspot.com` derived from the project id', () => {
    // The config carries the project id: a deriving resolver would answer from it.
    expect(nomeDoBucketPadraoLi(JSON.stringify({ projectId: 'demo-erp' }), undefined)).toBeNull();
    expect(nomeDoBucketPadraoLi(undefined, undefined)).toBeNull();
  });

  it.each([
    ['blank', ''],
    ['spaces', '   '],
    ['not JSON', '{storageBucket:'],
    ['a JSON string', '"demo-erp.firebasestorage.app"'],
    ['a JSON array', '["demo-erp.firebasestorage.app"]'],
    ['null', 'null'],
    ['an empty bucket', JSON.stringify({ storageBucket: '' })],
    ['a blank bucket', JSON.stringify({ storageBucket: '  ' })],
    ['a bucket that is not text', JSON.stringify({ storageBucket: 7 })],
  ])('a FIREBASE_CONFIG that is %s reads as absent: the next tier answers', (_nome, config) => {
    expect(nomeDoBucketPadraoLi(config, 'app-bucket')).toBe('app-bucket');
    expect(nomeDoBucketPadraoLi(config, undefined)).toBeNull();
  });

  it.each([
    ['blank', ''],
    ['spaces', ' '],
    ['a number', 7],
    ['null', null],
  ])('an app option that is %s is no name', (_nome, opcao) => {
    expect(nomeDoBucketPadraoLi(undefined, opcao)).toBeNull();
  });
});
