const fs = require('fs');
const path = require('path');
const { parseCsv, writeCsv } = require('./urutienda-batch');

function normalizeName(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSheetPrice(value) {
  let s = String(value ?? '').trim();
  if (!s || /#VALUE!/i.test(s)) return null;
  s = s.replace(/\$/g, '').replace(/UYU/gi, '').replace(/\s+/g, '');
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseUruPrice(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : parseSheetPrice(s);
}

function mapHeader(headers, name) {
  const idx = headers.indexOf(name);
  if (idx < 0) throw new Error(`Falta la columna obligatoria: ${name}`);
  return idx;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function ensureParent(file) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
}

function buildMatchReport({ sheetCsv, urutiendaCsv, reportCsv, priceChangesCsv, safePriceChangesCsv, maxAutoPercent = 10 }) {
  const sheetRows = parseCsv(fs.readFileSync(sheetCsv, 'utf8'));
  const uruRows = parseCsv(fs.readFileSync(urutiendaCsv, 'utf8'));
  if (sheetRows.length < 2 || uruRows.length < 2) throw new Error('Alguno de los CSV está vacío.');

  const sh = sheetRows[0];
  const uh = uruRows[0];
  const sName = mapHeader(sh, 'NOMBRE');
  const sCode = sh.indexOf('Codigo');
  const sPrice = mapHeader(sh, 'PRECIO WEB AUTO');
  const uId = mapHeader(uh, 'Producto ID');
  const uName = mapHeader(uh, 'Producto');
  const uPrice = mapHeader(uh, 'Precio producto');

  const sheetItems = sheetRows.slice(1).map((row, i) => ({
    row,
    sheetRow: i + 2,
    name: row[sName] || '',
    code: sCode >= 0 ? (row[sCode] || '') : '',
    priceRaw: row[sPrice] || '',
    norm: normalizeName(row[sName] || '')
  })).filter(x => x.name.trim());

  const uruItems = uruRows.slice(1).map(row => ({
    row,
    id: String(row[uId] || '').trim(),
    name: row[uName] || '',
    priceRaw: row[uPrice] || '',
    norm: normalizeName(row[uName] || '')
  })).filter(x => x.id && x.name.trim());

  const sheetCounts = countBy(sheetItems, x => x.norm);
  const uruCounts = countBy(uruItems, x => x.norm);
  const uruByNorm = new Map();
  for (const item of uruItems) {
    if (!uruByNorm.has(item.norm)) uruByNorm.set(item.norm, []);
    uruByNorm.get(item.norm).push(item);
  }

  const report = [[
    'Fila Sheet','Codigo','NOMBRE Sheet','PRECIO WEB AUTO','Producto ID','Producto UruTienda',
    'Precio UruTienda','Estado','Diferencia precio','Diferencia %','Auto permitido'
  ]];
  const priceChanges = [['Producto ID','Precio producto']];
  const safePriceChanges = [['Producto ID','Precio producto']];
  const summary = {
    sheetNamed: sheetItems.length,
    uruProducts: uruItems.length,
    exactUnique: 0,
    priceDiff: 0,
    safePriceDiff: 0,
    samePrice: 0,
    invalidPrice: 0,
    ambiguous: 0,
    noMatch: 0,
    maxAutoPercent
  };

  for (const s of sheetItems) {
    const candidates = uruByNorm.get(s.norm) || [];
    let status = 'SIN_COINCIDENCIA';
    let u = null;
    let diff = '';
    let pct = '';
    let autoAllowed = 'NO';

    if (candidates.length === 1 && sheetCounts.get(s.norm) === 1 && uruCounts.get(s.norm) === 1) {
      u = candidates[0];
      summary.exactUnique++;
      const sp = parseSheetPrice(s.priceRaw);
      const up = parseUruPrice(u.priceRaw);
      if (sp == null || up == null || sp <= 0 || up <= 0) {
        status = 'COINCIDENCIA_SEGURA_PRECIO_INVALIDO';
        summary.invalidPrice++;
      } else if (Math.abs(sp - up) < 0.001) {
        status = 'COINCIDENCIA_SEGURA_SIN_CAMBIO';
        summary.samePrice++;
        diff = '0';
        pct = '0';
      } else {
        const difference = sp - up;
        const percent = Math.abs(difference) / up * 100;
        diff = String(difference);
        pct = percent.toFixed(2);
        summary.priceDiff++;
        priceChanges.push([u.id, sp.toFixed(2)]);
        if (percent <= maxAutoPercent) {
          status = 'COINCIDENCIA_SEGURA_PRECIO_DISTINTO_CONTROLADO';
          autoAllowed = 'SI';
          summary.safePriceDiff++;
          safePriceChanges.push([u.id, sp.toFixed(2)]);
        } else {
          status = 'COINCIDENCIA_SEGURA_PRECIO_DISTINTO_REVISAR';
        }
      }
    } else if (candidates.length > 0) {
      status = 'AMBIGUA_DUPLICADA';
      summary.ambiguous++;
    } else {
      summary.noMatch++;
    }

    report.push([
      s.sheetRow, s.code, s.name, s.priceRaw,
      u ? u.id : '', u ? u.name : '', u ? u.priceRaw : '', status, diff, pct, autoAllowed
    ]);
  }

  ensureParent(reportCsv);
  ensureParent(priceChangesCsv);
  ensureParent(safePriceChangesCsv);
  fs.writeFileSync(reportCsv, writeCsv(report), 'utf8');
  fs.writeFileSync(priceChangesCsv, writeCsv(priceChanges), 'utf8');
  fs.writeFileSync(safePriceChangesCsv, writeCsv(safePriceChanges), 'utf8');
  return { ...summary, reportCsv, priceChangesCsv, safePriceChangesCsv };
}

if (require.main === module) {
  const [sheetCsv, urutiendaCsv, reportCsv = 'output/match-report.csv', priceChangesCsv = 'output/price-changes.csv', safePriceChangesCsv = 'output/safe-price-changes.csv'] = process.argv.slice(2);
  if (!sheetCsv || !urutiendaCsv) {
    console.error('Uso: node src/match-products.js <sheet.csv> <urutienda.csv> [reporte.csv] [cambios.csv] [cambios-seguros.csv]');
    process.exit(1);
  }
  const result = buildMatchReport({ sheetCsv, urutiendaCsv, reportCsv, priceChangesCsv, safePriceChangesCsv });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { normalizeName, parseSheetPrice, parseUruPrice, buildMatchReport };
