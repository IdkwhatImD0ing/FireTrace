/**
 * Minimal CSV writer for exports: RFC 4180 quoting, CRLF line ends, and a
 * leading apostrophe on cells that spreadsheets would otherwise evaluate as
 * formulas (values starting with =, +, - or @), since trace names and ids are
 * caller-controlled text.
 */

export type CsvValue = string | number | boolean | null | undefined;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: ReadonlyArray<CsvValue[]>): string {
  const lines = [columns.map(cell).join(","), ...rows.map((row) => row.map(cell).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}
