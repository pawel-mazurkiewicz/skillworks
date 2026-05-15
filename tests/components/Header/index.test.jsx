import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Header } from "@/components/Header";

// Mock child components
vi.mock("@/components/Header/BrandBlock", () => ({
  BrandBlock: () => <div data-testid="brand-block">Brand</div>,
}));
vi.mock("@/components/Header/TopTabs", () => ({
  TopTabs: () => <div data-testid="top-tabs">Tabs</div>,
}));
vi.mock("@/components/Header/ProjectRow", () => ({
  ProjectRow: ({ projectPath }) => <div data-testid="project-row">Project: {projectPath}</div>,
}));
vi.mock("@/components/Header/SearchRow", () => ({
  SearchRow: ({ searchValue }) => <div data-testid="search-row">Search: {searchValue}</div>,
}));

describe("Header", () => {
  it("renders all sections on manage tab", () => {
    render(<Header activeTab="manage" projectPath="/test" searchValue="" onProjectChange={() => {}} onSearchChange={() => {}} />);
    expect(screen.getByTestId("brand-block")).toBeInTheDocument();
    expect(screen.getByTestId("top-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("project-row")).toBeInTheDocument();
    expect(screen.getByTestId("search-row")).toBeInTheDocument();
  });

  it("hides SearchRow on non-manage tabs", () => {
    render(<Header activeTab="install" projectPath="" searchValue="" onProjectChange={() => {}} onSearchChange={() => {}} />);
    expect(screen.queryByTestId("search-row")).not.toBeInTheDocument();
  });

  it("shows SearchRow on manage tab", () => {
    render(<Header activeTab="manage" projectPath="" searchValue="" onProjectChange={() => {}} onSearchChange={() => {}} />);
    expect(screen.getByTestId("search-row")).toBeInTheDocument();
  });

  it("applies data-active-tab attribute", () => {
    const { container } = render(<Header activeTab="sets" projectPath="" searchValue="" onProjectChange={() => {}} onSearchChange={() => {}} />);
    const wrapper = container.querySelector('[data-active-tab="sets"]');
    expect(wrapper).toBeTruthy();
  });
});
