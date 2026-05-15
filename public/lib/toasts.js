import { toast } from "sonner";

export function showToast(message) {
  toast(message, {
    duration: 2600,
    style: {
      background: "#17211b",
      color: "#f3e9d2",
      border: "1px solid #2f3a32",
    },
    className: "sonner-toast",
    descriptionClassName: "text-[#d8cdb4]",
  });
}
