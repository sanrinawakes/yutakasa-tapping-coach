import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DRIVE_INTAKE_FOLDER_ID,
  DriveIntakeError,
  collectDriveIntakeMetadata,
  pollDriveIntakeToFile,
} from "./drive-intake.mjs";

const CREDENTIALS = Object.freeze({
  GOOGLE_DRIVE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_DRIVE_CLIENT_SECRET: "private-client-secret-for-test",
  GOOGLE_DRIVE_REFRESH_TOKEN: "private-refresh-token-for-test",
});
const ACCESS_TOKEN = "private-access-token-for-test";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function file(id, name = "受付資料.pdf") {
  return {
    id,
    name,
    mimeType: "application/pdf",
    modifiedTime: "2026-09-16T12:34:56.000Z",
    description: "customer-body-must-not-be-returned",
  };
}

function driveFetch(pages, onRequest = () => {}) {
  let pageIndex = 0;
  return async (url, init) => {
    onRequest(url, init);
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.body.get("grant_type"), "refresh_token");
      assert.equal(init.body.get("client_id"), CREDENTIALS.GOOGLE_DRIVE_CLIENT_ID);
      assert.equal(init.body.get("client_secret"), CREDENTIALS.GOOGLE_DRIVE_CLIENT_SECRET);
      assert.equal(init.body.get("refresh_token"), CREDENTIALS.GOOGLE_DRIVE_REFRESH_TOKEN);
      return json({ access_token: ACCESS_TOKEN, token_type: "Bearer" });
    }
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${DRIVE_INTAKE_FOLDER_ID}?`)) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
      return json({
        id: DRIVE_INTAKE_FOLDER_ID,
        name: "受付",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      });
    }
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://www.googleapis.com");
    assert.equal(parsed.pathname, "/drive/v3/files");
    assert.equal(parsed.searchParams.get("q"), `'${DRIVE_INTAKE_FOLDER_ID}' in parents and trashed = false`);
    assert.equal(parsed.searchParams.get("spaces"), "drive");
    assert.equal(parsed.searchParams.get("corpora"), "user");
    assert.equal(parsed.searchParams.get("pageSize"), "1000");
    assert.equal(parsed.searchParams.get("fields"), "kind,nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    const page = pages[pageIndex++];
    assert.ok(page, "unexpected extra page request");
    return page;
  };
}

function page(files, nextPageToken) {
  return json({
    kind: "drive#fileList",
    incompleteSearch: false,
    files,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
}

async function errorCode(run, expected) {
  await assert.rejects(
    run(),
    (error) =>
      error instanceof DriveIntakeError &&
      error.code === expected &&
      !error.message.includes(CREDENTIALS.GOOGLE_DRIVE_REFRESH_TOKEN) &&
      !error.message.includes(ACCESS_TOKEN),
  );
}

test("OAuth refresh and bounded pagination return sorted metadata only", async () => {
  const requestedTokens = [];
  const fetchImpl = driveFetch(
    [page([file("z-file")], "next-page"), page([file("a-file", "追加資料.docx")])],
    (url) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        requestedTokens.push(new URL(url).searchParams.get("pageToken"));
      }
    },
  );
  const result = await collectDriveIntakeMetadata({
    credentials: CREDENTIALS,
    fetchImpl,
    now: () => new Date("2026-09-16T13:00:00.000Z"),
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.trust, "untrusted_drive_metadata");
  assert.equal(result.folderId, DRIVE_INTAKE_FOLDER_ID);
  assert.equal(result.observedAt, "2026-09-16T13:00:00.000Z");
  assert.equal(result.pageCount, 2);
  assert.deepEqual(requestedTokens, [null, "next-page"]);
  assert.deepEqual(result.files.map(({ id }) => id), ["a-file", "z-file"]);
  for (const entry of result.files) {
    assert.deepEqual(Object.keys(entry), ["id", "name", "mimeType", "modifiedTime"]);
  }
  assert.ok(!JSON.stringify(result).includes("customer-body-must-not-be-returned"));
  assert.ok(!JSON.stringify(result).includes(ACCESS_TOKEN));
});

test("private output file contains metadata while stdout summary contains counts only", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drive-intake-test-"));
  fs.chmodSync(directory, 0o700);
  const outputPath = path.join(directory, "drive-intake.json");
  try {
    const summary = await pollDriveIntakeToFile({
      outputPath,
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([page([file("one-file", "秘密の受付資料.pdf")])]),
    });
    assert.deepEqual(summary, { ok: true, fileCount: 1, pageCount: 1 });
    assert.ok(!JSON.stringify(summary).includes("秘密の受付資料"));
    const stat = fs.lstatSync(outputPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(saved.files[0].name, "秘密の受付資料.pdf");
    assert.ok(!JSON.stringify(saved).includes(ACCESS_TOKEN));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate file IDs across pages fail closed", async () => {
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([page([file("same-id")], "next"), page([file("same-id")])]),
    }),
    "drive_pagination_duplicate_file",
  );
});

test("repeated page tokens fail closed before another page request", async () => {
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([page([], "same-next"), page([], "same-next")]),
    }),
    "drive_pagination_token_mismatch",
  );
});

test("pagination stops at the configured 100-page bound", async () => {
  const pages = Array.from({ length: 100 }, (_, index) =>
    page([], `next-${index + 1}`),
  );
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch(pages),
    }),
    "drive_pagination_limit_exceeded",
  );
});

test("incomplete search or malformed file metadata cannot produce a healthy result", async () => {
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([
        json({ kind: "drive#fileList", incompleteSearch: true, files: [] }),
      ]),
    }),
    "drive_list_schema_or_search_invalid",
  );
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([page([{ id: "file-no-time", name: "x", mimeType: "text/plain" }])]),
    }),
    "drive_file_schema_invalid",
  );
});

test("Drive HTTP failure is a fixed error without response content", async () => {
  const marker = "private-error-response-must-not-leak";
  await assert.rejects(
    collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([json({ error: marker }, 503)]),
    }),
    (error) =>
      error instanceof DriveIntakeError &&
      error.code === "drive_list_http_failure" &&
      !error.message.includes(marker),
  );
});

test("inaccessible or different intake folder cannot look empty and healthy", async () => {
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: async (url) => url === "https://oauth2.googleapis.com/token"
        ? json({ access_token: ACCESS_TOKEN, token_type: "Bearer" })
        : json({ error: "not found" }, 404),
    }),
    "drive_folder_http_failure",
  );
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: async (url) => url === "https://oauth2.googleapis.com/token"
        ? json({ access_token: ACCESS_TOKEN, token_type: "Bearer" })
        : json({ id: DRIVE_INTAKE_FOLDER_ID, name: "違うフォルダ", mimeType: "application/vnd.google-apps.folder", trashed: false }),
    }),
    "drive_folder_identity_invalid",
  );
});

test("OAuth failure and missing credentials stop before listing files", async () => {
  let calls = 0;
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: async () => {
        calls += 1;
        return json({ error: "invalid_grant", refresh_token: "private" }, 401);
      },
    }),
    "drive_token_http_failure",
  );
  assert.equal(calls, 1);
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: { ...CREDENTIALS, GOOGLE_DRIVE_REFRESH_TOKEN: "" },
      fetchImpl: async () => { calls += 1; },
    }),
    "drive_credential_missing_or_invalid_google_drive_refresh_token",
  );
  assert.equal(calls, 1);
});

test("metadata response size is bounded", async () => {
  await errorCode(
    () => collectDriveIntakeMetadata({
      credentials: CREDENTIALS,
      fetchImpl: driveFetch([
        new Response(JSON.stringify({ kind: "drive#fileList", files: [] }), {
          headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
        }),
      ]),
    }),
    "drive_list_response_too_large",
  );
});

test("output requires a private parent directory before any OAuth request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drive-intake-insecure-test-"));
  fs.chmodSync(directory, 0o755);
  let calls = 0;
  try {
    await errorCode(
      () => pollDriveIntakeToFile({
        outputPath: path.join(directory, "drive-intake-never-create.json"),
        credentials: CREDENTIALS,
        fetchImpl: async () => { calls += 1; },
      }),
      "drive_output_parent_not_private",
    );
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
