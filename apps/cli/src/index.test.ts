import { describe, expect, it } from "vitest";
import { renderFen } from "./index.js";

describe("CLI board renderer", () => {
  it("renders ranks, files, and pieces", () => {
    const output = renderFen("8/8/8/3k4/8/8/4K3/8 w - - 0 1");
    expect(output).toContain("5  · · · ♚");
    expect(output).toContain("2  · · · · ♔");
    expect(output).toContain("a b c d e f g h");
  });
});

