import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "./theme-provider";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
];

export function ThemeToggle({ className }) {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className={cn("inline-flex items-center gap-1 rounded-md border border-line bg-surface-strong p-0.5", className)}>
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button key={value} role="radio" aria-checked={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40",
            theme === value && "bg-ink text-on-ink",
          )} title={label}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
