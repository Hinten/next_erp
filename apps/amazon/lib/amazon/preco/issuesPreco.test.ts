/**
 * The price-issue classifier: what makes an issue a price issue (category,
 * attribute, code backstop), the BR-store scope, each class, and the codes a
 * task carries.
 */
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_ID_BR, issueListingAmazonSchema } from '@delfrance/integrations-amazon-sp-api';
import { amazonIssueWireSchema } from '@delfrance/schemas';

import {
  CLASSE_ISSUE_PRECO_AMAZON,
  CODIGOS_ISSUE_PRECO_AMAZON,
  MAX_CODIGOS_ANTES_PRECO_AMAZON,
  classeDaIssuePrecoAmazon,
  codigoDaIssueAmazon,
  codigosPrecoAmazon,
  ehIssuePrecoAmazon,
  ehIssuePrecoBloqueanteAmazon,
  temIssuePrecoAmazon,
  temIssuePrecoBloqueanteAmazon,
} from './issuesPreco';

const erro = (extra: Record<string, unknown>) => ({ severity: 'ERROR', ...extra });

describe('★ a price issue', () => {
  it('★ a category INVALID_PRICE or MISSING_PRICE makes it one, whatever its code', () => {
    expect(ehIssuePrecoAmazon(erro({ code: '1', categories: ['INVALID_PRICE'] }))).toBe(true);
    expect(ehIssuePrecoAmazon(erro({ code: '2', categories: ['X', 'MISSING_PRICE'] }))).toBe(true);
  });

  it('★ an attribute naming the offer, or one of its three prices, makes it one', () => {
    for (const a of [
      'purchasable_offer',
      'our_price',
      'minimum_seller_allowed_price',
      'maximum_seller_allowed_price',
    ]) {
      expect(ehIssuePrecoAmazon(erro({ code: '5', attributeNames: ['item_name', a] })), a).toBe(
        true,
      );
    }
  });

  it('★ the code backstop: 18155 with no category is a price issue (and so are 19037, 19038, 18701)', () => {
    expect(CODIGOS_ISSUE_PRECO_AMAZON).toEqual(['19037', '19038', '18701', '18155']);
    for (const code of CODIGOS_ISSUE_PRECO_AMAZON) {
      expect(ehIssuePrecoAmazon(erro({ code })), code).toBe(true);
    }
  });

  it('★ NEAR-MISS: 90220 on item_name is not one; nor a category, attribute or code that merely resembles one', () => {
    expect(ehIssuePrecoAmazon(erro({ code: '90220', attributeNames: ['item_name'] }))).toBe(false);
    expect(ehIssuePrecoAmazon(erro({ code: '190370', categories: ['invalid_price'] }))).toBe(false);
    expect(ehIssuePrecoAmazon(erro({ code: 19037 }))).toBe(false);
    expect(ehIssuePrecoAmazon(erro({ attributeNames: ['purchasable_offer.our_price '] }))).toBe(
      false,
    );
    expect(ehIssuePrecoAmazon(erro({ attributeNames: 'purchasable_offer' }))).toBe(false);
  });

  it('★ an issue naming its stores is counted only when the BR store is one of them (NEAR-MISS: absent marketplaceIds ⇒ counted)', () => {
    const preco = { code: '1', categories: ['INVALID_PRICE'] };
    expect(ehIssuePrecoAmazon(erro({ ...preco, marketplaceIds: ['ATVPDKIKX0DER'] }))).toBe(false);
    expect(
      ehIssuePrecoAmazon(erro({ ...preco, marketplaceIds: ['ATVPDKIKX0DER', MARKETPLACE_ID_BR] })),
    ).toBe(true);
    expect(ehIssuePrecoAmazon(erro(preco))).toBe(true);
    // A list it cannot read names no store: kept.
    expect(ehIssuePrecoAmazon(erro({ ...preco, marketplaceIds: [] }))).toBe(true);
    expect(ehIssuePrecoAmazon(erro({ ...preco, marketplaceIds: 'ATVPDKIKX0DER' }))).toBe(true);
  });

  it('only an issue’s OWN fields are read; anything that is not an issue is none', () => {
    const herdada = Object.create({ code: '19037', categories: ['INVALID_PRICE'] }) as object;
    expect(ehIssuePrecoAmazon(herdada)).toBe(false);
    for (const nada of [null, undefined, '19037', 19037, ['19037']]) {
      expect(ehIssuePrecoAmazon(nada)).toBe(false);
    }
    expect(codigoDaIssueAmazon({ code: '19037' })).toBe('19037');
    expect(codigoDaIssueAmazon({ code: 19037 })).toBeNull();
  });
});

describe('★ its class', () => {
  it('★ 100708 as a WARNING ⇒ `aviso` only (INFO too): it blocks nothing', () => {
    const aviso = { code: '100708', severity: 'WARNING', categories: ['INVALID_PRICE'] };
    expect(classeDaIssuePrecoAmazon(aviso)).toBe(CLASSE_ISSUE_PRECO_AMAZON.aviso);
    expect(classeDaIssuePrecoAmazon({ ...aviso, severity: 'INFO' })).toBe(
      CLASSE_ISSUE_PRECO_AMAZON.aviso,
    );
  });

  it('★ 18701 ⇒ `requer-pessoa`, whatever its severity (a person must confirm it)', () => {
    expect(classeDaIssuePrecoAmazon(erro({ code: '18701' }))).toBe(
      CLASSE_ISSUE_PRECO_AMAZON.requerPessoa,
    );
    expect(classeDaIssuePrecoAmazon({ code: '18701', severity: 'WARNING' })).toBe(
      CLASSE_ISSUE_PRECO_AMAZON.requerPessoa,
    );
  });

  it('ERROR ⇒ `erro`; NEAR-MISS: a missing, unknown or lower-case severity is read as blocking too', () => {
    expect(classeDaIssuePrecoAmazon(erro({ code: '19037' }))).toBe(CLASSE_ISSUE_PRECO_AMAZON.erro);
    for (const severity of [undefined, null, 'warning', 'FATAL', '']) {
      expect(classeDaIssuePrecoAmazon({ code: '19037', severity }), String(severity)).toBe(
        CLASSE_ISSUE_PRECO_AMAZON.erro,
      );
    }
    expect(classeDaIssuePrecoAmazon(erro({ code: '90220' }))).toBeNull();
  });
});

describe('★ an answer, a report item, a stored outcome', () => {
  it('★ an INVALID answer carrying 19037 has a price issue; one carrying only 90220 has none', () => {
    expect(temIssuePrecoAmazon([erro({ code: '90220' }), erro({ code: '19037' })])).toBe(true);
    expect(temIssuePrecoAmazon([erro({ code: '90220', attributeNames: ['item_name'] })])).toBe(
      false,
    );
    expect(temIssuePrecoAmazon(null)).toBe(false);
    expect(temIssuePrecoAmazon(undefined)).toBe(false);
  });

  it('★ a BLOCKING price issue is an ERROR (or unknown severity) or one a person must confirm; NEAR-MISS: a price WARNING or INFO alone blocks nothing', () => {
    const aviso = { code: '100708', severity: 'WARNING', categories: ['INVALID_PRICE'] };
    expect(temIssuePrecoBloqueanteAmazon([aviso, { ...aviso, severity: 'INFO' }])).toBe(false);
    expect(temIssuePrecoAmazon([aviso])).toBe(true);
    expect(temIssuePrecoBloqueanteAmazon([aviso, erro({ code: '19037' })])).toBe(true);
    expect(temIssuePrecoBloqueanteAmazon([{ code: '18701', severity: 'WARNING' }])).toBe(true);
    expect(temIssuePrecoBloqueanteAmazon([{ code: '19037' }])).toBe(true);
    expect(
      ehIssuePrecoBloqueanteAmazon(erro({ code: '90220', attributeNames: ['item_name'] })),
    ).toBe(false);
    expect(
      ehIssuePrecoBloqueanteAmazon(erro({ code: '19037', marketplaceIds: ['ATVPDKIKX0DER'] })),
    ).toBe(false);
    expect(temIssuePrecoBloqueanteAmazon(null)).toBe(false);
  });

  it('reads the package’s issue and the link doc’s stored issue alike (both keep unknown keys)', () => {
    const cru = {
      code: '19037',
      severity: 'ERROR',
      categories: ['INVALID_PRICE'],
      marketplaceIds: [MARKETPLACE_ID_BR],
    };
    expect(ehIssuePrecoAmazon(issueListingAmazonSchema.parse(cru))).toBe(true);
    expect(ehIssuePrecoAmazon(amazonIssueWireSchema.parse(cru))).toBe(true);
    expect(
      ehIssuePrecoAmazon(
        amazonIssueWireSchema.parse({ ...cru, marketplaceIds: ['ATVPDKIKX0DER'] }),
      ),
    ).toBe(false);
  });
});

describe('★ the codes a task carries (codigosAntes)', () => {
  it('the distinct price codes, in code order; a non-price code, a codeless or another store’s issue is left out', () => {
    expect(
      codigosPrecoAmazon([
        erro({ code: '19038' }),
        erro({ code: '90220', attributeNames: ['item_name'] }),
        erro({ code: '18155' }),
        erro({ code: '19038' }),
        erro({ categories: ['INVALID_PRICE'] }),
        erro({ code: '19037', marketplaceIds: ['ATVPDKIKX0DER'] }),
        { code: '100708', severity: 'WARNING', categories: ['INVALID_PRICE'] },
      ]),
    ).toEqual(['100708', '18155', '19038']);
  });

  it('at most 10; NEAR-MISS: a code outside the grammar is left out (read later, it counts as new)', () => {
    const muitos = Array.from({ length: 14 }, (_v, i) =>
      erro({ code: `C${String(i).padStart(2, '0')}`, categories: ['INVALID_PRICE'] }),
    );
    const codigos = codigosPrecoAmazon(muitos);
    expect(codigos).toHaveLength(MAX_CODIGOS_ANTES_PRECO_AMAZON);
    expect(codigos[0]).toBe('C00');
    // The ten SMALLEST codes, whatever the order they were read in (NEAR-MISS: the first ten seen).
    const dezMenores = Array.from({ length: 10 }, (_v, i) => `C${String(i).padStart(2, '0')}`);
    expect(codigos).toEqual(dezMenores);
    expect(codigosPrecoAmazon([...muitos].reverse())).toEqual(dezMenores);
    expect(codigosPrecoAmazon([erro({ code: '19 037', categories: ['INVALID_PRICE'] })])).toEqual(
      [],
    );
    expect(
      codigosPrecoAmazon([erro({ code: 'x'.repeat(33), categories: ['INVALID_PRICE'] })]),
    ).toEqual([]);
    expect(codigosPrecoAmazon('19037')).toEqual([]);
  });
});
