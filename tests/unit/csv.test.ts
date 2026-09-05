import { describe, expect, it } from "vitest";
import { toCsv } from "@/lib/firetrace/csv";

describe("toCsv", () => {
  it("quotes only what needs quoting and ends every line with CRLF", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          ["plain", 1],
          ["has,comma", true],
          ["multi\nline", null],
        ],
      ),
    ).toBe('a,b\r\nplain,1\r\n"has,comma",true\r\n"multi\nline",\r\n');
    expect(toCsv(["q"], [['say "hi"']])).toBe('q\r\n"say ""hi"""\r\n');
  });

  it("neutralizes spreadsheet formulas", () => {
    expect(toCsv(["v"], [["=SUM(A1)"], ["+1"], ["-1"], ["@cmd"], ["1-2"]])).toBe(
      "v\r\n'=SUM(A1)\r\n'+1\r\n'-1\r\n'@cmd\r\n1-2\r\n",
    );
  });

  it("writes an empty body for no rows", () => {
    expect(toCsv(["id", "name"], [])).toBe("id,name\r\n");
  });
});
