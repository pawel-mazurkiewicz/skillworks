import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Check } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger ref={ref}
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-sm border border-line-strong/80 bg-surface-strong px-3 text-sm text-ink",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
        "focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/30",
        "disabled:opacity-60",
        className,
      )}
      {...props}>
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown className="h-4 w-4 opacity-70" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content ref={ref} position={position} sideOffset={4}
        className={cn(
          "z-50 min-w-32 overflow-hidden rounded-md border border-line bg-surface shadow-strong",
          className,
        )}
        {...props}>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm text-ink",
        "data-[highlighted]:bg-green-soft data-[highlighted]:outline-none",
        "data-[state=checked]:bg-green-soft/60",
        className,
      )}
      {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto"><Check className="h-4 w-4" /></SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});
