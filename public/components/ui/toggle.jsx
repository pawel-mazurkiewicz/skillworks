import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Toggle = forwardRef(function Toggle({ className, variant = "default", ...props }, ref) {
  return (
    <SwitchPrimitive.Root ref={ref} data-variant={variant}
      className={cn(
        "peer inline-flex h-[30px] w-[54px] shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-surface-mute/70",
        "transition-colors duration-150 ease-[var(--ease-paper)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        "data-[state=checked]:border-ink data-[state=checked]:bg-green",
        variant === "conflict" && "data-[state=checked]:border-red data-[state=checked]:bg-red-soft",
        "disabled:opacity-50",
        className,
      )}
      {...props}>
      <SwitchPrimitive.Thumb className={cn(
        "pointer-events-none block h-[22px] w-[22px] rounded-full bg-on-ink",
        "shadow-[0_4px_10px_rgba(23,33,27,0.18)]",
        "translate-x-1 transition-transform duration-150 ease-[var(--ease-paper)]",
        "data-[state=checked]:translate-x-[27px]",
      )} />
    </SwitchPrimitive.Root>
  );
});
