import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";

export function FromURL({ onPreview, onInstall }) {
  const [skillUrl, setSkillUrl] = useState("");

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path fill="currentColor" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <h2 className="text-lg font-display font-bold text-ink">From URL</h2>
        </div>
        <p className="text-sm text-muted">Add a skill directly from a raw markdown URL.</p>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onInstall?.({ url: skillUrl.trim() });
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Raw markdown URL
            </label>
            <Input
              value={skillUrl}
              onChange={(e) => setSkillUrl(e.target.value)}
              placeholder="https://raw.githubusercontent.com/..."
              aria-label="Raw markdown URL"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => onPreview?.({ url: skillUrl.trim() })}
              variant="secondary"
              size="sm"
            >
              Preview
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!skillUrl.trim()}
            >
              Add skill
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
