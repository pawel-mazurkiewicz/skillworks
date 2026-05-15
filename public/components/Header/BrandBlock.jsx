import { cn } from "@/lib/utils";
import { Eyebrow, DisplayTitle } from "@/components/ui/typography";

/**
 * BrandBlock — Ink spine + Skillworks icon + Eyebrow + DisplayTitle.
 * Matches the editorial paper-feel: 3px ink spine, tight Fraunces display type.
 */
export function BrandBlock({ className }) {
  return (
    <div
      data-ink-spine="true"
      className={cn(
        "flex items-center gap-3",
        "border-l-[3px] border-ink pl-3 py-1",
        className,
      )}
    >
      <img
        src="/icon_256.png"
        alt="Skillworks icon"
        width="44"
        height="44"
        className="flex-shrink-0 w-[44px] h-[44px]"
      />
      <div className="flex flex-col gap-0">
        <Eyebrow className="text-[0.6rem] tracking-[0.16em]">Skill workspace</Eyebrow>
        <DisplayTitle level={2} className="leading-[1] tracking-[-0.01em]">
          Skillworks
        </DisplayTitle>
      </div>
    </div>
  );
}
