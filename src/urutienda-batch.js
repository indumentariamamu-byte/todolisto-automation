const fs = require('fs');

function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(rows) {
  return '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
}

function keyFor(productId, variantId = '') {
  return `${String(productId || '').trim()}::${String(variantId || '').trim()}`;
}

/**
 * Aplica cambios provenientes de un CSV/Sheet sobre un export actual de UruTienda.
 *
 * Reglas de seguridad:
 * - Producto ID es obligatorio en cambios.
 * - Variante ID es opcional, pero permite identificar variantes con precisión.
 * - Celdas vacías en el archivo de cambios NO borran datos: significan "no tocar".
 * - Solo se aceptan columnas que existan en el export base.
 * - La salida contiene únicamente las filas realmente modificadas, con el encabezado completo de UruTienda.
 */
function updateBatch({ baseCsv, changesCsv, outputCsv }) {
  const baseRows = parseCsv(fs.readFileSync(baseCsv, 'utf8'));
  const changeRows = parseCsv(fs.readFileSync(changesCsv, 'utf8'));

  if (baseRows.length < 2) throw new Error('El export base de UruTienda está vacío.');
  if (changeRows.length < 2) throw new Error('El archivo de cambios no contiene productos.');

  const baseHeaders = baseRows[0];
  const changeHeaders = changeRows[0];

  const baseProductId = baseHeaders.indexOf('Producto ID');
  const baseVariantId = baseHeaders.indexOf('Variante ID');
  const changeProductId = changeHeaders.indexOf('Producto ID');
  const changeVariantId = changeHeaders.indexOf('Variante ID');

  if (baseProductId < 0 || changeProductId < 0) {
    throw new Error('La columna Producto ID es obligatoria.');
  }

  const baseColumnIndex = new Map(baseHeaders.map((h, i) => [h, i]));
  const allowedChangeColumns = changeHeaders.filter(h => h && h !== 'Producto ID' && h !== 'Variante ID');

  for (const header of allowedChangeColumns) {
    if (!baseColumnIndex.has(header)) {
      throw new Error(`Columna no válida para UruTienda: ${header}`);
    }
  }

  const baseByExactKey = new Map();
  const baseByProductId = new Map();

  for (let i = 1; i < baseRows.length; i++) {
    const row = baseRows[i];
    const productId = row[baseProductId] || '';
    const variantId = baseVariantId >= 0 ? (row[baseVariantId] || '') : '';
    const exact = keyFor(productId, variantId);
    baseByExactKey.set(exact, { row, index: i });

    const pid = String(productId).trim();
    if (!baseByProductId.has(pid)) baseByProductId.set(pid, []);
    baseByProductId.get(pid).push({ row, index: i });
  }

  const changedRows = [];
  const report = [];
  const usedBaseIndexes = new Set();

  for (let i = 1; i < changeRows.length; i++) {
    const change = changeRows[i];
    const productId = String(change[changeProductId] || '').trim();
    const variantId = changeVariantId >= 0 ? String(change[changeVariantId] || '').trim() : '';

    if (!productId) throw new Error(`Fila ${i + 1}: falta Producto ID.`);

    let target;
    if (variantId) {
      target = baseByExactKey.get(keyFor(productId, variantId));
      if (!target) throw new Error(`Fila ${i + 1}: no existe Producto ID ${productId} / Variante ID ${variantId}.`);
    } else {
      const candidates = baseByProductId.get(productId) || [];
      if (candidates.length !== 1) {
        throw new Error(`Fila ${i + 1}: Producto ID ${productId} tiene ${candidates.length} filas en UruTienda. Agregá Variante ID para identificarla sin riesgo.`);
      }
      target = candidates[0];
    }

    if (usedBaseIndexes.has(target.index)) {
      throw new Error(`Fila ${i + 1}: el mismo producto/variante aparece más de una vez en cambios.`);
    }
    usedBaseIndexes.add(target.index);

    const updated = [...target.row];
    const changedColumns = [];

    for (let c = 0; c < changeHeaders.length; c++) {
      const header = changeHeaders[c];
      if (!header || header === 'Producto ID' || header === 'Variante ID') continue;
      const value = change[c] == null ? '' : String(change[c]);
      if (value === '') continue;

      const baseIndex = baseColumnIndex.get(header);
      if (String(updated[baseIndex] ?? '') !== value) {
        updated[baseIndex] = value;
        changedColumns.push(header);
      }
    }

    if (changedColumns.length) {
      changedRows.push(updated);
      report.push({ productId, variantId, changedColumns });
    }
  }

  fs.writeFileSync(outputCsv, writeCsv([baseHeaders, ...changedRows]), 'utf8');

  return {
    requested: changeRows.length - 1,
    updated: changedRows.length,
    unchanged: (changeRows.length - 1) - changedRows.length,
    outputCsv,
    report
  };
}

module.exports = { parseCsv, writeCsv, updateBatch };
