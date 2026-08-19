import { describe, expect, it } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';
import { ML_CAUSA_TIPO } from '@delfrance/schemas';

import {
  MAX_CAUSAS,
  buildErrorLines,
  clearFalha,
  falhaPatch,
  formatCausaLinha,
  parseMlCausas,
  resolveCampos,
} from './publishFalhas';

const httpErr = (status: number, body: unknown): MercadoLivreHttpError =>
  new MercadoLivreHttpError(`ML ${String(status)}: Validation error`, status, body);

/**
 * The response the ML developers site documents for a rejected `POST /items`
 * (*Guia para produtos → Validações*), verbatim. It is the primary fixture on
 * purpose: it is the only shape ML publishes a contract for, and it is the one
 * that produced the bare `ML 400: Validation error` this module exists to end.
 */
const DOCS_BODY = {
  message: 'Validation error',
  error: 'validation_error',
  status: 400,
  cause: [
    {
      department: 'structured-data',
      cause_id: 2511,
      type: 'warning',
      code: 'create.item.attribute.business_conditional',
      references: ['item.attributes'],
      message: 'Attribute [AGE_GROUP] to be added with values [(6725189,null)]',
    },
    {
      department: 'moderations',
      cause_id: 3250,
      type: 'error',
      code: 'moderations.seller.not_authorized',
      references: ['item.seller_id', 'item.category_id', 'item.attributes[0]'],
      message: 'Seller is not authorized for this brand and category',
    },
    {
      department: 'structured-data',
      cause_id: 1212,
      type: 'warning',
      code: 'normalize.item.attribute.values',
      references: ['item.variations[0].attribute_combinations[1].values'],
      message: 'Attribute [SIZE] to be modified - values [(null,32.5 BR)]',
    },
    {
      department: 'shipping',
      cause_id: 4029,
      type: 'warning',
      code: 'shipping.me2_adoption_mandatory',
      references: ['shipping.modes', 'user.shipping_preferences.option'],
      message: 'ME2 adoption is mandatory for the user',
    },
  ],
};

/** The array as `buildItemPayload` emits it — index 0 is what `attributes[0]` means. */
const SENT = [{ id: 'BRAND' }, { id: 'MODEL' }, { id: 'SELLER_SKU' }];

describe('parseMlCausas — the documented body', () => {
  it('keeps every cause, with its ML code, cause_id, department and message', () => {
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    expect(causas).toHaveLength(4);
    expect(causas[1]).toMatchObject({
      code: 'moderations.seller.not_authorized',
      causaId: 3250,
      tipo: 'error',
      departamento: 'moderations',
      mensagem: 'Seller is not authorized for this brand and category',
      referencias: ['item.seller_id', 'item.category_id', 'item.attributes[0]'],
    });
  });

  it('splits blocking errors from ML-applied warnings', () => {
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    expect(causas.filter((c) => c.tipo === ML_CAUSA_TIPO.erro)).toHaveLength(1);
    expect(causas.filter((c) => c.tipo === ML_CAUSA_TIPO.aviso)).toHaveLength(3);
  });

  it('resolves a POSITIONAL attributes[0] against the payload that was sent', () => {
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    // One cause, three references, TWO controls — the multi-field case.
    expect(causas[1]!.campos.sort()).toEqual(['attributes.BRAND', 'category_id']);
  });

  it('claims nothing for references with no control (seller_id, shipping, user)', () => {
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    expect(causas[3]!.campos).toEqual([]);
    expect(causas[3]!.referencias).toEqual(['shipping.modes', 'user.shipping_preferences.option']);
  });

  it('reads a bracketed attribute id out of the message for a bare item.attributes', () => {
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    expect(causas[0]!.campos).toEqual(['attributes.AGE_GROUP']);
  });

  it('does not pin a variation combination path to a parent attribute row', () => {
    // `item.variations[0]…` is not an `item.attributes` path, so nothing maps
    // and the cause is rendered above the form instead of on the wrong control.
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    expect(causas[2]!.campos).toEqual([]);
  });

  it('still resolves the message-named attribute with no payload in hand', () => {
    // The /users/me probe and the description step have no item payload.
    const causas = parseMlCausas(httpErr(400, DOCS_BODY), null);
    expect(causas[0]!.campos).toEqual(['attributes.AGE_GROUP']);
    // …but the positional reference is unresolvable, so that cause degrades to
    // the one control it CAN name rather than guessing an index.
    expect(causas[1]!.campos).toEqual(['category_id']);
  });
});

describe('resolveCampos — the reference table', () => {
  it.each([
    ['item.title', 'title'],
    ['item.family_name', 'title'],
    ['item.category_id', 'category_id'],
    ['item.listing_type_id', 'listing_type_id'],
    ['item.description', 'descricao'],
    ['title', 'title'],
  ])('%s → %s', (ref, campo) => {
    expect(resolveCampos([ref], 'qualquer coisa', SENT)).toEqual([campo]);
  });

  it.each(['item.seller_id', 'item.pictures', 'shipping.modes', 'user.x.y', 'item.price'])(
    'leaves %s unmapped',
    (ref) => {
      expect(resolveCampos([ref], 'sem atributos aqui', SENT)).toEqual([]);
    },
  );

  it('maps the documented missing_required message onto its attribute row', () => {
    const campos = resolveCampos(
      ['item.attributes'],
      'The attributes [BRAND] are required for category MLB1234 and channel marketplace.',
      SENT,
    );
    expect(campos).toEqual(['attributes.BRAND']);
  });

  it('never invents an attribute from an unbracketed word', () => {
    // `MLB1234` and `ML` are SCREAMING_SNAKE-ish but neither is bracketed nor
    // an id we sent, so a blind scan would highlight nothing real.
    expect(resolveCampos(['item.attributes'], 'Erro ao publicar em MLB1234 no ML', [])).toEqual([]);
  });

  it('claims an unbracketed token only when it is an id we actually sent', () => {
    expect(resolveCampos(['item.attributes'], 'valor inválido em BRAND', SENT)).toEqual([
      'attributes.BRAND',
    ]);
  });

  it('falls back to the message when the positional index is out of range', () => {
    const campos = resolveCampos(['item.attributes[99]'], 'Attribute [GTIN] invalid', SENT);
    expect(campos).toEqual(['attributes.GTIN']);
  });

  it('deduplicates a control named by two references', () => {
    expect(resolveCampos(['item.title', 'title'], 'x', SENT)).toEqual(['title']);
  });
});

describe('parseMlCausas — the shapes ML also sends', () => {
  it('accepts `causes` (plural) of bare strings', () => {
    const causas = parseMlCausas(httpErr(400, { causes: ['wrong_invoice_date'] }));
    expect(causas).toEqual([
      expect.objectContaining({ mensagem: 'wrong_invoice_date', code: 'wrong_invoice_date' }),
    ]);
  });

  it('does not mistake a prose string cause for a code', () => {
    const causas = parseMlCausas(httpErr(400, { causes: ['O anúncio não pode ser alterado'] }));
    expect(causas[0]).toMatchObject({ mensagem: 'O anúncio não pode ser alterado', code: null });
  });

  it('uses the code as the message when a cause carries no message', () => {
    const causas = parseMlCausas(httpErr(400, { cause: [{ code: 'duplicated_fiscal_key' }] }));
    expect(causas[0]).toMatchObject({
      mensagem: 'duplicated_fiscal_key',
      code: 'duplicated_fiscal_key',
    });
  });

  it('accepts a single cause object instead of an array', () => {
    const causas = parseMlCausas(httpErr(400, { cause: { code: 'x', message: 'só uma' } }));
    expect(causas).toHaveLength(1);
    expect(causas[0]!.mensagem).toBe('só uma');
  });

  it('accepts `references` as a single string', () => {
    const causas = parseMlCausas(
      httpErr(400, { cause: [{ message: 'ruim', references: 'item.title' }] }),
      SENT,
    );
    expect(causas[0]!.referencias).toEqual(['item.title']);
    expect(causas[0]!.campos).toEqual(['title']);
  });

  it('accepts a stringified cause_id and ignores an unknown type', () => {
    const causas = parseMlCausas(
      httpErr(400, { cause: [{ cause_id: '147', type: 'critical', message: 'x' }] }),
    );
    expect(causas[0]).toMatchObject({ causaId: 147, tipo: null });
  });

  it('returns nothing for a 403, which carries no cause at all', () => {
    // The body the docs give for `pt_br/erro-403`.
    const body = { status: 403, error: 'access_denied', message: 'forbidden', code: 'FORBIDDEN' };
    expect(parseMlCausas(httpErr(403, body))).toEqual([]);
  });

  it('reads causes on a non-400 too — they are displayed, never acted on', () => {
    const causas = parseMlCausas(httpErr(409, { cause: [{ message: 'conflito' }] }));
    expect(causas).toHaveLength(1);
  });

  it('returns nothing for a non-JSON body, a null body or a non-HTTP error', () => {
    expect(parseMlCausas(httpErr(500, '<html>oops</html>'))).toEqual([]);
    expect(parseMlCausas(httpErr(500, null))).toEqual([]);
    expect(parseMlCausas(new MercadoLivreNetworkError('offline'))).toEqual([]);
    expect(parseMlCausas(new Error('qualquer'))).toEqual([]);
    expect(parseMlCausas(undefined)).toEqual([]);
  });

  it('caps a pathological body at MAX_CAUSAS', () => {
    const cause = Array.from({ length: MAX_CAUSAS + 12 }, (_, i) => ({
      message: `erro ${String(i)}`,
    }));
    expect(parseMlCausas(httpErr(400, { cause }))).toHaveLength(MAX_CAUSAS);
  });
});

describe('formatCausaLinha / buildErrorLines', () => {
  it('renders type, code, message and the raw references on one line', () => {
    const [aviso, erro] = parseMlCausas(httpErr(400, DOCS_BODY), SENT);
    expect(formatCausaLinha(erro!)).toBe(
      'error · moderations.seller.not_authorized — Seller is not authorized for this brand and category [item.seller_id, item.category_id, item.attributes[0]]',
    );
    expect(formatCausaLinha(aviso!)).toContain(
      'warning · create.item.attribute.business_conditional',
    );
  });

  it('omits the empty parts rather than printing separators around nothing', () => {
    const [falha] = parseMlCausas(httpErr(400, { cause: [{ message: 'só a mensagem' }] }));
    expect(formatCausaLinha(falha!)).toBe('só a mensagem');
  });

  it('replaces the bare headline with one line per cause', () => {
    const err = httpErr(400, DOCS_BODY);
    const lines = buildErrorLines(err, parseMlCausas(err, SENT), err.message);
    expect(lines).toHaveLength(4);
    // The whole complaint: this used to be the ONLY thing persisted.
    expect(lines).not.toContain('ML 400: Validation error');
  });

  it('keeps a capped raw body when nothing parsed, so no detail is lost', () => {
    const err = httpErr(400, { error: 'forma_desconhecida', detalhe: 'algo que ML inventou' });
    const lines = buildErrorLines(err, [], err.message);
    expect(lines[0]).toBe('ML 400: Validation error');
    expect(lines[1]).toContain('forma_desconhecida');
  });

  it('does not duplicate the headline when the body adds nothing', () => {
    expect(buildErrorLines(httpErr(400, null), [], 'ML 400: Bad Request')).toEqual([
      'ML 400: Bad Request',
    ]);
    expect(buildErrorLines(new Error('x'), [], 'falhou')).toEqual(['falhou']);
  });

  it('truncates an enormous body instead of writing it whole to Firestore', () => {
    const err = httpErr(400, { blob: 'x'.repeat(5_000) });
    const [, tail] = buildErrorLines(err, [], err.message);
    expect(tail!.length).toBeLessThanOrEqual(501);
    expect(tail!.endsWith('…')).toBe(true);
  });
});

describe('falhaPatch / clearFalha', () => {
  it('produces both link-doc fields together', () => {
    const patch = falhaPatch(httpErr(400, DOCS_BODY), 'ML 400: Validation error', SENT);
    expect(patch.causas).toHaveLength(4);
    expect(patch.errors).toHaveLength(4);
  });

  it('clears both together — a causa outliving its errors is a red healthy field', () => {
    expect(clearFalha()).toEqual({ errors: [], causas: [] });
  });

  it('hands every call site its OWN arrays', () => {
    // A shared constant would leak a push in one plan into every other.
    expect(clearFalha().errors).not.toBe(clearFalha().errors);
  });
});
