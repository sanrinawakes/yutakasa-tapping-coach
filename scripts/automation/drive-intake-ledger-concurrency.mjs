import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const container = process.env.YUTAKASA_TEST_PG_CONTAINER;
if (!container || !/^[A-Za-z0-9_-]{1,100}$/u.test(container)) {
  throw new Error("test_postgres_container_required");
}
const fileId = `intake_race_${process.pid}`;
const modified = "2025-09-16T12:34:56.000Z";

async function psql(sql) {
  const { stdout } = await exec("docker", [
    "exec", container, "psql", "-X", "-q", "-A", "-t",
    "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "yutakasa", "-c", sql,
  ], { timeout: 30_000, maxBuffer: 8192 });
  return stdout.trim();
}

async function claim(id, targetFile = fileId, targetTime = modified) {
  const sql = `BEGIN; SELECT public.claim_yutakasa_drive_intake('${targetFile}', '${targetTime}', '1', '${id}'); SELECT pg_sleep(0.3); COMMIT;`;
  const lines = (await psql(sql)).split("\n");
  return lines.find((line) => ["acquired", "busy", "stale"].includes(line));
}

const outcomes = await Promise.all([
  claim("66666666-6666-4666-8666-666666666666"),
  claim("77777777-7777-4777-8777-777777777777"),
]);
assert.deepEqual(outcomes.sort(), ["acquired", "busy"]);
assert.equal(
  await psql(`SELECT count(*) || ':' || min(status) FROM public.yutakasa_drive_intake_items WHERE file_id='${fileId}'`),
  "1:processing",
);
process.stdout.write("Drive intake concurrent claim: one acquired, one busy\n");

const changedFile = `${fileId}_updated`;
const changedOutcomes = await Promise.all([
  claim("88888888-8888-4888-8888-888888888888", changedFile, modified),
  claim("99999999-9999-4999-8999-999999999999", changedFile, "2025-09-17T12:34:56.000Z"),
]);
assert.equal(changedOutcomes.filter((outcome) => outcome === "acquired").length, 1);
assert.ok(changedOutcomes.some((outcome) => outcome === "busy" || outcome === "stale"));
assert.equal(
  await psql(`SELECT count(*) || ':' || min(status) FROM public.yutakasa_drive_intake_items WHERE file_id='${changedFile}'`),
  "1:processing",
);
process.stdout.write("Drive intake concurrent revisions: one active claim\n");

async function holdRowPastDeadline(targetFile) {
  const child = spawn("docker", [
    "exec", "-i", container, "psql", "-X", "-q", "-A", "-t",
    "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "yutakasa",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  const released = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`row_lock_process_failed_${code}:${errorOutput}`)));
  });
  const locked = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("row_lock_timeout")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/(?:^|\n)(\d{13})(?:\n|$)/u);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
    child.on("close", () => reject(new Error("row_lock_closed_before_acquisition")));
  });
  child.stdin.write(`BEGIN;\nUPDATE public.yutakasa_drive_intake_items SET lease_expires_at=clock_timestamp()+INTERVAL '15 seconds' WHERE file_id='${targetFile}' RETURNING round(extract(epoch FROM lease_expires_at)*1000)::bigint;\n`);
  const deadline = await locked;
  child.stdin.end("SELECT pg_sleep(17);\nCOMMIT;\n");
  return { deadline, released };
}

async function expiredWhileLocked(kind, claimId) {
  const targetFile = `${fileId}_${kind}`;
  assert.equal(await psql(`SELECT public.claim_yutakasa_drive_intake('${targetFile}', '${modified}', '1', '${claimId}')`), "acquired");
  const { deadline, released } = await holdRowPastDeadline(targetFile);
  const dbNow = Number(await psql("SELECT round(extract(epoch FROM clock_timestamp())*1000)::bigint"));
  assert.ok(Number.isFinite(deadline) && Number.isFinite(dbNow) && dbNow < deadline - 1000,
    "attempt must begin while lease is still live");
  const statement = kind === "renew"
    ? `SELECT public.renew_yutakasa_drive_intake('${targetFile}', '${modified}', '${claimId}')`
    : `SELECT public.finish_yutakasa_drive_intake('${targetFile}', '${modified}', '${claimId}', 'processed', NULL)`;
  const response = await psql(statement);
  await released;
  assert.equal(response, "f", `${kind} must fail after the locked lease expires`);
  assert.equal(await psql(`SELECT status FROM public.yutakasa_drive_intake_items WHERE file_id='${targetFile}'`), "processing");
  assert.equal(await psql(`SELECT public.claim_yutakasa_drive_intake('${targetFile}', '${modified}', '1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`), "needs_review");
  assert.equal(await psql(`SELECT status || ':' || failure_code FROM public.yutakasa_drive_intake_items WHERE file_id='${targetFile}'`), "needs_review:lease_expired");
}

await expiredWhileLocked("renew", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
await expiredWhileLocked("finish", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
process.stdout.write("Drive intake locked expiry: late renew and finish both rejected\n");
