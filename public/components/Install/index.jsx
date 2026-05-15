import { useState, useEffect } from "react";
import { FromFolder } from "./FromFolder";
import { FromGit } from "./FromGit";
import { FromURL } from "./FromURL";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function InstallTab() {
  const [activeSection, setActiveSection] = useState("folder");
  const [discoveryItems, setDiscoveryItems] = useState([]);
  const [discoverySummary, setDiscoverySummary] = useState("");

  useEffect(() => {
    // Load discovery data
    loadDiscovery();
  }, []);

  async function loadDiscovery() {
    try {
      const response = await fetch("/api/discovery");
      if (response.ok) {
        const data = await response.json();
        setDiscoveryItems(data.items || []);
        setDiscoverySummary(data.summary || "No skills discovered.");
      }
    } catch (e) {
      console.error("Failed to load discovery:", e);
      setDiscoverySummary("Unable to scan for skills.");
    }
  }

  return (
    <div className="tab-grid install-stack p-6 max-w-7xl mx-auto">
      {/* From Folder Section */}
      <section className="panel">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
              </svg>
              <h2 className="text-lg font-display font-bold text-ink">From local folder</h2>
            </div>
            <p className="text-sm text-muted">Move skills from another location into the vault.</p>
          </CardHeader>
          <CardContent>
            <FromFolder />
          </CardContent>
        </Card>
      </section>

      {/* From Git Section */}
      <section className="panel">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M9 16V6a3 3 0 0 1 6 0v10a3 3 0 0 1-6 0Zm9-5h-2.5a2.5 2.5 0 0 0-2.5 2.5V14h5V8.5A2.5 2.5 0 0 0 16 6H19Z" />
              </svg>
              <h2 className="text-lg font-display font-bold text-ink">From Git</h2>
            </div>
            <p className="text-sm text-muted">Clone a repo and install the skills it ships.</p>
          </CardHeader>
          <CardContent>
            <FromGit />
          </CardContent>
        </Card>
      </section>

      {/* From URL Section */}
      <section className="panel">
        <Card>
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
            <FromURL />
          </CardContent>
        </Card>
      </section>

      {/* Discovery Section */}
      <section className="panel span-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
                <path fill="currentColor" d="M21 21l-6 -6" />
              </svg>
              <h2 className="text-lg font-display font-bold text-ink">Discovery</h2>
            </div>
            <p className="text-sm text-muted">
              Skills detected on this machine that aren't in the vault yet.
            </p>
          </CardHeader>
          <CardContent>
            <div className="discovery-summary text-sm text-amber mb-3">{discoverySummary}</div>
            <div className="discovery-list space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {discoveryItems.length === 0 ? (
                <p className="text-sm text-muted">No skills found. Run a scan to discover skills.</p>
              ) : (
                discoveryItems.map((item) => (
                  <div key={item.id} className="flex items-center justify-between p-3 bg-surface-mute rounded border border-line/60">
                    <div className="min-w-0">
                      <div className="font-medium text-ink truncate">{item.name}</div>
                      <div className="text-xs text-muted truncate">{item.path}</div>
                    </div>
                    <button
                      type="button"
                      className="btn-sm btn-primary ml-3 whitespace-nowrap"
                      onClick={() => {}}
                    >
                      Add to vault
                    </button>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
