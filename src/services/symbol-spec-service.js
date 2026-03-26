const DEFAULT_SPECS = {
  EURUSD: { pointSize: 0.0001, usdPerPointPerLot: 10, label: '1 pip ≈ $10/lot' },
  GBPUSD: { pointSize: 0.0001, usdPerPointPerLot: 10, label: '1 pip ≈ $10/lot' },
  AUDUSD: { pointSize: 0.0001, usdPerPointPerLot: 10, label: '1 pip ≈ $10/lot' },
  NZDUSD: { pointSize: 0.0001, usdPerPointPerLot: 10, label: '1 pip ≈ $10/lot' },
  USDCHF: { pointSize: 0.0001, usdPerPointPerLot: 10, label: '1 pip ≈ $10/lot' },
  USDJPY: { pointSize: 0.01, usdPerPointPerLot: 9, label: '1 pip ≈ $9/lot' },
  GBPJPY: { pointSize: 0.01, usdPerPointPerLot: 9, label: '1 pip ≈ $9/lot' },
  EURJPY: { pointSize: 0.01, usdPerPointPerLot: 9, label: '1 pip ≈ $9/lot' },
  XAUUSD: { pointSize: 1, usdPerPointPerLot: 100, label: '$1 move ≈ $100/lot' },
};

function loadSymbolSpecs() {
  const raw = process.env.YBX_SYMBOL_SPECS_JSON;
  if (!raw) return { ...DEFAULT_SPECS };

  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SPECS, ...parsed };
  } catch {
    return { ...DEFAULT_SPECS };
  }
}

function getSymbolSpec(symbol) {
  const specs = loadSymbolSpecs();
  return specs[String(symbol || '').toUpperCase()] || null;
}

module.exports = {
  DEFAULT_SPECS,
  loadSymbolSpecs,
  getSymbolSpec,
};
