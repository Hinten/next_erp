import { describe, expect, it } from 'vitest';
import { PRODUTO_SEM_NOME, nivelDoNomeDoItem, nomeDoItem } from './nomeDoItem';

const item = {
  produtoUid: 'p1',
  nomeDeVenda: 'Camiseta (vendida como)',
  sku: 'CAM-001',
};

describe('nomeDoItem — priority', () => {
  it('prefers the LIVE produto name over the denormalised sale name', () => {
    expect(nomeDoItem(item, { nome: 'Camiseta Branca P' })).toBe('Camiseta Branca P');
  });

  it('falls back to nomeDeVenda when the produto doc is gone (deleted produto)', () => {
    expect(nomeDoItem(item, null)).toBe('Camiseta (vendida como)');
  });

  it('falls back to nomeDeVenda for an unmatched marketplace line (produtoUid null)', () => {
    expect(
      nomeDoItem({ produtoUid: null, nomeDeVenda: 'Kit 3 Camisetas Masculinas', sku: null }, null),
    ).toBe('Kit 3 Camisetas Masculinas');
  });

  it('falls back to the sku when neither name is available', () => {
    expect(nomeDoItem({ produtoUid: 'p1', nomeDeVenda: null, sku: 'CAM-001' }, null)).toBe(
      'CAM-001',
    );
  });

  it('falls back to the raw produtoUid when there is no name and no sku', () => {
    expect(nomeDoItem({ produtoUid: 'p1', nomeDeVenda: null, sku: null }, null)).toBe('p1');
  });

  it('falls back to PRODUTO_SEM_NOME when the line carries nothing at all', () => {
    expect(nomeDoItem({ produtoUid: null, nomeDeVenda: null, sku: null }, null)).toBe(
      PRODUTO_SEM_NOME,
    );
    expect(nomeDoItem(null, null)).toBe(PRODUTO_SEM_NOME);
    expect(nomeDoItem(undefined, undefined)).toBe(PRODUTO_SEM_NOME);
  });

  it('reads a produto whose own nome is null (EngineProduto) as no produto name', () => {
    expect(nomeDoItem(item, { nome: null })).toBe('Camiseta (vendida como)');
  });
});

describe('nomeDoItem — blank is not a name', () => {
  // The `||` vs `??` split across the old call sites: a stored empty string
  // blanked the row on the `??` surfaces and fell through on the `||` ones.
  it('falls through an empty produto name', () => {
    expect(nomeDoItem(item, { nome: '' })).toBe('Camiseta (vendida como)');
  });

  it('falls through a whitespace-only produto name', () => {
    expect(nomeDoItem(item, { nome: '   ' })).toBe('Camiseta (vendida como)');
  });

  it('falls through a whitespace-only nomeDeVenda to the sku', () => {
    expect(nomeDoItem({ produtoUid: 'p1', nomeDeVenda: '  ', sku: 'CAM-001' }, null)).toBe(
      'CAM-001',
    );
  });

  it('falls through a whitespace-only sku to the produtoUid', () => {
    expect(nomeDoItem({ produtoUid: 'p1', nomeDeVenda: '', sku: '\t' }, null)).toBe('p1');
  });

  it('falls through a whitespace-only produtoUid to PRODUTO_SEM_NOME', () => {
    expect(nomeDoItem({ produtoUid: ' ', nomeDeVenda: null, sku: null }, null)).toBe(
      PRODUTO_SEM_NOME,
    );
  });

  it('trims the value it returns', () => {
    expect(nomeDoItem(item, { nome: '  Camiseta Branca P  ' })).toBe('Camiseta Branca P');
  });
});

describe('nomeDoItem — near misses that must stay DISTINCT', () => {
  // The resolver folds blanks away; it must fold nothing else. A name that
  // merely LOOKS like padding is still a name.
  it('keeps interior whitespace', () => {
    expect(nomeDoItem(null, { nome: 'Camiseta  Branca' })).toBe('Camiseta  Branca');
  });

  it('keeps a name that differs from another only by case or accent', () => {
    expect(nomeDoItem(null, { nome: 'CAMISETA' })).not.toBe(nomeDoItem(null, { nome: 'camiseta' }));
    expect(nomeDoItem(null, { nome: 'Calcao' })).not.toBe(nomeDoItem(null, { nome: 'Calção' }));
  });

  it('keeps a numeric-looking name verbatim — never reads it as a number', () => {
    expect(nomeDoItem(null, { nome: '01' })).toBe('01');
    expect(nomeDoItem(null, { nome: '90,50' })).not.toBe(nomeDoItem(null, { nome: '90,5' }));
  });

  it('does not treat "0" as blank', () => {
    expect(nomeDoItem({ produtoUid: 'p1', nomeDeVenda: '0', sku: 'CAM-001' }, null)).toBe('0');
  });
});

describe('nomeDoItem — totality', () => {
  it('never returns an empty string, for any combination of the four inputs', () => {
    const valores = [undefined, null, '', '   ', 'x'] as const;
    for (const nome of valores) {
      for (const nomeDeVenda of valores) {
        for (const sku of valores) {
          for (const produtoUid of valores) {
            const out = nomeDoItem(
              { produtoUid, nomeDeVenda, sku },
              nome === undefined ? null : { nome },
            );
            expect(out.length).toBeGreaterThan(0);
            expect(out.trim()).toBe(out);
          }
        }
      }
    }
  });
});

describe('nivelDoNomeDoItem — the tier a line reaches on its own', () => {
  it('ranks a sale name above a sku above the bare id', () => {
    expect(nivelDoNomeDoItem({ nomeDeVenda: 'Camiseta', sku: 'CAM-1' })).toBe(2);
    expect(nivelDoNomeDoItem({ nomeDeVenda: null, sku: 'CAM-1' })).toBe(1);
    expect(nivelDoNomeDoItem({ produtoUid: 'p1', nomeDeVenda: null, sku: null })).toBe(0);
    expect(nivelDoNomeDoItem(null)).toBe(0);
  });

  it('reads blank the same way the chain does', () => {
    expect(nivelDoNomeDoItem({ nomeDeVenda: '   ', sku: 'CAM-1' })).toBe(1);
    expect(nivelDoNomeDoItem({ nomeDeVenda: '', sku: '	' })).toBe(0);
  });

  // The rank exists to make a fold over many lines monotonic, and it can only do
  // that while it AGREES with the chain: the tier it reports must be the step
  // `nomeDoItem` actually stops on.
  it('agrees with the step nomeDoItem lands on, for every combination', () => {
    const valores = [null, '', '  ', 'x'] as const;
    for (const nomeDeVenda of valores) {
      for (const sku of valores) {
        const item = { produtoUid: 'p1', nomeDeVenda, sku };
        const nivel = nivelDoNomeDoItem(item);
        const nome = nomeDoItem(item, null);
        if (nivel === 2) expect(nome).toBe(nomeDeVenda?.trim());
        else if (nivel === 1) expect(nome).toBe(sku?.trim());
        else expect(nome).toBe('p1');
      }
    }
  });
});
