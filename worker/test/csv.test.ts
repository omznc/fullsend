import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "../src/lib/csv";

describe("csvCell", () => {
  it("leaves a plain cell as it is", () => {
    expect(csvCell("hello world")).toBe("hello world");
    expect(csvCell("")).toBe("");
    expect(csvCell("2026-10-01T10:00:00.000Z")).toBe(
      "2026-10-01T10:00:00.000Z",
    );
  });

  it("quotes a comma, a quote and a line break", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it("makes a formula start safe with an apostrophe", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\t=1")).toBe("'\t=1");
    // The text does not start with a formula character: no change.
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("a-b")).toBe("a-b");
  });

  it("quotes after it adds the apostrophe", () => {
    expect(csvCell('=HYPERLINK("http://x.example","go")')).toBe(
      `"'=HYPERLINK(""http://x.example"",""go"")"`,
    );
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
  });
});

describe("csvRow", () => {
  it("joins the cells and ends the line with CRLF", () => {
    expect(csvRow(["a", "b,c", "", "=d"])).toBe('a,"b,c",,\'=d\r\n');
  });
});
