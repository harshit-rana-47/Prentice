import { PROTOCOL_VERSION, parseFrame } from "@prentice/protocol";

/** Loads the protocol package through the Next bundler. It does not change a request. */
export function assertProtocolContract(): void {
  if (PROTOCOL_VERSION !== 1) throw new Error("Prentice protocol version is not supported.");
  const frame = parseFrame({ kind: "request", id: "local", method: "project.current" });
  if (frame.kind !== "request" || frame.method !== "project.current") {
    throw new Error("Prentice protocol frame did not parse.");
  }
}
