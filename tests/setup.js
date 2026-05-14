import "@testing-library/jest-dom/vitest";

// Mock localStorage for jsdom (Node 20+ requires --localstorage-file)
const localStorageMock = {
  data: new Map(),
  getItem(key) { return this.data.get(key) ?? null; },
  setItem(key, value) { this.data.set(key, String(value)); },
  removeItem(key) { this.data.delete(key); },
  clear() { this.data.clear(); },
  get length() { return this.data.size; },
  key(i) { return [...this.data.keys()][i] ?? null; },
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// Mock matchMedia for jsdom
Object.defineProperty(globalThis, "matchMedia", {
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  writable: true,
});

// Mock pointer capture APIs for Radix UI (jsdom doesn't implement them)
["hasPointerCapture", "setPointerCapture", "releasePointerCapture"].forEach((method) => {
  if (!Element.prototype[method]) {
    Element.prototype[method] = () => {};
  }
});
