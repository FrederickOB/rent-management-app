import { describe, expect, it } from 'vitest';
import {
  addressErrors,
  batchErrors,
  codeRange,
  detailsErrors,
  newBatch,
  newBlock,
  newDraft,
  nextBlockCode,
  placeOfProblem,
  previewCodes,
  setAreaCode,
  setLayout,
  setName,
  setPropertyPart,
  setPropertyType,
  setTown,
  suggestedPropertyCode,
  toCreateInput,
  unitsErrors,
  type WizardDraft,
} from './property-wizard';

const OWNER = '019a3000-0000-7000-8000-00000000000a';

/** The PRD section 5 story: a compound house in Legon with 6 single rooms and 6 chamber and hall. */
function compoundHouse(): WizardDraft {
  let d = newDraft({ portfolioId: '', ownerId: OWNER });
  d = setName(d, 'Legon compound house');
  d = setPropertyType(d, 'compound_house');
  d = setTown(d, 'Accra');
  d = { ...d, region: 'Greater Accra' };
  return {
    ...d,
    batches: [
      { ...newBatch('single_room'), count: '6' },
      { ...newBatch('chamber_and_hall'), count: '6' },
    ],
  };
}

describe('PR-01 bulk creation in the new-property wizard', () => {
  it('previews the codes of a 12-room compound house created in one step', () => {
    const preview = previewCodes(compoundHouse());
    expect(preview?.propertyCode).toBe('ACC-LEG');
    expect(preview?.total).toBe(12);
    const units = preview?.blocks[0]?.units ?? [];
    expect(preview?.blocks.map((b) => b.code)).toEqual(['B1']);
    expect(units.map((u) => u.code)).toEqual(
      Array.from({ length: 12 }, (_, i) => `ACC-LEG-B1-${String(i + 1).padStart(2, '0')}`),
    );
    // Batches are numbered in order: the single rooms first, then the chamber and hall.
    expect(units.slice(0, 6).every((u) => u.unitType === 'single_room')).toBe(true);
    expect(units.slice(6).every((u) => u.unitType === 'chamber_and_hall')).toBe(true);
    expect(codeRange(units.map((u) => u.code))).toBe('ACC-LEG-B1-01 to ACC-LEG-B1-12');
  });

  it('builds one API call with the units in the default block', () => {
    const input = toCreateInput(compoundHouse());
    expect(input).toMatchObject({
      areaCode: 'ACC',
      propertyPart: 'LEG',
      name: 'Legon compound house',
      propertyType: 'compound_house',
      use: 'residential',
      ownerId: OWNER,
      portfolioId: null,
      address: { region: 'Greater Accra', town: 'Accra', ghanapostGps: null, source: 'manual' },
      units: [
        { unitType: 'single_room', count: 6 },
        { unitType: 'chamber_and_hall', count: 6 },
      ],
    });
    expect(input.blocks).toBeUndefined();
    // Bedrooms are never sent for types that do not take them.
    expect(input.units?.[0]).not.toHaveProperty('bedrooms');
  });

  it('numbers each block from 01, and sends blocks when there are several', () => {
    let d = setLayout(compoundHouse(), 'blocks');
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]?.code).toBe('B1');
    d = {
      ...d,
      blocks: [
        ...d.blocks,
        {
          ...newBlock(nextBlockCode(d.blocks)),
          name: 'Back rooms',
          batches: [{ ...newBatch('single_room'), count: '3' }],
        },
      ],
    };
    const preview = previewCodes(d);
    expect(preview?.blocks.map((b) => [b.code, b.units.length])).toEqual([
      ['B1', 12],
      ['B2', 3],
    ]);
    expect(preview?.blocks[1]?.units.map((u) => u.code)).toEqual([
      'ACC-LEG-B2-01',
      'ACC-LEG-B2-02',
      'ACC-LEG-B2-03',
    ]);
    const input = toCreateInput(d);
    expect(input.units).toBeUndefined();
    expect(input.blocks?.map((b) => [b.code, b.name, b.units?.length])).toEqual([
      ['B1', null, 2],
      ['B2', 'Back rooms', 1],
    ]);
    // Going back to one block keeps the units typed so far.
    expect(setLayout(d, 'single').batches).toHaveLength(2);
  });

  it('suggests code parts from the name and town until someone types their own', () => {
    let d = newDraft({ portfolioId: '', ownerId: '' });
    d = setName(d, 'Osu mixed-use building');
    d = setTown(d, 'Osu');
    expect([d.areaCode, d.propertyPart]).toEqual(['OSU', 'OSU']);
    d = setAreaCode(d, 'acc1');
    d = setPropertyPart(d, 'o-s-2');
    expect([d.areaCode, d.propertyPart]).toEqual(['ACC', 'OS2']);
    d = setTown(setName(d, 'Something else'), 'Tema');
    expect([d.areaCode, d.propertyPart]).toEqual(['ACC', 'OS2']);
  });

  it('suggests the use and the unit type from the property type, without overriding a choice', () => {
    const d = setPropertyType(newDraft({ portfolioId: '', ownerId: '' }), 'office');
    expect(d.use).toBe('commercial');
    expect(d.batches[0]?.unitType).toBe('office');
    const chosen = setPropertyType({ ...d, use: 'mixed', useEdited: true }, 'compound_house');
    expect(chosen.use).toBe('mixed');
    expect(chosen.batches[0]?.unitType).toBe('office');
  });

  it('checks each step before going on', () => {
    expect(
      detailsErrors(newDraft({ portfolioId: '', ownerId: '' }), { ownerRequired: true }),
    ).toMatchObject({
      name: expect.any(String),
      propertyType: expect.any(String),
      use: expect.any(String),
      ownerId: expect.any(String),
      areaCode: expect.any(String),
      propertyPart: expect.any(String),
    });
    expect(detailsErrors(compoundHouse(), { ownerRequired: true })).toEqual({});
    expect(
      detailsErrors(setAreaCode(compoundHouse(), 'A'), { ownerRequired: true }),
    ).toHaveProperty('areaCode');

    const regions = ['Greater Accra', 'Ashanti'];
    expect(addressErrors(compoundHouse(), regions)).toEqual({});
    expect(addressErrors({ ...compoundHouse(), region: 'Atlantis' }, regions)).toHaveProperty(
      'region',
    );
    expect(addressErrors({ ...compoundHouse(), ghanapostGps: 'GA-12' }, regions)).toHaveProperty(
      'ghanapostGps',
    );
    expect(addressErrors({ ...compoundHouse(), ghanapostGps: 'ga 183 8164' }, regions)).toEqual({});
    expect(addressErrors({ ...compoundHouse(), latitude: '5.65' }, regions)).toHaveProperty(
      'latitude',
    );
    expect(
      addressErrors({ ...compoundHouse(), latitude: '95', longitude: '0' }, regions),
    ).toHaveProperty('latitude');
  });

  it('asks for bedrooms only where they apply, and keeps counts within the bulk limit', () => {
    expect(batchErrors({ ...newBatch('apartment'), count: '3' })).toHaveProperty('bedrooms');
    expect(batchErrors({ ...newBatch('apartment'), count: '3', bedrooms: '6' })).toHaveProperty(
      'bedrooms',
    );
    expect(batchErrors({ ...newBatch('apartment'), count: '3', bedrooms: '2' })).toEqual({});
    expect(batchErrors({ ...newBatch('detached_house'), count: '1' })).toEqual({});
    expect(batchErrors({ ...newBatch('single_room'), count: '0' })).toHaveProperty('count');
    expect(batchErrors({ ...newBatch('single_room'), count: '201' })).toHaveProperty('count');
    expect(batchErrors({ ...newBatch(''), count: '2' })).toHaveProperty('unitType');

    const twice = setLayout(compoundHouse(), 'blocks');
    const doubled = { ...twice, blocks: [...twice.blocks, newBlock('b1')] };
    expect(unitsErrors(doubled)?.[1]?.code).toMatch(/twice/);
    expect(previewCodes(doubled)).toBeNull();
  });

  it('sends each API refusal back to the step and field it belongs to', () => {
    expect(placeOfProblem('PROPERTY_CODE_TAKEN')).toEqual({
      step: 'details',
      field: 'propertyPart',
    });
    expect(placeOfProblem('ADDRESS.GPS_INVALID')).toEqual({
      step: 'address',
      field: 'ghanapostGps',
    });
    expect(placeOfProblem('BLOCK_CODE_TAKEN')).toEqual({ step: 'units' });
    expect(placeOfProblem('INTERNAL_ERROR')).toBeNull();
  });

  it('offers the free code the API returns with a taken one', () => {
    // As the typed client raises it: the code, the message, and the suggestion as data.
    const taken = (data?: Record<string, string>) => ({
      code: 'PROPERTY_CODE_TAKEN',
      status: 409,
      message: 'ACC-LEG is already used. Try ACC-LEG2.',
      ...(data ? { data } : {}),
    });
    expect(suggestedPropertyCode(taken({ suggestedCode: 'ACC-LEG2' }))).toEqual({
      area: 'ACC',
      part: 'LEG2',
    });
    // The message alone is not read, and a value that is not a property code is ignored.
    expect(suggestedPropertyCode(taken())).toBeNull();
    expect(suggestedPropertyCode(taken({ suggestedCode: 'not a code' }))).toBeNull();
    expect(suggestedPropertyCode(null)).toBeNull();
  });
});
