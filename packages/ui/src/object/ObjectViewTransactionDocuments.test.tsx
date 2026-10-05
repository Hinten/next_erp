import { Activity, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createTransactionDocuments,
  ObjectViewTransactionDocumentsProvider,
  useObjectViewTransactionDocuments,
} from './ObjectViewTransactionDocuments';

const PATH = 'produtos/p1/imposto/venda';
describe('ObjectView transaction document baselines', () => {
  it('distinguishes an unknown document from confirmed absence', () => {
    const documents = createTransactionDocuments();
    expect(documents.getBaseline(PATH)).toBeUndefined();
    documents.seedBaseline(PATH, null);
    expect(documents.getBaseline(PATH)).toBeNull();
  });
  it('freezes the seed until an explicit acknowledgement', () => {
    const documents = createTransactionDocuments();
    documents.seedBaseline(PATH, { cfop: '5102' });
    documents.seedBaseline(PATH, { cfop: '6102' });
    expect(documents.getBaseline(PATH)).toEqual({ cfop: '5102' });
    documents.rebase(PATH, { cfop: '6102' });
    expect(documents.getBaseline(PATH)).toEqual({ cfop: '6102' });
  });
  it('retains the baseline when a tab suspends and remounts its effects', async () => {
    const documents = createTransactionDocuments();
    let remote = { cfop: '5102' };
    function Tab() {
      const registry = useObjectViewTransactionDocuments();
      useEffect(() => {
        registry?.seedBaseline(PATH, remote);
      }, [registry]);
      return null;
    }
    const tree = (visible: boolean) => (
      <ObjectViewTransactionDocumentsProvider value={documents}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <Tab />
        </Activity>
      </ObjectViewTransactionDocumentsProvider>
    );
    const view = render(tree(true));
    await act(async () => {
      view.rerender(tree(false));
    });
    remote = { cfop: '6102' };
    await act(async () => {
      view.rerender(tree(true));
    });
    expect(documents.getBaseline(PATH)).toEqual({ cfop: '5102' });
  });
});
