import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef(function Input({ className, leading, type = "text", ...props }, ref) {
  return (
    <div className="relative w-full">
      {leading && (<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">{leading}</span>)}
      <input ref={ref} type={type}
        className={cn(
          "w-full min-h-9 rounded-sm border border-line-strong/80 bg-surface-strong",
          "px-3 py-2 text-sm text-ink",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
          "placeholder:text-muted/70",
          "transition-colors duration-150 ease-[var(--ease-paper)]",
          "focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/30",
          "disabled:opacity-60",
          leading && "pl-9",
          className,
        )}
        {...props} />
    </div>
  );
});
