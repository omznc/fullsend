// The SQL test "the column contains the text", with no case rule beyond
// ASCII, as LIKE has. Bind the text once for each use. D1 allows 50 bytes
// in a LIKE pattern, so a LIKE search with a long text fails. instr() has
// no such limit and needs no escape for \, % and _.
export const containsSql = (column: string): string =>
  `instr(lower(${column}), lower(?)) > 0`;
