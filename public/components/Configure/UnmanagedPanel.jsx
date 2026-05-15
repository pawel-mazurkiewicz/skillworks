import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function UnmanagedPanel() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M8 6h12" />
            <path fill="currentColor" d="M6 12h12" />
            <path fill="currentColor" d="M4 18h12" />
          </svg>
          <h3 className="text-base font-display font-bold text-ink">Unmanaged folders</h3>
        </div>
        <p className="text-xs text-muted">Skill folders Claude can see but the vault doesn't track.</p>
      </CardHeader>
      <CardContent>
        <ul id="unmanagedList" className="space-y-1 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
          {/* Legacy unmanaged list rendered here */}
        </ul>
      </CardContent>
    </Card>
  );
}
