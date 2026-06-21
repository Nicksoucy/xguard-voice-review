/**
 * lib/format-utils.js — Utilitaires de formatage PURS, partages par toutes les pages.
 *   - esc      : echappement HTML (anti-XSS) — UNE seule implementation pour tout le repo
 *   - csvEscape / rowsToCSV : export CSV RFC 4180
 *   - fmtDate  : date lisible fr-CA
 * Export double navigateur (window.XGFormat) / Node (require).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Echappe les caracteres dangereux avant injection dans innerHTML.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ESC_MAP[c];
    });
  }

  // Echappe une valeur pour une cellule CSV (RFC 4180).
  function csvEscape(val) {
    if (val === null || val === undefined) return '';
    var s = String(val);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // Construit un CSV a partir de lignes (objets) et d'une liste de colonnes.
  function rowsToCSV(rows, columns) {
    if (!rows || !rows.length) return columns.join(',') + '\n';
    var lines = [columns.join(',')];
    rows.forEach(function (r) {
      lines.push(
        columns
          .map(function (c) {
            return csvEscape(r[c]);
          })
          .join(','),
      );
    });
    return lines.join('\n');
  }

  // Date lisible fr-CA, tolerante aux valeurs invalides.
  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return iso;
    }
  }

  return { esc: esc, csvEscape: csvEscape, rowsToCSV: rowsToCSV, fmtDate: fmtDate };
});
