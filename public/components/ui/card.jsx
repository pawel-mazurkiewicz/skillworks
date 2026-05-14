import { cn } from "@/lib/utils";

export function Card({ className, accent, children, ...props }) {
  return (
    <div data-accent={accent ? "true" : undefined}
      className={cn(
        "relative overflow-hidden rounded-lg border border-line bg-surface shadow-soft",
        accent && "before:absolute before:inset-x-0 before:top-0 before:h-[5px] before:bg-[linear-gradient(90deg,var(--color-blue),var(--color-green),var(--color-gold))]",
        className,
      )}
      {...props}
    >{children}</div>
  );
}
export const CardHeader = ({ className, ...p }) => <div className={cn("flex items-start justify-between gap-3 p-5", className)} {...p} />;
export const CardContent = ({ className, ...p }) => <div className={cn("px-5 pb-5", className)} {...p} />;
export const CardFooter = ({ className, ...p }) => <div className={cn("flex items-center gap-2 border-t border-line bg-surface-mute px-5 py-3", className)} {...p} />;
