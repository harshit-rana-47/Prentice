import type {
  Citation,
  DiffFile,
  EvidencePacket,
  GroundedClaim,
  SymbolChange,
  UnderstandArtifact,
} from "./types.js";

const AGENT_ATTRIBUTION = /\bthe agent (decided|chose|explained|said|stated|implemented|wanted)\b/i;

export function buildObservedClaims(packet: EvidencePacket): GroundedClaim[] {
  const claims: GroundedClaim[] = [];
  for (const file of packet.files) {
    claims.push({
      kind: "observed",
      text: fileSentence(file),
      citations: [{ evidenceId: file.evidenceId, file: file.path }],
    });
  }
  for (const symbol of packet.symbols) {
    claims.push({
      kind: "observed",
      text: `${symbol.change === "added" ? "Added" : symbol.change === "deleted" ? "Removed" : "Updated"} ${symbol.kind} ${symbol.name} in ${symbol.path}.`,
      citations: [{ evidenceId: symbol.evidenceId, file: symbol.path, symbol: symbol.name }],
    });
  }
  if (packet.tests) {
    claims.push({
      kind: "observed",
      text: `Tests reported ${packet.tests.passed} passed and ${packet.tests.failed} failed.`,
      citations: [{ evidenceId: packet.tests.evidenceId }],
    });
  }
  return claims;
}

export function buildAgentStatedClaims(packet: EvidencePacket): GroundedClaim[] {
  return packet.activity
    .filter((item) => item.source === "agent" && item.kind === "assistant" && item.detail && item.detail.length <= 400)
    .map((item) => ({
      kind: "agent-stated" as const,
      text: `The agent stated: ${item.detail}`,
      citations: [{ evidenceId: item.evidenceId, file: item.path }],
    }));
}

export function buildChangeMap(files: DiffFile[]): string | null {
  if (files.length < 2) return null;
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    const group = parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
    const list = groups.get(group) ?? [];
    list.push(file.path.split("/").pop() ?? file.path);
    groups.set(group, list);
  }
  if (groups.size < 2) return null;
  const lines = ["Changed areas"];
  for (const [group, names] of groups) {
    lines.push(`  ${group}`);
    for (const name of names) lines.push(`    ${name}`);
  }
  return lines.join("\n");
}

export function insufficientEvidenceNotes(packet: EvidencePacket, files: DiffFile[]): string[] {
  const notes: string[] = [];
  if (files.length === 0) {
    notes.push("Git shows no file changes, so Prentice cannot explain an implementation.");
  }
  if (!packet.activity.some((item) => item.source === "agent" && item.kind === "assistant")) {
    notes.push("The session has no agent explanation of why this approach was chosen.");
  }
  if (packet.unparsedFiles.length > 0) {
    notes.push(
      `Syntax structure was not parsed for: ${packet.unparsedFiles.join(", ")}. Those files are described only by path and diff size.`,
    );
  }
  notes.push("Before/after architecture diagrams are omitted unless a later analysis can derive them from this repo.");
  return notes;
}

export function validateClaims(
  claims: GroundedClaim[],
  packet: EvidencePacket,
): { accepted: GroundedClaim[]; rejected: Array<{ text: string; reason: string }> } {
  const evidenceIds = evidenceIndex(packet);
  const accepted: GroundedClaim[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];

  for (const claim of claims) {
    const reason = rejectionReason(claim, evidenceIds, packet);
    if (reason) rejected.push({ text: claim.text, reason });
    else accepted.push(claim);
  }
  return { accepted, rejected };
}

export function assembleUnderstand(
  packet: EvidencePacket,
  modelClaims: GroundedClaim[] = [],
): UnderstandArtifact {
  const observed = buildObservedClaims(packet);
  const agentStated = buildAgentStatedClaims(packet);
  const validated = validateClaims(modelClaims, packet);
  const inferences = validated.accepted.filter((claim) => claim.kind === "inference");
  const extraAgent = validated.accepted.filter((claim) => claim.kind === "agent-stated");
  const extraObserved = validated.accepted.filter((claim) => claim.kind === "observed");

  return {
    observed: [...observed, ...extraObserved],
    agentStated: [...agentStated, ...extraAgent],
    inferences,
    changeMap: buildChangeMap(packet.files),
    insufficientEvidence: insufficientEvidenceNotes(packet, packet.files),
    rejectedClaims: validated.rejected,
  };
}

function rejectionReason(
  claim: GroundedClaim,
  evidenceIds: Map<string, { file?: string; symbol?: string }>,
  packet: EvidencePacket,
): string | null {
  if (claim.citations.length === 0) return "A substantive claim needs a citation into the evidence packet.";
  for (const citation of claim.citations) {
    if (!evidenceIds.has(citation.evidenceId)) return `Unknown evidence id ${citation.evidenceId}.`;
    const known = evidenceIds.get(citation.evidenceId)!;
    if (citation.file && known.file && citation.file !== known.file) {
      return `Citation file ${citation.file} does not match evidence ${citation.evidenceId}.`;
    }
    if (citation.symbol && known.symbol && citation.symbol !== known.symbol) {
      return `Citation symbol ${citation.symbol} does not match evidence ${citation.evidenceId}.`;
    }
  }
  if (claim.kind === "inference" && AGENT_ATTRIBUTION.test(claim.text)) {
    return "An inference cannot be written as something the agent decided or said.";
  }
  if (claim.kind !== "inference" && claim.kind !== "observed" && claim.kind !== "agent-stated") {
    return "Unknown claim kind.";
  }
  const mentionedFiles = filesMentioned(claim.text, packet);
  if (mentionedFiles.length > 0) {
    const citedFiles = new Set(claim.citations.map((citation) => citation.file).filter(Boolean));
    const missing = mentionedFiles.filter((file) => !citedFiles.has(file));
    if (missing.length > 0 && claim.kind !== "agent-stated") {
      return `File ${missing[0]} is named without a matching citation.`;
    }
  }
  return null;
}

function filesMentioned(text: string, packet: EvidencePacket): string[] {
  return packet.files.map((file) => file.path).filter((path) => text.includes(path));
}

function evidenceIndex(packet: EvidencePacket): Map<string, { file?: string; symbol?: string }> {
  const index = new Map<string, { file?: string; symbol?: string }>();
  for (const file of packet.files) index.set(file.evidenceId, { file: file.path });
  for (const symbol of packet.symbols) index.set(symbol.evidenceId, { file: symbol.path, symbol: symbol.name });
  for (const item of packet.activity) index.set(item.evidenceId, { file: item.path });
  if (packet.tests) index.set(packet.tests.evidenceId, {});
  return index;
}

function fileSentence(file: DiffFile): string {
  const verb = file.change === "added" ? "Added" : file.change === "deleted" ? "Removed" : "Modified";
  return `${verb} ${file.path} (+${file.additions} / -${file.deletions}).`;
}

export function citationForSymbol(symbol: SymbolChange): Citation {
  return { evidenceId: symbol.evidenceId, file: symbol.path, symbol: symbol.name };
}
