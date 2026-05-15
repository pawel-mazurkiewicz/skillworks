import { useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * DetailPane — Skill detail panel that adopts the legacy #skillDetail DOM node.
 *
 * During migration, the skill preview body is still rendered imperatively by app.js
 * into #skillDetail. We adopt that node via ref.appendChild to avoid re-introducing
 * dangerouslySetInnerHTML. The empty state is rendered natively by React.
 */
export function DetailPane({ className }) {
  const hostRef = useRef(null);

  useEffect(() => {
    // Adopt the legacy skillDetail node into our React tree
    const legacy = document.getElementById("skillDetail");
    const emptyLegacy = document.getElementById("emptyDetail");

    if (hostRef.current && legacy) {
      // Move the legacy detail card into our host
      if (legacy.parentNode && !hostRef.current.contains(legacy)) {
        hostRef.current.appendChild(legacy);
      }
    }

    // Hide the legacy empty detail (we render our own)
    if (emptyLegacy) {
      emptyLegacy.hidden = true;
    }
  }, []);

  return (
    <Card className={className}>
      <CardContent className="p-0">
        {/* Empty state — shown when no skill selected */}
        <div className="flex flex-col gap-2 p-5 text-center">
          <h2 className="m-0 font-display font-[760] text-base text-ink">
            Select a skill
          </h2>
          <p className="m-0 text-muted leading-relaxed">
            Assignment switches and documentation open here.
          </p>
        </div>

        {/* Host for legacy skill detail node */}
        <div ref={hostRef} className="skill-detail-host" />
      </CardContent>
    </Card>
  );
}
