import { ReplayArtifact, type ServerMessage } from "@cogweb/protocol";

async function decodeReplay(bytes: Uint8Array): Promise<string> {
  const compression =
    bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
      ? "gzip"
      : bytes.length >= 1 && bytes[0] === 0x78
        ? "deflate"
        : null;
  if (compression === null) return new TextDecoder().decode(bytes);

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const body = new Response(buffer).body;
  if (body === null) throw new Error("browser could not read replay bytes");
  return new Response(body.pipeThrough(new DecompressionStream(compression))).text();
}

/** Fetch and validate a browser-hosted Cogweb replay artifact. The artifact
 *  store serves zlib/gzip bytes without requiring a game container, while local
 *  fixtures may be raw JSON. */
export async function loadReplayFrames(uri: string, signal?: AbortSignal): Promise<ServerMessage[]> {
  const response = await fetch(uri, { signal });
  if (!response.ok) throw new Error(`replay request failed with HTTP ${response.status}`);
  const text = await decodeReplay(new Uint8Array(await response.arrayBuffer()));
  return ReplayArtifact.parse(JSON.parse(text)).frames;
}
