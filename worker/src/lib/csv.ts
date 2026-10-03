// CSV output for the exports. Each cell is escaped by RFC 4180, and a
// formula start is made safe.

// The most rows that one export has.
export const MAX_EXPORT_ROWS = 50_000;

// The rows that one chunk of an export reads.
export const EXPORT_CHUNK = 500;

// A spreadsheet reads a cell that starts with one of these characters as a
// formula. A tab or a carriage return can hide the start.
const FORMULA_START = /^[=+\-@\t\r]/;

// The text of one cell. A cell that starts a formula gets an apostrophe
// first. A cell with a quote, a comma or a line break gets quotes, and
// each quote inside doubles.
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;

  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

// One line, with the line break at the end.
export const csvRow = (cells: string[]): string =>
  `${cells.map(csvCell).join(",")}\r\n`;

// A CSV file that the Worker writes in chunks. `next` gives the rows of
// the next chunk, or null at the end. The Worker reads the next chunk only
// when the client takes the data, so the file is never in memory at once.
// The file starts with a byte order mark, so Excel reads UTF-8.
export function csvResponse(
  filename: string,
  header: string[],
  next: () => Promise<string[][] | null>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`﻿${csvRow(header)}`));
    },
    async pull(controller) {
      const rows = await next();

      if (!rows) {
        controller.close();

        return;
      }

      controller.enqueue(encoder.encode(rows.map(csvRow).join("")));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
