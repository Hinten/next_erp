import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { NA_VALUE_ID, seedRow, type AttrRow } from '@/lib/mercado-livre/attributeForm';
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

/**
 * `number_unit` — the half of an attribute that used to be invisible.
 *
 * ML stores a measurement as a number PLUS a unit (`value_name` + `unit_id`),
 * and until this block existed the field rendered only the number: the unit was
 * stamped from `attr.defaultUnit` behind the operator's back and there was
 * nothing on screen to show which one had been chosen.
 */
describe('AttributeField — number_unit', () => {
  function volume(over: Partial<MercadoLivreCategoriaAtributo> = {}) {
    return attr({
      id: 'VOLUME',
      name: 'Volume',
      valueType: 'number_unit',
      defaultUnit: 'ml',
      allowedUnits: [
        { id: 'ml', name: 'ml' },
        { id: 'l', name: 'l' },
      ],
      ...over,
    });
  }

  const UNIT = 'Unidade de Volume';

  it('shows the unit as a picker when ML allows a choice', () => {
    renderField(volume(), { id: 'VOLUME', value_id: null, value_name: '355', unit_id: 'ml' });
    expect(combo(UNIT)).toHaveProperty('value', 'ml');
  });

  it('shows a FIXED unit as plain text rather than a dropdown nobody can use', () => {
    renderField(volume({ allowedUnits: [{ id: 'ml', name: 'ml' }] }));
    expect(screen.queryByRole('combobox', { name: UNIT })).toBeNull();
    expect(screen.getByText('ml')).toBeDefined();
  });

  it('spells out the inch unit, whose id is a bare double quote', () => {
    renderField(
      volume({
        defaultUnit: '"',
        allowedUnits: [
          { id: '"', name: '"' },
          { id: 'cm', name: 'cm' },
        ],
      }),
    );
    // Two barely visible tick marks would read as a blank option.
    expect(combo(UNIT)).toHaveProperty('value', 'pol. (")');
  });

  it('keeps the number when the unit changes — and DROPS a stale value_id', () => {
    // ⚠️ On a number_unit, ML's value_id names the PAIR: 3681798 IS "355 mL".
    // Carried over to litres it describes a different measurement, outranks the
    // value name at ML, and skips the resolution in `attributesForSave`.
    const onChange = renderField(volume(), {
      id: 'VOLUME',
      value_id: '3681798',
      value_name: '355',
      unit_id: 'ml',
    });
    fireEvent.click(combo(UNIT));
    fireEvent.click(screen.getByText('l'));
    expect(onChange).toHaveBeenCalledWith({
      id: 'VOLUME',
      value_id: null,
      value_name: '355',
      unit_id: 'l',
    });
  });

  it('keeps the unit when the number changes', () => {
    // This is the bug itself: the handler used to re-read `attr.defaultUnit`,
    // so the operator's pick died on the next keystroke.
    const onChange = renderField(volume(), {
      id: 'VOLUME',
      value_id: null,
      value_name: '1',
      unit_id: 'l',
    });
    fireEvent.change(combo('Volume'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith({
      id: 'VOLUME',
      value_id: null,
      value_name: '2',
      unit_id: 'l',
    });
  });

  it('keeps the unit when the number is CLEARED', () => {
    // Emptying the box says nothing about the unit; dropping it here snapped the
    // picker back to `defaultUnit` behind the operator's back.
    const onChange = renderField(volume(), {
      id: 'VOLUME',
      value_id: null,
      value_name: '1',
      unit_id: 'l',
    });
    fireEvent.change(combo('Volume'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({
      id: 'VOLUME',
      value_id: null,
      value_name: null,
      unit_id: 'l',
    });
  });

  it('reports NOTHING when an untouched IMPORTED field is blurred', () => {
    // The headline regression. `GET /items` answers `'355 mL'` with no unit_id,
    // so the box used to hold "355 mL"; the first blur ran it through
    // `digitsOnly` and stamped `defaultUnit` — tabbing past the field silently
    // restated the measurement and raised unsaved changes.
    const a = volume();
    const seeded = seedRow(a, { id: 'VOLUME', value_id: '3681798', value_name: '355 mL' });
    // The pair id goes with the pair: `3681798` IS '355 mL', and nothing can
    // rebuild it from the bare '355' the box now holds.
    expect(seeded).toEqual({
      id: 'VOLUME',
      value_id: null,
      value_name: '355',
      unit_id: 'ml',
    });
    const reported = renderControlled(a, seeded);
    fireEvent.blur(combo('Volume'));
    expect(reported).not.toHaveBeenCalled();
    expect(combo('Volume')).toHaveProperty('value', '355');
    expect(combo(UNIT)).toHaveProperty('value', 'ml');
  });

  it('reports NOTHING when an untouched BARE NUMBER is blurred', () => {
    // Legacy Flutter rows store the number with no unit at all. `seedRow` fills
    // in the one the picker shows so the row and the screen agree — without
    // that, this blur resolved to `defaultUnit` and reported a phantom edit.
    const a = volume();
    const reported = renderControlled(a, seedRow(a, { id: 'VOLUME', value_name: '355' }));
    fireEvent.blur(combo('Volume'));
    expect(reported).not.toHaveBeenCalled();
  });

  it('disables both halves together', () => {
    const a = volume();
    render(
      <MantineTestProvider>
        <AttributeField
          attr={a}
          row={{ id: 'VOLUME', value_id: null, value_name: '355', unit_id: 'ml' }}
          onChange={vi.fn()}
          disabled
        />
      </MantineTestProvider>,
    );
    expect(combo('Volume')).toHaveProperty('disabled', true);
    expect(combo(UNIT)).toHaveProperty('disabled', true);
  });

  it('keeps the error message reachable from the input', () => {
    // The message is rendered OUTSIDE the input so flagging a required attribute
    // cannot shove the unit picker off the baseline — which costs Mantine's own
    // wiring. `aria-errormessage` puts it back: Mantine overwrites an
    // `aria-describedby` passed in, but forwards this one.
    render(
      <MantineTestProvider>
        <AttributeField
          attr={volume({ required: true })}
          row={{ id: 'VOLUME', value_id: null, value_name: null, unit_id: 'ml' }}
          onChange={vi.fn()}
          error="Este campo é obrigatório"
        />
      </MantineTestProvider>,
    );
    const input = combo('Volume');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const id = input.getAttribute('aria-errormessage');
    expect(id).not.toBeNull();
    expect(document.getElementById(id!)?.textContent).toBe('Este campo é obrigatório');
  });

  it('still shows the unit when the stored casing differs from the allow-list', () => {
    // ⚠️ A Mantine Select handed a value absent from its `data` renders BLANK.
    // `seedRow` canonicalises to the allow-list spelling so the picker keeps a
    // value and the row keeps agreeing with the screen.
    const a = volume({
      allowedUnits: [
        { id: 'ml', name: 'ml' },
        { id: 'l', name: 'l' },
      ],
    });
    const seeded = seedRow(a, { id: 'VOLUME', value_name: '355', unit_id: 'mL' });
    const reported = renderControlled(a, seeded);
    expect(combo(UNIT)).toHaveProperty('value', 'ml');
    fireEvent.blur(combo('Volume'));
    expect(reported).not.toHaveBeenCalled();
  });

  it('leaves a plain number attribute with no unit control at all', () => {
    // Guards the widgetKind split from quietly drifting back together.
    renderField(attr({ id: 'QTD', name: 'Quantidade', valueType: 'number' }));
    expect(screen.queryByRole('combobox', { name: /Unidade/ })).toBeNull();
  });
});
