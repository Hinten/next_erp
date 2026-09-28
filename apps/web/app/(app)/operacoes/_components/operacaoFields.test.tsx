import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { CRT, CSOSN, ORIGEM } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { operacaoStaticFields } from './operacaoFields';

/**
 * The operação's "Impostos (padrão)" tab edits only the `configuracao*` keys,
 * but the engine's tier gate reads the WHOLE operação doc (`origem` lives on
 * the Dados gerais tab). The tab must feed the editor's problems from the whole
 * form, or it would warn about — or stay silent on — the wrong doc (#1655).
 */
function Host({ values, children }: { values: Record<string, unknown>; children: ReactNode }) {
  const form = useForm({ defaultValues: values });
  return (
    <MantineTestProvider>
      <FormProvider {...form}>{children}</FormProvider>
    </MantineTestProvider>
  );
}

function renderImpostoTab(values: Record<string, unknown>) {
  const renderInput = operacaoStaticFields.configuracaoICMS?.renderInput;
  if (!renderInput) throw new Error('configuracaoICMS has no renderInput');
  render(<Host values={values}>{renderInput({} as FieldRenderProps)}</Host>);
}

const PARCIAL_500 = {
  crt: CRT.simplesNacional,
  csosn: CSOSN.icmsCobradoAnteriormente,
  csosn500: { pST: 20 },
};
const TITULO = 'A NF-e recusaria esta configuração';

describe('operação Impostos (padrão) tab — the editor problems (#1655)', () => {
  it('shows the Alert when the operação (origem included) is a tier the engine would refuse', () => {
    renderImpostoTab({ nome: 'Venda', origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 });
    expect(screen.getByText(TITULO)).toBeTruthy();
    expect(screen.getByLabelText('vBCSTRet (R$)').getAttribute('aria-invalid')).toBe('true');
  });

  it('stays silent when the operação has no Origem padrão (the engine never reads it)', () => {
    renderImpostoTab({ nome: 'Venda', origem: null, configuracaoICMS: PARCIAL_500 });
    expect(screen.queryByText(TITULO)).toBeNull();
  });
});
