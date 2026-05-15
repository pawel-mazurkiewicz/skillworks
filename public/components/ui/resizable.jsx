import { Panel as RPanel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";

export const ResizablePanelGroup = ({ className, children, ...props }) => (
  <PanelGroup
    className={cn("flex h-full w-full", className)}
    {...props}
  >
    {children}
  </PanelGroup>
);

export const ResizablePanel = ({ className, ...props }) => (
  <RPanel className={cn("min-w-0 min-h-0 overflow-hidden", className)} {...props} />
);

/**
 * ResizableHandle — Drag handle between panels.
 * Styled as a thin ink-tinted groove with expanded grab area.
 */
export function ResizableHandle({ className, ...props }) {
  return (
    <PanelResizeHandle
      className={cn(
        "relative flex items-center justify-center w-[6px] shrink-0",
        "bg-transparent before:absolute before:inset-y-0 before:w-[2px] before:bg-line before:left-1/2 before:-translate-x-1/2",
        "hover:before:bg-ink/40",
        "focus-visible:outline-none focus-visible:before:bg-ink focus-visible:before:w-[3px]",
        "transition-colors duration-150 ease-[var(--ease-paper)]",
        className,
      )}
      {...props}
    />
  );
}
