import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "@/lib/utils";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

/**
 * CollapsibleContent — Animated content wrapper.
 * Uses Radix CSS variables for smooth width/height transitions.
 */
export function CollapsibleContent({ className, children, ...props }) {
  return (
    <CollapsiblePrimitive.Content
      className={cn(
        "overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
        className,
      )}
      {...props}
    >
      {children}
    </CollapsiblePrimitive.Content>
  );
}
