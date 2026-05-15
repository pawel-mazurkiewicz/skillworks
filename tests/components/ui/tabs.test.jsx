import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

describe("Tabs primitive", () => {
  it("renders active trigger and content", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
        <TabsContent value="b">Content B</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText("Content A")).toBeInTheDocument();
  });

  it("switches content on trigger click", async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
        <TabsContent value="b">Content B</TabsContent>
      </Tabs>,
    );
    await userEvent.click(screen.getByText("B"));
    expect(screen.getByText("Content B")).toBeInTheDocument();
  });

  it("fires onValueChange", async () => {
    const onChange = vi.fn();
    render(
      <Tabs defaultValue="a" onValueChange={onChange}>
        <TabsList aria-label="sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>,
    );
    await userEvent.click(screen.getByText("B"));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
