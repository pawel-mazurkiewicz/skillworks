// public/lib/state.js — Event bus + React hooks for bridging React ↔ legacy app.js state.
// Simple browser-compatible event emitter (no Node.js dependency).

class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(name, handler) {
    if (!this._handlers.has(name)) {
      this._handlers.set(name, new Set());
    }
    this._handlers.get(name).add(handler);
    return () => this.off(name, handler);
  }

  off(name, handler) {
    const handlers = this._handlers.get(name);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this._handlers.delete(name);
    }
  }

  emit(name, ...args) {
    const handlers = this._handlers.get(name);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(...args); } catch (e) { console.error(`EventBus error in "${name}":`, e); }
      }
    }
    return this;
  }
}

export const events = new EventBus();

export function emit(name, payload) {
  events.emit(name, payload);
  return events;
}

export function on(name, handler) {
  events.on(name, handler);
  return () => off(name, handler);
}

export function off(name, handler) {
  events.off(name, handler);
}

// ── React hooks ────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";

/**
 * Current active tab. Reads from legacy `state.activeTopTab` on mount,
 * stays in sync via `tab:change` events emitted by React components.
 */
export function useTab() {
  const [tab, setTab] = useState(
    (() => {
      // Read from the legacy state object if available (global window reference)
      try { return window.__skillworksState?.activeTopTab || "manage"; } catch { return "manage"; }
    })()
  );

  useEffect(() => {
    const handler = (t) => setTab(t);
    events.on("tab:change", handler);
    return () => events.off("tab:change", handler);
  }, []);

  const switchTab = useCallback((next) => {
    setTab(next);
    emit("tab:change", next);
  }, []);

  return { tab, switchTab };
}

/**
 * Subscribe to a state snapshot emitted by app.js after every render.
 * Returns the latest snapshot or null.
 */
export function useStateSnapshot() {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    const handler = (data) => setSnapshot(data);
    events.on("state:snapshot", handler);
    // Fire immediately with current state if available
    try {
      const s = window.__skillworksState;
      if (s) setSnapshot({ activeTopTab: s.activeTopTab, search: s.search });
    } catch {}
    return () => events.off("state:snapshot", handler);
  }, []);

  return snapshot;
}
