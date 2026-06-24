import { describe, it, expect } from "vitest";
import { formatCost } from "./cost";

describe("formatCost", () => {
  it("renders null as the missing-data dash, never $0.00", () => {
    expect(formatCost(null)).toBe("–");
  });

  it("renders a confirmed zero-cost run as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("renders sub-cent costs with 4 decimal places", () => {
    expect(formatCost(0.0013)).toBe("$0.0013");
    expect(formatCost(0.0099)).toBe("$0.0099");
  });

  it("renders costs of a cent or more with 3 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.010");
    expect(formatCost(0.014)).toBe("$0.014");
    expect(formatCost(0.06)).toBe("$0.060");
    expect(formatCost(1.5)).toBe("$1.500");
  });
});
