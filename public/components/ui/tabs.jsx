import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

/**
 * TabsList — Container for tab triggers. Styled to match the editorial grid layout.
 */
export const TabsList = forwardRef(function TabsList({ className, children, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "grid w-full gap-2 rounded-lg border border-line bg-surface p-2",
        "grid-cols-[repeat(auto-fill,minmax(0,1fr))]",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.List>
  );
});

/**
 * TabsTrigger — Individual tab button. Active state uses ink bg + on-ink text.
 */
export const TabsTrigger = forwardRef(function TabsTrigger({ className, children, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "group flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded border border-transparent",
        "px-3 py-2 text-left text-muted transition-all duration-150 ease-[var(--ease-paper)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40",
        "data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-on-ink",
        "data-[state=inactive]:hover:border-line data-[state=inactive]:hover:text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
});
