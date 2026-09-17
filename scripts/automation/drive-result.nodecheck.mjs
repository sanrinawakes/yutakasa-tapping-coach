import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { DriveIntakeError } from "./drive-intake.mjs";
import {
  DRIVE_RESULT_FOLDER_ID,
  publishVerifiedDriveResult,
  renderVerifiedResultPdf,
} from "./drive-result.mjs";

const CREDENTIALS = {
  YUTAKASA_DRIVE_PROCESSING_ENABLED: "true",
  YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED: "true",
  GOOGLE_DRIVE_CLIENT_ID: "test-client",
  GOOGLE_DRIVE_CLIENT_SECRET: "test-secret",
  GOOGLE_DRIVE_REFRESH_TOKEN: "test-refresh",
  GOOGLE_DRIVE_API_KEY: "metadata-only-key-must-not-be-used",
};
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 0x20), Buffer.from("\n%%EOF\n")]);
const REPORT = {
  eventId: "release_123456",
  completedAt: "2026-09-17T02:00:00.000Z",
  inputSource: "アプリ内問い合わせ",
  classification: "技術障害",
  cause: "保存処理のタイムアウトを確認した。",
  change: "保存処理を修正し、再現テストを追加した。",
  prUrl: "https://github.com/sanrinawakes/yutakasa-tapping-coach/pull/41",
  productionSha: "a".repeat(40),
  deploymentId: "dpl_1234567890",
  customerReply: "返信IDを本番で確認済み",
  tests: [{ name: "単体テスト", passed: 12, failed: 0 }],
  observations: [
    "2026-09-17T01:30:00.000Z",
    "2026-09-17T01:40:00.000Z",
    "2026-09-17T01:50:00.000Z",
  ],
  unverifiedItems: [],
};

function makeLedger() {
  const rows = new Map();
  return {
    rows,
    async reserve({ eventId, sha256, name }) {
      const row = rows.get(eventId);
      if (!row) {
        rows.set(eventId, { sha256, name, status: "posting", fileId: null });
        return "reserved";
      }
      if (row.sha256 !== sha256 || row.name !== name) return "conflict";
      return row.status === "confirmed" ? "confirmed" : "pending";
    },
    async uncertain({ eventId, sha256 }) {
      const row = rows.get(eventId);
      if (!row || row.sha256 !== sha256 || row.status === "confirmed") return false;
      row.status = "uncertain";
      return true;
    },
    async confirm({ eventId, sha256, fileId }) {
      const row = rows.get(eventId);
      if (!row || row.sha256 !== sha256 ||
          (row.fileId && row.fileId !== fileId)) return false;
      row.status = "confirmed";
      row.fileId = fileId;
      return true;
    },
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function savedFile(metadata, pdf = PDF) {
  return {
    id: "drive-report-1",
    name: metadata.name,
    mimeType: "application/pdf",
    parents: [DRIVE_RESULT_FOLDER_ID],
    appProperties: metadata.appProperties,
    md5Checksum: createHash("md5").update(pdf).digest("hex"),
    size: String(pdf.length),
    trashed: false,
  };
}

function fakeDrive({ existing = false, existingFile, uploadStatus = 200, onCall = () => {} } = {}) {
  const expectedMetadata = {
    name: "豊かさBOT_対応結果_release_123456.pdf",
    appProperties: {
      yutakasaEventId: "release_123456",
      yutakasaSha256: createHash("sha256").update(PDF).digest("hex"),
    },
  };
  const file = savedFile(expectedMetadata);
  return async (url, init) => {
    onCall(url, init);
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("refresh_token"), CREDENTIALS.GOOGLE_DRIVE_REFRESH_TOKEN);
      return json({ access_token: "valid-access-token", token_type: "Bearer" });
    }
    assert.equal(init.headers.Authorization, "Bearer valid-access-token");
    assert.equal(init.headers["X-Goog-Api-Key"], undefined);
    const parsed = new URL(url);
    if (parsed.pathname === `/drive/v3/files/${DRIVE_RESULT_FOLDER_ID}`) {
      return json({
        id: DRIVE_RESULT_FOLDER_ID,
        name: "処理結果",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: true },
      });
    }
    if (parsed.pathname === "/drive/v3/files") {
      assert.match(parsed.searchParams.get("q"), /name = '豊かさBOT_対応結果_release_123456.pdf'/u);
      return json({ kind: "drive#fileList", incompleteSearch: false, files: existing ? [existingFile ?? file] : [] });
    }
    if (parsed.pathname === "/upload/drive/v3/files") {
      assert.equal(init.method, "POST");
      assert.equal(parsed.searchParams.get("uploadType"), "multipart");
      assert.match(init.headers["Content-Type"], /^multipart\/related; boundary=/u);
      assert.ok(init.body.includes(PDF));
      assert.ok(init.body.includes(Buffer.from("豊かさBOT_対応結果_release_123456")));
      return json(file, uploadStatus);
    }
    if (parsed.pathname === "/drive/v3/files/drive-report-1") return json(file);
    assert.fail(`unexpected Drive path: ${parsed.pathname}`);
  };
}

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) =>
    error instanceof DriveIntakeError &&
    error.code === code &&
    !error.message.includes(CREDENTIALS.GOOGLE_DRIVE_REFRESH_TOKEN)
  );
}

test("PDF publication requires its own exact flag before rendering or network", async () => {
  for (const value of [undefined, "false", "TRUE", "1", true]) {
    let calls = 0;
    await expectCode(() => publishVerifiedDriveResult({
      report: REPORT,
      credentials: { ...CREDENTIALS, YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED: value },
      renderPdf: async () => { calls += 1; return PDF; },
      fetchImpl: async () => { calls += 1; },
      assertEvidence: async () => { calls += 1; return true; },
      assertLease: async () => { calls += 1; return true; },
      publicationLedger: makeLedger(),
    }), "drive_result_publication_disabled");
    assert.equal(calls, 0);
  }
});

test("verified report uploads one PDF and confirms Drive readback", async () => {
  const calls = [];
  const publicationLedger = makeLedger();
  const result = await publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({ onCall: (url, init) => calls.push([url, init.method]) }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger,
  });
  assert.deepEqual(result, { ok: true, fileId: "drive-report-1", deduplicated: false });
  assert.equal(calls.filter(([url]) => url.includes("/upload/")).length, 1);
  assert.equal(calls.filter(([url]) => url.includes("/drive/v3/files/drive-report-1")).length, 1);
  assert.equal(publicationLedger.rows.get(REPORT.eventId).status, "confirmed");
});

test("same event and same bytes recover an ambiguous upload without a second POST", async () => {
  const calls = [];
  const result = await publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({ existing: true, onCall: (url) => calls.push(url) }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger: makeLedger(),
  });
  assert.deepEqual(result, { ok: true, fileId: "drive-report-1", deduplicated: true });
  assert.equal(calls.some((url) => url.includes("/upload/")), false);
});

test("same-name file whose app properties are hidden blocks a duplicate upload", async () => {
  const calls = [];
  const expectedFile = savedFile({
    name: "豊かさBOT_対応結果_release_123456.pdf",
    appProperties: {},
  });
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({
      existing: true,
      existingFile: expectedFile,
      onCall: (url) => calls.push(url),
    }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger: makeLedger(),
  }), "drive_result_file_verification_failed");
  assert.equal(calls.some((url) => url.includes("/upload/")), false);
});

test("completion timestamp change cannot bypass an existing event's filename", async () => {
  const calls = [];
  const result = await publishVerifiedDriveResult({
    report: { ...REPORT, completedAt: "2026-09-18T02:00:00.000Z" },
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({ existing: true, onCall: (url) => calls.push(url) }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger: makeLedger(),
  });
  assert.equal(result.deduplicated, true);
  assert.equal(calls.some((url) => url.includes("/upload/")), false);
});

test("changed report bytes for the same event cannot create another file", async () => {
  let posts = 0;
  const publicationLedger = makeLedger();
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({
      uploadStatus: 503,
      onCall: (url) => { if (url.includes("/upload/")) posts += 1; },
    }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger,
  }), "drive_result_upload_http_failure");
  const changedPdf = Buffer.concat([PDF, Buffer.from("later-result")]);
  await expectCode(() => publishVerifiedDriveResult({
    report: { ...REPORT, completedAt: "2026-09-18T02:00:00.000Z" },
    credentials: CREDENTIALS,
    renderPdf: async () => changedPdf,
    fetchImpl: fakeDrive({
      onCall: (url) => { if (url.includes("/upload/")) posts += 1; },
    }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger,
  }), "drive_result_event_conflict");
  assert.equal(posts, 1);
});

test("simultaneous publication attempts receive only one durable POST reservation", async () => {
  let posts = 0;
  const publicationLedger = makeLedger();
  const options = {
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({
      onCall: (url) => { if (url.includes("/upload/")) posts += 1; },
    }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger,
  };
  const outcomes = await Promise.allSettled([
    publishVerifiedDriveResult(options),
    publishVerifiedDriveResult(options),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  assert.equal(posts, 1);
});

test("no verified lease or three observations means no API call", async () => {
  let calls = 0;
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: async () => { calls += 1; },
    assertEvidence: async () => true,
  }), "drive_result_lease_required");
  await expectCode(() => publishVerifiedDriveResult({
    report: { ...REPORT, observations: REPORT.observations.slice(0, 2) },
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: async () => { calls += 1; },
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger: makeLedger(),
  }), "drive_result_release_evidence_incomplete");
  assert.equal(calls, 0);
});

test("release evidence must be bound before any rendering or API request", async () => {
  let calls = 0;
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => { calls += 1; return PDF; },
    fetchImpl: async () => { calls += 1; },
    assertLease: async () => true,
  }), "drive_result_evidence_required");
  assert.equal(calls, 0);
});

test("release evidence revoked during preparation blocks the upload POST", async () => {
  let checks = 0;
  let posts = 0;
  const publicationLedger = makeLedger();
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({
      onCall: (url) => { if (url.includes("/upload/")) posts += 1; },
    }),
    assertEvidence: async () => { checks += 1; return checks === 1; },
    assertLease: async () => true,
    publicationLedger,
  }), "drive_result_evidence_required");
  assert.equal(checks, 2);
  assert.equal(posts, 0);
  assert.equal(publicationLedger.rows.get(REPORT.eventId).status, "posting");
});

test("API key alone cannot authorize write", async () => {
  let calls = 0;
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: {
      YUTAKASA_DRIVE_PROCESSING_ENABLED: "true",
      YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED: "true",
      GOOGLE_DRIVE_API_KEY: "key-only",
    },
    renderPdf: async () => PDF,
    fetchImpl: async () => { calls += 1; },
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger: makeLedger(),
  }), "drive_credential_missing_or_invalid_google_drive_client_id");
  assert.equal(calls, 0);
});

test("upload failure is not blindly retried", async () => {
  let posts = 0;
  const publicationLedger = makeLedger();
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({
      uploadStatus: 503,
      onCall: (url) => { if (url.includes("/upload/")) posts += 1; },
    }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger,
  }), "drive_result_upload_http_failure");
  assert.equal(posts, 1);
  assert.equal(publicationLedger.rows.get(REPORT.eventId).status, "uncertain");
  await expectCode(() => publishVerifiedDriveResult({
    report: REPORT,
    credentials: CREDENTIALS,
    renderPdf: async () => PDF,
    fetchImpl: fakeDrive({
      onCall: (url) => { if (url.includes("/upload/")) posts += 1; },
    }),
    assertEvidence: async () => true,
    assertLease: async () => true,
    publicationLedger,
  }), "drive_result_publication_pending");
  assert.equal(posts, 1);
});

test("Japanese PDF renderer produces a private, text-extractable PDF", async (context) => {
  const fontPath = process.env.YUTAKASA_PDF_FONT_PATH ||
    (process.platform === "darwin" ? "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" :
      "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf");
  if (!fs.existsSync(fontPath)) {
    context.skip("Japanese font not installed in this test environment");
    return;
  }
  const pdf = await renderVerifiedResultPdf(REPORT, { fontPath });
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.ok(pdf.length > 1000);
  assert.ok(pdf.subarray(-6).toString("ascii").includes("%%EOF"));
  const again = await renderVerifiedResultPdf(REPORT, { fontPath });
  assert.ok(pdf.equals(again), "same evidence must produce byte-identical PDF for retry safety");
});
