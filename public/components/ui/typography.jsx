import { cn } from "@/lib/utils";

export function Eyebrow({ className, children, as: As = "p", ...props }) {
  return <As className={cn("uppercase font-bold text-amber text-[0.62rem] tracking-[0.14em]", className)} {...props}>{children}</As>;
}
export function DisplayTitle({ className, children, as: As = "h1", level = 1, ...props }) {
  const sizes = {
    1: "text-[clamp(1.4rem,1.6vw,2rem)] leading-[0.95] tracking-[-0.01em]",
    2: "text-[clamp(1.25rem,1.4vw,1.7rem)] leading-[1.02]",
    3: "text-[clamp(1.05rem,1.2vw,1.35rem)] leading-[1.08]",
  };
  return <As className={cn("font-display font-[760] text-ink", sizes[level] || sizes[1], className)} {...props}>{children}</As>;
}
export function MonoText({ className, children, as: As = "span", ...props }) {
  return <As className={cn("font-mono text-[0.72rem] text-muted", className)} {...props}>{children}</As>;
}
