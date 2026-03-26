const test = require('node:test');
const assert = require('node:assert/strict');

const { getSymbolSpec, loadSymbolSpecs } = require('../src/services/symbol-spec-service');

test('getSymbolSpec returns defaults for known symbols', () => {
  const spec = getSymbolSpec('XAUUSD');
  assert.equal(spec.pointSize, 1);
  assert.equal(spec.usdPerPointPerLot, 100);
});

test('loadSymbolSpecs honors env overrides', () => {
  const previous = process.env.YBX_SYMBOL_SPECS_JSON;
  process.env.YBX_SYMBOL_SPECS_JSON = JSON.stringify({
    XAUUSD: { pointSize: 0.5, usdPerPointPerLot: 50, label: 'custom' },
  });

  const specs = loadSymbolSpecs();
  assert.equal(specs.XAUUSD.pointSize, 0.5);
  assert.equal(specs.XAUUSD.usdPerPointPerLot, 50);

  if (previous === undefined) delete process.env.YBX_SYMBOL_SPECS_JSON;
  else process.env.YBX_SYMBOL_SPECS_JSON = previous;
});
