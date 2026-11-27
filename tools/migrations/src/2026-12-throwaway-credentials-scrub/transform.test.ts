import { describe, expect, it } from 'vitest';

import { ScrubArgError, credentialDocuments, fieldsToScrub, parseScrubArgs } from './transform';

describe('parseScrubArgs', () => {
  it('requires the project id twice and is a dry-run by default', () => {
    expect(parseScrubArgs(['--project', 'teste', '--confirm-throwaway', 'teste'])).toEqual({
      projectId: 'teste',
      apply: false,
      serviceAccountPath: undefined,
    });
    expect(parseScrubArgs(['--project=teste', '--confirm-throwaway=teste', '--apply']).apply).toBe(
      true,
    );
  });

  it.each([
    [['--confirm-throwaway', 'teste'], /--project/],
    [['--project', 'teste'], /--confirm-throwaway must repeat/],
    [['--project', 'teste', '--confirm-throwaway', 'novo-prod'], /--confirm-throwaway must repeat/],
    [['--project', '--apply'], /requires a value/],
    [['--project', 'teste', '--confirm-throwaway', 'teste', '--force'], /Unknown argument/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseScrubArgs(argv)).toThrow(ScrubArgError);
    expect(() => parseScrubArgs(argv)).toThrow(message);
  });
});

describe('credentialDocuments', () => {
  it('keeps only credential paths from a collection-group walk', () => {
    // A `token` collection group also matches unrelated parents.
    expect(
      credentialDocuments([
        'integracao/ml/tokenDuravel/a',
        'integracoes/x/token/b',
        'pedidos/p/token/c',
        'int_frete/me/tokenMelEnv/d',
        'produtos/p/certificados/e',
      ]),
    ).toEqual([
      'integracao/ml/tokenDuravel/a',
      'integracoes/x/token/b',
      'int_frete/me/tokenMelEnv/d',
    ]);
  });
});

describe('fieldsToScrub', () => {
  it('finds the WhatsApp token and PIN on an integracao document only', () => {
    const data = { permanent_token: 'EAAG', pin: '1', nome: 'w' };
    expect(fieldsToScrub('integracao/w', data)).toEqual(['permanent_token', 'pin']);
    expect(fieldsToScrub('pedidos/w', data)).toEqual([]);
    expect(fieldsToScrub('integracao/w', { nome: 'w' })).toEqual([]);
  });
});
