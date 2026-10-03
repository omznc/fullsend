// Make a LIKE pattern that matches the text as it is. Each of the
// characters \, % and _ gets a backslash. Add ESCAPE '\' to the query.
export const likeContains = (text: string): string =>
  `%${text.replace(/[\\%_]/g, "\\$&")}%`;
