// Vitest setup: suppress jsdom limitations that fire as unhandled
// errors during unit tests even though they don't affect assertions.
//
// 1. HTMLCanvasElement.getContext — xterm.js's WebGL renderer probes
//    for canvas support; we don't test terminal rendering so a no-op
//    stub is fine.
// 2. WebSocket — crossInstanceSync opens a WS on mount; jsdom
//    doesn't have a native WebSocket. We stub it as a no-op
//    EventTarget.

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
}

// Always override WebSocket (jsdom provides a partial stub via
// the `ws` package that throws "ws does not work in the browser").
// Our stub is a silent no-op that never connects.
globalThis.WebSocket = class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = 3; // CLOSED
  url: string;
  protocol = "";
  bufferedAmount = 0;
  extensions = "";
  binaryType: BinaryType = "blob";
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
  }
  send() {}
  close() {}
} as unknown as typeof WebSocket;
