// Builds a CSV string (opens perfectly in Excel / Google Sheets) from an
// array of column headers and an array of row arrays.
function toCsv(headers, rows) {
  const escape = (val) => {
    const s = val === null || val === undefined ? '' : String(val);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.map(escape).join(',')];
  rows.forEach(r => lines.push(r.map(escape).join(',')));
  return '\uFEFF' + lines.join('\r\n'); // \uFEFF = BOM so Excel shows ₹ and other symbols correctly
}

function sendCsv(res, filename, headers, rows) {
  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

module.exports = { toCsv, sendCsv };
