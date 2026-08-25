// Thin browser-WebSocket wrapper yielding raw ServerMessage strings to the feed.
// Reconnection lives in connectLiveFeed — this just surfaces the close event
// (a failed connect fires close too, so retry covers a server still booting).
import type { LiveSocket } from "./feed";

export function makeWorldSocket(url: string): LiveSocket {
  const ws = new WebSocket(url);
  return {
    onMessage(fn) {
      ws.addEventListener("message", (e) => fn(String((e as MessageEvent).data)));
    },
    onClose(fn) {
      ws.addEventListener("close", fn);
    },
    send(data) {
      // The control plane writes ClientMessages on the SAME socket the feed
      // reads. A write before the socket is open (or after it dies) is dropped —
      // the lobby/controls are user-driven and idempotent, and the live socket
      // reconnects + backfills, so a lost click is simply re-clicked.
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close() {
      ws.close();
    },
  };
}
