import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  QUEUE_TRANSFER_FORMAT,
  computeArchiveDigest,
  canonicalJson,
  parseEnvelope,
  QueueTransferRefusal,
  type TransferArchiveEnvelope,
} from "../src/domain/queue-transfer-archive.js";

function fixture(overrides: Partial<TransferArchiveEnvelope> = {}): TransferArchiveEnvelope {
  const base = {
    format: QUEUE_TRANSFER_FORMAT,
    transferId: "xfer-fixture",
    createdAt: "2026-11-21T00:00:00.000Z",
    origin: {
      hostId: "origin-host",
      mintedAt: "2026-01-01T00:00:00.000Z",
      generation: null,
      openrigVersion: "0.7.1",
      schemaMigration: "180_queue_transfer_staged.sql",
    },
    scope: {
      kind: "qitems" as const,
      rigs: [],
      missions: [],
      slices: [],
      qitemIds: ["qitem-a"],
      includeClosed: true,
      selectionShownAt: "2026-11-21T00:00:00.000Z",
    },
    rows: [
      {
        qitemId: "qitem-a",
        tsCreated: "2026-11-20T00:00:00.000Z",
        tsUpdated: "2026-11-20T00:00:00.000Z",
        sourceSession: "a@rig",
        destinationSession: "b@rig",
        state: "pending",
        priority: "routine",
        tier: null,
        tags: null,
        blockedOn: null,
        handedOffTo: null,
        handedOffFrom: null,
        expiresAt: null,
        chainOfRecord: null,
        body: "do the thing",
        closureReason: null,
        closureTarget: null,
        closureRequiredAt: null,
        claimedAt: null,
        lastNudgeAttempt: null,
        lastNudgeResult: null,
        lastHeartbeat: null,
        resolution: null,
        targetRepo: null,
        summary: "a thing",
        evidenceRef: null,
        mintingGenerationUuid: null,
        claimedByGenerationUuid: null,
        humanIntent: null,
        humanDetail: null,
        replyTo: null,
        humanQuestions: null,
        humanAnswers: null,
        lastNudgeInputBox: null,
        delegatedDecision: null,
        contentErasedAt: null,
        returnRoute: null,
        returnRouteBasis: null,
        transitions: [],
        archivedTransitions: [],
        wakes: [],
        missionControlActions: [],
        erasure: null,
      },
    ],
    erasure: { ids: [], rigs: [] },
    digest: { algorithm: "sha256" as const, value: "", coverage: QUEUE_TRANSFER_FORMAT },
  };
  const merged = { ...base, ...overrides };
  return { ...merged, digest: { ...merged.digest, value: computeArchiveDigest(merged) } };
}

describe("queue transfer archive — canonical serialization and digest", () => {
  it("canonical-serializes the same archive byte-identically twice", () => {
    const envelope = fixture();
    const first = canonicalJson(envelope);
    const second = canonicalJson(envelope);
    expect(first).toBe(second);
    expect(computeArchiveDigest(envelope)).toBe(computeArchiveDigest(envelope));
    expect(computeArchiveDigest(envelope)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonical JSON sorts keys recursively and keeps no insignificant whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it("computes the digest over the envelope with the digest member removed", () => {
    const envelope = fixture();
    const { digest: _digest, ...content } = envelope;
    const expected = createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
    expect(envelope.digest.value).toBe(expected);
    // A fresh export may differ in transferId/createdAt, so a different id is a different digest.
    expect(computeArchiveDigest({ ...content, transferId: "xfer-other" })).not.toBe(expected);
  });

  it("ignores unknown optional properties at the top level and inside a row", () => {
    const envelope = fixture();
    const text = JSON.stringify({
      ...envelope,
      futureTopLevel: { anything: true },
      origin: { ...envelope.origin, futureOrigin: 1 },
      rows: envelope.rows.map((row) => ({ ...row, futureRow: "ignored" })),
    });
    const parsed = parseEnvelope(text);
    expect("futureTopLevel" in parsed).toBe(false);
    expect("futureOrigin" in parsed.origin).toBe(false);
    expect("futureRow" in parsed.rows[0]!).toBe(false);
    expect(computeArchiveDigest(parsed)).toBe(envelope.digest.value);
  });

  it("refuses an unknown format major before any other validation", () => {
    const envelope = fixture({ format: "openrig.queue-transfer/v3" as never });
    expect(() => parseEnvelope(JSON.stringify(envelope))).toThrowError(QueueTransferRefusal);
    try {
      parseEnvelope(JSON.stringify({ ...envelope, digest: undefined }));
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("format_unsupported");
      return;
    }
    throw new Error("expected format_unsupported");
  });

  it("re-serializes a parsed archive to the same digest", () => {
    const envelope = fixture();
    const parsed = parseEnvelope(JSON.stringify(envelope));
    expect(computeArchiveDigest(parsed)).toBe(envelope.digest.value);
  });
});
