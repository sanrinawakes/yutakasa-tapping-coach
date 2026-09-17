import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const container = process.env.YUTAKASA_TEST_PG_CONTAINER;
if (!container || !/^[A-Za-z0-9_-]{1,100}$/u.test(container)) {
  throw new Error("test_postgres_container_required");
}
const eventId = `release_race_${process.pid}`;
const sha = "a".repeat(64);
const name = `豊かさBOT_対応結果_${eventId}.pdf`;
const sql = `BEGIN; SELECT public.reserve_yutakasa_drive_result('${eventId}','${sha}','${name}'); SELECT pg_sleep(0.3); COMMIT;`;

async function oneReservation() {
  const { stdout } = await exec("docker", [
    "exec", container, "psql", "-X", "-q", "-A", "-t",
    "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "yutakasa", "-c", sql,
  ], { timeout: 15_000, maxBuffer: 8192 });
  const value = stdout.trim().split("\n").find((line) =>
    line === "reserved" || line === "pending"
  );
  assert.ok(value, "reservation result missing");
  return value;
}

const results = await Promise.all([oneReservation(), oneReservation()]);
assert.deepEqual(results.sort(), ["pending", "reserved"]);
const { stdout } = await exec("docker", [
  "exec", container, "psql", "-X", "-q", "-A", "-t",
  "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "yutakasa",
  "-c", `SELECT count(*) || ':' || min(status) FROM public.yutakasa_drive_result_publications WHERE event_id='${eventId}'`,
], { timeout: 15_000, maxBuffer: 8192 });
assert.equal(stdout.trim(), "1:posting");
process.stdout.write("Drive publication concurrent reservation: one reserved, one pending\n");
