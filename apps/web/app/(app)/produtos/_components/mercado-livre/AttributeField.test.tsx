import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { NA_VALUE_ID, type AttrRow } from '@/lib/mercado-livre/attributeForm';
import type { MercadoLivreCategoriaAtributo } from '@/lib/mercado-livre/client';
import { AttributeField } from './AttributeField';

function attr(over: Partial<MercadoLivreCategoriaAtributo> = {}): MercadoLivreCategoriaAtributo {
  return {
    id: 'BRAND',
    name: 'Marca',
    valueType: 'string',
    values: [],
    hint: null,
    valueMaxLength: null,
    defaultUnit: null,
    allowedUnits: [],
    groupId: null,
    groupName: null,
    required: false,
    multivalued: false,
    readOnly: false,
    relevance: 1,
    ...over,
  };
}

const EMPTY: AttrRow = { id: 'BRAND', value_id: null, value_name: null, unit_id: null };

/**
 * By ROLE, not by label. A Mantine Combobox — both `Select` and `Autocomplete`
 * — labels its input AND its listbox, so `getByLabelText` matches two elements
 * and throws.
 */
const combo = (name: string) => screen.getByRole('combobox', { name });

function renderField(
  a: MercadoLivreCategoriaAtributo = attr(),
  row: AttrRow = { ...EMPTY, id: a.id },
) {
  const onChange = vi.fn();
  render(
    <MantineTestProvider>
      <AttributeField attr={a} row={row} onChange={onChange} />
    </MantineTestProvider>,
  );
  return onChange;
}

/**
 * The field as the real screen wires it: the reported row feeds straight back in
 * as the `row` prop.
 *
 * The spy above cannot see the reported bug at all. It never updates `row`, so
 * the input keeps re-rendering the row it was given and the very rewrite under
 * test — state going back out to the DOM — never happens. Anything about what
 * the operator SEES while typing has to run through this one.
 */
function renderControlled(a: MercadoLivreCategoriaAtributo, initial?: AttrRow) {
  const reported = vi.fn();
  function Harness() {
    const [row, setRow] = useState<AttrRow>(initial ?? { ...EMPTY, id: a.id });
    return (
      <AttributeField
        attr={a}
        row={row}
        onChange={(next) => {
          reported(next);
          setRow(next);
        }}
      />
    );
  }
  render(
    <MantineTestProvider>
      <Harness />
    </MantineTestProvider>,
  );
  return reported;
}

describe('AttributeField', () => {
  it('lets free text through for a string attribute', () => {
    // ML ships known values for these but still accepts anything; a hard Select
    // would refuse legitimate input.
    const onChange = renderField(attr({ values: [{ id: 'B1', name: 'Hering' }] }));
    fireEvent.change(combo('Marca'), { target: { value: 'Marca Nova' } });
    expect(onChange).toHaveBeenCalledWith({
      id: 'BRAND',
      value_id: null,
      value_name: 'Marca Nova',
      unit_id: null,
    });
  });

  it('resolves a typed name to ML’s value id ON BLUR, ignoring accents and case', () => {
    // The legacy compared raw strings, so "Algodao" fell through to free text
    // where "Algodão" was a real option — and ML rejected the listing. The match
    // still happens, just not while the caret is in the field.
    const reported = renderControlled(
      attr({ id: 'MATERIAL', name: 'Material', values: [{ id: 'M1', name: 'Algodão' }] }),
    );
    fireEvent.change(combo('Material'), { target: { value: 'algodao' } });
    expect(reported).toHaveBeenLastCalledWith({
      id: 'MATERIAL',
      value_id: null,
      value_name: 'algodao',
      unit_id: null,
    });

    fireEvent.blur(combo('Material'));
    expect(reported).toHaveBeenLastCalledWith({
      id: 'MATERIAL',
      value_id: 'M1',
      value_name: 'Algodão',
      unit_id: null,
    });
    expect(combo('Material')).toHaveProperty('value', 'Algodão');
  });

  it('KEEPS a trailing space in the box while the operator types', () => {
    // The reported bug. Resolving on change trimmed the text the input renders
    // back, so the space was gone before the caret moved.
    renderControlled(attr({ values: [{ id: 'B1', name: 'Hering' }] }));
    fireEvent.change(combo('Marca'), { target: { value: 'Nike ' } });
    expect(combo('Marca')).toHaveProperty('value', 'Nike ');
  });

  it('lets a value be typed PAST a known option of the same name', () => {
    // The second stripper, and the one a trim alone does not fix: on a category
    // shipping "Nike", the canonical snap matched "Nike " straight back to
    // "Nike" and ate the space again, so "Nike Air" was unreachable.
    renderControlled(attr({ values: [{ id: 'B1', name: 'Nike' }] }));
    const box = combo('Marca');
    fireEvent.change(box, { target: { value: 'Nike' } });
    fireEvent.change(box, { target: { value: 'Nike ' } });
    expect(box).toHaveProperty('value', 'Nike ');
    fireEvent.change(box, { target: { value: 'Nike Air' } });
    expect(box).toHaveProperty('value', 'Nike Air');
  });

  it('leaves a leading space alone too', () => {
    renderControlled(attr());
    fireEvent.change(combo('Marca'), { target: { value: ' ' } });
    expect(combo('Marca')).toHaveProperty('value', ' ');
  });

  it('resolves what the INPUT holds, not what the row prop holds', () => {
    // Blur is a separate event from change, so the prop agrees with the box only
    // once React has re-rendered the last keystroke. Reading the prop makes the
    // handler's correctness depend on that flush; a stale read overwrites the
    // newest character with an older resolution. Here the two are made to
    // DISAGREE outright — the prop is empty, the box says "algodao".
    const onChange = renderField(
      attr({ id: 'MATERIAL', name: 'Material', values: [{ id: 'M1', name: 'Algodão' }] }),
    );
    fireEvent.blur(combo('Material'), { target: { value: 'algodao' } });
    expect(onChange).toHaveBeenCalledWith({
      id: 'MATERIAL',
      value_id: 'M1',
      value_name: 'Algodão',
      unit_id: null,
    });
  });

  it('reports NOTHING when an untouched field is blurred', () => {
    // `onBlur` fires on every focus loss and the parent turns any report into a
    // new rows array, which ListingForm reads as an edit — so tabbing past a
    // field must not raise unsaved changes on a listing nobody touched.
    const reported = renderControlled(attr({ values: [{ id: 'B1', name: 'Nike' }] }), {
      id: 'BRAND',
      value_id: 'B1',
      value_name: 'Nike',
      unit_id: null,
    });
    fireEvent.blur(combo('Marca'));
    expect(reported).not.toHaveBeenCalled();
  });

  it('stores the id AND the name when an enumerated option is chosen', () => {
    // A Select reports the option VALUE while an Autocomplete reports the
    // LABEL. Getting them backwards puts an id in `value_name`, which ML
    // rejects as an unknown value.
    const onChange = renderField(
      attr({
        id: 'GENDER',
        name: 'Gênero',
        valueType: 'list',
        values: [
          { id: 'G1', name: 'Masculino' },
          { id: 'G2', name: 'Feminino' },
        ],
      }),
    );
    fireEvent.click(combo('Gênero'));
    fireEvent.click(screen.getByText('Feminino'));
    expect(onChange).toHaveBeenCalledWith({
      id: 'GENDER',
      value_id: 'G2',
      value_name: 'Feminino',
      unit_id: null,
    });
  });

  it('offers "não se aplica" on a required attribute', () => {
    // Without it a required attribute the product genuinely has no value for
    // could never be published.
    const onChange = renderField(attr({ required: true }));
    fireEvent.click(screen.getByLabelText('Não se aplica'));
    expect(onChange).toHaveBeenCalledWith({
      id: 'BRAND',
      value_id: NA_VALUE_ID,
      value_name: 'N/A',
      unit_id: null,
    });
  });

  it('does not clutter optional attributes with the N/A toggle', () => {
    renderField(attr({ required: false }));
    expect(screen.queryByLabelText('Não se aplica')).toBeNull();
  });

  it('warns that only one value reaches ML for a multivalued attribute', () => {
    // `MlAttribute` and `attributeToMercadoLivre` carry exactly one value, so a
    // MultiSelect here would let an operator pick three and ship one.
    renderField(
      attr({ id: 'TAGS', name: 'Tags', valueType: 'list', multivalued: true, values: [] }),
    );
    expect(screen.getByText(/apenas um é enviado/)).toBeDefined();
  });

  it('keeps an unknown value type visible but not editable', () => {
    const a = attr({ id: 'X', name: 'Estranho', valueType: 'something_new' });
    renderField(a, { id: 'X', value_id: null, value_name: 'valor antigo', unit_id: null });
    expect(screen.getByLabelText('Estranho')).toHaveProperty('value', 'valor antigo');
    expect(screen.getByLabelText('Estranho')).toHaveProperty('readOnly', true);
  });
});
