import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RunCostBadge } from "./RunCostBadge";

afterEach(cleanup);

describe("RunCostBadge", () => {
  it("compact: renders the formatted cost", () => {
    render(<RunCostBadge variant="compact" usd={0.014} />);
    expect(screen.getByText("$0.014")).toBeInTheDocument();
  });

  it("compact: renders the missing-data dash for null", () => {
    render(<RunCostBadge variant="compact" usd={null} />);
    expect(screen.getByText("–")).toBeInTheDocument();
  });

  it("withTokens: renders token total + cost", () => {
    render(<RunCostBadge variant="withTokens" usd={0.0013} tokensIn={9000} tokensOut={119} />);
    expect(screen.getByText(`${(9000 + 119).toLocaleString()} tok · $0.0013`)).toBeInTheDocument();
  });

  it("withTokens: renders nothing when there are no tokens", () => {
    const { container } = render(<RunCostBadge variant="withTokens" usd={null} tokensIn={0} tokensOut={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
