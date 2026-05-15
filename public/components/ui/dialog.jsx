// public/components/ui/dialog.jsx — Radix Dialog wrapper.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogOverlay = DialogPrimitive.Overlay;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef(function DialogContent(
  { className, children, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%]",
        "gap-4 border border-line bg-surface p-6 shadow-elev sm:rounded-lg",
        "motion-safe:animate-in motion-safe:duration-200 motion-safe:ease-[var(--ease-paper)]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 disabled:pointer-events-none"
        onClick={(e) => {
          e.stopPropagation();
          DialogPrimitive.Close.props.onClick?.(e);
        }}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  );
});

export const DialogHeader = ({ className, ...props }) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
    {...props}
  />
);
export const DialogFooter = ({ className, ...props }) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
