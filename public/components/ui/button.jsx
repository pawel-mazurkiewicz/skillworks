import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-bold",
    "text-sm transition-all duration-150 ease-[var(--ease-paper)]",
    "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
    "disabled:pointer-events-none disabled:opacity-50",
  ),
  {
    variants: {
      variant: {
        secondary: "border-line-strong/80 bg-surface-strong text-ink hover:border-ink shadow-[0_1px_0_rgba(255,255,255,0.76)]",
        primary:   "border-ink bg-ink text-on-ink hover:bg-green hover:border-green",
        ghost:     "border-transparent bg-transparent text-ink hover:border-line",
        danger:    "border-red/40 bg-red-soft text-red hover:border-red",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4",
        lg: "h-11 px-5",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export const Button = forwardRef(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
