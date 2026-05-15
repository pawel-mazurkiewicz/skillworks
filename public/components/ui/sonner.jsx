import { Toaster } from "sonner";

export function SonnerToaster({ className }) {
  return (
    <div className={className}>
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 2600,
          style: {
            background: "#17211b",
            color: "#f3e9d2",
            border: "1px solid #2f3a32",
          },
          className: "sonner-toast",
          descriptionClassName: "text-[#d8cdb4]",
        }}
      />
    </div>
  );
}
