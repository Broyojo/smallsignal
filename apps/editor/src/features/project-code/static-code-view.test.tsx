import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticCodeView } from "./static-code-view";

/** The gutter's and the code's markup, without the frame around them. */
function parts(value: string) {
  const html = renderToStaticMarkup(
    <StaticCodeView ariaLabel="Loading code" value={value} />,
  );
  const [, gutter, content] =
    /<div class="static-code-gutter" aria-hidden="true">(.*)<\/div><div class="static-code-content">(.*)<\/div><\/div><\/div>$/su.exec(
      html,
    )!;
  return { gutter, content };
}

describe("code shown before the code editor loads", () => {
  it("numbers every line the editor will number, a trailing empty one too", () => {
    expect(parts(".subckt dut\r\n.ends dut\n")).toEqual({
      gutter: '<div class="static-code-active">1</div><div>2\n3</div>',
      content:
        '<div class="static-code-active">.subckt dut</div><div>.ends dut\n</div>',
    });
  });

  it("keeps an empty first line, and empty text, one line high", () => {
    expect(parts("\nR1 a b 1k")).toEqual({
      gutter: '<div class="static-code-active">1</div><div>2</div>',
      content:
        '<div class="static-code-active"><br/></div><div>R1 a b 1k</div>',
    });
    expect(parts("")).toEqual({
      gutter: '<div class="static-code-active">1</div>',
      content: '<div class="static-code-active"><br/></div>',
    });
  });
});
