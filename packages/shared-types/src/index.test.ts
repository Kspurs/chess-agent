import { describe, expect, it } from "vitest";
import { normalizePageRequest, parseId } from "./index.js";

describe("shared transport types", () => {
  it("normalizes pagination", () => {
    expect(normalizePageRequest()).toEqual({ limit: 20 });
    expect(normalizePageRequest({ cursor: "next", limit: 5 })).toEqual({ cursor: "next", limit: 5 });
  });

  it("rejects unsafe IDs and page sizes", () => {
    expect(() => parseId("contains spaces", "game id")).toThrow(TypeError);
    expect(() => normalizePageRequest({ limit: 101 })).toThrow(RangeError);
  });
});

