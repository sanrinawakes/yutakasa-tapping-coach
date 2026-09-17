import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DRIVE_INTAKE_FOLDER_ID, DriveIntakeError } from "./drive-intake.mjs";
import { fetchDriveIntakeContent } from "./drive-intake-content.mjs";

const FILE = {
  id: "input_123456",
  name: "相談資料.pdf",
  mimeType: "application/pdf",
  modifiedTime: "2026-09-17T00:00:00.000Z",
};
const CREDENTIALS = {
  GOOGLE_DRIVE_CLIENT_ID: "test-client",
  GOOGLE_DRIVE_CLIENT_SECRET: "test-secret",
  GOOGLE_DRIVE_REFRESH_TOKEN: "test-refresh",
  GOOGLE_DRIVE_API_KEY: "read-only-monitor-key",
};
const BYTES = Buffer.from("%PDF-1.4\nprivate-pdf-content\n%%EOF\n");

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function fakeFetch({ metadata = {}, content = BYTES, status = 200, onCall = () => {} } = {}) {
  return async (url, init) => {
    onCall(url, init);
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "test-access-token", token_type: "Bearer" });
    }
    assert.equal(init.headers.Authorization, "Bearer test-access-token");
    assert.equal(init.headers["X-Goog-Api-Key"], undefined);
    const parsed = new URL(url);
    if (parsed.searchParams.get("fields")) {
      return json({
        id: FILE.id,
        name: FILE.name,
        mimeType: FILE.mimeType,
        modifiedTime: FILE.modifiedTime,
        parents: [DRIVE_INTAKE_FOLDER_ID],
        trashed: false,
        size: String(BYTES.length),
        md5Checksum: createHash("md5").update(BYTES).digest("hex"),
        ...metadata,
      });
    }
    assert.equal(parsed.searchParams.get("alt"), "media");
    return new Response(content, { status });
  };
}

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) =>
    error instanceof DriveIntakeError &&
    error.code === code &&
    !error.message.includes(CREDENTIALS.GOOGLE_DRIVE_REFRESH_TOKEN)
  );
}

test("OAuth reads the exact intake file and checks its checksum", async () => {
  const result = await fetchDriveIntakeContent({
    file: FILE,
    credentials: CREDENTIALS,
    fetchImpl: fakeFetch(),
  });
  assert.equal(result.fileId, FILE.id);
  assert.equal(result.mimeType, FILE.mimeType);
  assert.ok(result.bytes.equals(BYTES));
  assert.equal(result.sha256, createHash("sha256").update(BYTES).digest("hex"));
  assert.equal(JSON.stringify({ ...result, bytes: undefined }).includes(FILE.name), false);
});

test("API key alone cannot read private file content", async () => {
  let calls = 0;
  await expectCode(() => fetchDriveIntakeContent({
    file: FILE,
    credentials: { GOOGLE_DRIVE_API_KEY: "key-only" },
    fetchImpl: async () => { calls += 1; },
  }), "drive_credential_missing_or_invalid_google_drive_client_id");
  assert.equal(calls, 0);
});

test("moved, changed, and invalid source files fail before media download", async () => {
  for (const metadata of [
    { parents: ["different-folder"] },
    { modifiedTime: "2026-09-17T00:01:00.000Z" },
    { trashed: true },
    { size: String(20 * 1024 * 1024 + 1) },
  ]) {
    let mediaCalls = 0;
    await expectCode(() => fetchDriveIntakeContent({
      file: FILE,
      credentials: CREDENTIALS,
      fetchImpl: fakeFetch({
        metadata,
        onCall: (url) => { if (url.includes("alt=media")) mediaCalls += 1; },
      }),
    }), "drive_intake_content_metadata_mismatch");
    assert.equal(mediaCalls, 0);
  }
});

test("body-size limit and checksum mismatch are never processed", async () => {
  await expectCode(() => fetchDriveIntakeContent({
    file: FILE,
    credentials: CREDENTIALS,
    fetchImpl: fakeFetch({ content: Buffer.alloc(20 * 1024 * 1024 + 1) }),
  }), "drive_intake_content_too_large");
  await expectCode(() => fetchDriveIntakeContent({
    file: FILE,
    credentials: CREDENTIALS,
    fetchImpl: fakeFetch({ content: Buffer.from("%PDF-1.4\nchanged\n%%EOF") }),
  }), "drive_intake_content_checksum_mismatch");
});

test("Google Docs are exported to DOCX with a bounded response", async () => {
  const native = {
    ...FILE,
    mimeType: "application/vnd.google-apps.document",
  };
  const bytes = Buffer.from("PK\x03\x04test-docx");
  const result = await fetchDriveIntakeContent({
    file: native,
    credentials: CREDENTIALS,
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "test-access-token", token_type: "Bearer" });
      }
      const parsed = new URL(url);
      if (parsed.searchParams.get("fields")) {
        return json({
          id: native.id,
          name: native.name,
          mimeType: native.mimeType,
          modifiedTime: native.modifiedTime,
          parents: [DRIVE_INTAKE_FOLDER_ID],
          version: "42",
          trashed: false,
        });
      }
      assert.equal(parsed.pathname, `/drive/v3/files/${native.id}/export`);
      assert.equal(
        parsed.searchParams.get("mimeType"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      return new Response(bytes);
    },
  });
  assert.equal(result.extension, ".docx");
  assert.ok(result.bytes.equals(bytes));
});

test("Google Docs edit during export fails after a second metadata read", async () => {
  const native = { ...FILE, mimeType: "application/vnd.google-apps.document" };
  for (const changedField of ["version", "modifiedTime", "parents"]) {
    let metadataReads = 0;
    await expectCode(() => fetchDriveIntakeContent({
      file: native,
      credentials: CREDENTIALS,
      fetchImpl: async (url) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return json({ access_token: "test-access-token", token_type: "Bearer" });
        }
        const parsed = new URL(url);
        if (parsed.searchParams.get("fields")) {
          metadataReads += 1;
          return json({
            id: native.id,
            name: native.name,
            mimeType: native.mimeType,
            modifiedTime: metadataReads === 2 && changedField === "modifiedTime"
              ? "2026-09-17T00:00:01.000Z" : native.modifiedTime,
            parents: metadataReads === 2 && changedField === "parents"
              ? ["other-folder"] : [DRIVE_INTAKE_FOLDER_ID],
            version: metadataReads === 2 && changedField === "version" ? "43" : "42",
            trashed: false,
          });
        }
        return new Response(Buffer.from("PK\x03\x04exported"));
      },
    }), "drive_intake_content_changed_during_export");
    assert.equal(metadataReads, 2);
  }
});
