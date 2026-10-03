import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { ObservationMessage, ReplyMessage, FailureMessage } from "./protocol";
export type PlayerTraceRecord = {
  request: ObservationMessage;
  response: ReplyMessage | FailureMessage;
};

/** Upload one private per-slot ZIP through the platform's player artifact endpoint. */
export async function writePlayerTraceArtifact(
  uri: string,
  slot: number,
  records: PlayerTraceRecord[],
  scores: number[],
): Promise<void> {
  const archive = new JSZip();
  archive.file("trace.jsonl", records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  archive.file(
    "summary.json",
    JSON.stringify({ schema: "cogweb.player-trace.v1", slot, scores, records: records.length }),
  );
  const payload = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  if (payload.length > 200 * 1024 * 1024) throw new Error("Coworld player trace exceeds 200 MiB");
  if (uri.startsWith("file://")) {
    const path = fileURLToPath(uri);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, payload, { flag: "wx", mode: 0o600 });
    return;
  }
  if (!uri.startsWith("https://") && !uri.startsWith("http://"))
    throw new Error("Coworld player artifact requires a file or HTTP URL");
  const response = await fetch(uri, {
    method: "PUT",
    headers: { "Content-Type": "application/zip" },
    body: new Uint8Array(payload),
  });
  if (!response.ok) throw new Error(`Coworld player artifact upload failed (${response.status})`);
}
