import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SeverityFilterBar } from "./SeverityFilterBar";

afterEach(cleanup);

const COUNTS = { CRITICAL: 2, WARNING: 5, SUGGESTION: 1 };

describe("SeverityFilterBar", () => {
  it("renders a pill for each severity with a non-zero count", () => {
    render(<SeverityFilterBar counts={COUNTS} active={null} onToggle={vi.fn()} />);
    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Suggestion")).toBeInTheDocument();
  });

  it("renders correct counts", () => {
    render(<SeverityFilterBar counts={COUNTS} active={null} onToggle={vi.fn()} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("hides a pill when its count is 0", () => {
    render(<SeverityFilterBar counts={{ CRITICAL: 0, WARNING: 3, SUGGESTION: 0 }} active={null} onToggle={vi.fn()} />);
    expect(screen.queryByText("Critical")).not.toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.queryByText("Suggestion")).not.toBeInTheDocument();
  });

  it("returns null when all counts are 0", () => {
    const { container } = render(
      <SeverityFilterBar counts={{ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 }} active={null} onToggle={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("marks the active pill with aria-pressed=true", () => {
    render(<SeverityFilterBar counts={COUNTS} active="CRITICAL" onToggle={vi.fn()} />);
    const pills = screen.getAllByRole("button");
    const critPill = pills.find((p) => p.textContent?.includes("Critical"))!;
    expect(critPill).toHaveAttribute("aria-pressed", "true");
    const warnPill = pills.find((p) => p.textContent?.includes("Warning"))!;
    expect(warnPill).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onToggle with the severity key when an inactive pill is clicked", () => {
    const onToggle = vi.fn();
    render(<SeverityFilterBar counts={COUNTS} active={null} onToggle={onToggle} />);
    fireEvent.click(screen.getByText("Warning").closest("button")!);
    expect(onToggle).toHaveBeenCalledWith("WARNING");
  });

  it("calls onToggle(null) when the active pill is clicked again (deselect)", () => {
    const onToggle = vi.fn();
    render(<SeverityFilterBar counts={COUNTS} active="CRITICAL" onToggle={onToggle} />);
    fireEvent.click(screen.getByText("Critical").closest("button")!);
    expect(onToggle).toHaveBeenCalledWith(null);
  });
});
