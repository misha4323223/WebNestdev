import { describe, expect, it } from "vitest";
import { formatJsonText, nextEditorValue } from "./editor-aids";

function edit(value: string, start: number, end: number, key: string, shiftKey = false) {
  const result = nextEditorValue(value, start, end, key, shiftKey);
  return result ? { ...result, before: result.value.slice(0, result.start), after: result.value.slice(result.end) } : null;
}

describe("помощь редактору", () => {
  it("ставит отступ после Enter и раскрывает парные скобки", () => {
    expect(edit("const x = {}", 11, 11, "Enter")).toMatchObject({
      value: "const x = {\n  \n}",
      start: 14,
    });
    expect(edit("if ()", 4, 4, "Enter")?.value).toBe("if (\n  \n)");
  });

  it("сохраняет отступ строки и закрывает скобки и кавычки", () => {
    expect(edit("  foo", 5, 5, "Enter")?.value).toBe("  foo\n  ");
    expect(edit("const a = ", 10, 10, "(")?.value).toBe("const a = ()");
    expect(edit("const a = ", 10, 10, '"')?.value).toBe('const a = ""');
    expect(edit('const a ="x', 11, 11, '"')).toBeNull();
  });

  it("пропускает уже вставленную закрывающую скобку и удаляет пару", () => {
    expect(edit("()", 1, 1, ")")).toMatchObject({ value: "()", start: 2 });
    expect(edit("()", 1, 1, "Backspace")).toMatchObject({ value: "", start: 0 });
  });

  it("делает Tab и Shift+Tab для выделенных строк", () => {
    expect(edit("a\nb", 0, 3, "Tab")?.value).toBe("  a\n  b");
    expect(edit("  a\n  b", 0, 7, "Tab", true)?.value).toBe("a\nb");
    expect(edit("a", 1, 1, "Tab")?.value).toBe("a  ");
  });

  it("форматирует JSON, а мусор оставляет ошибкой", () => {
    expect(formatJsonText('{"a":1}')).toBe('{\n  "a": 1\n}\n');
    expect(() => formatJsonText("{")).toThrow();
  });
});
