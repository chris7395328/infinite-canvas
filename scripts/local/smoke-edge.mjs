// Read-only connectivity test in a disposable Edge profile, never the user's original data.
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../..");
const runtime = join(root, ".runtime/local");
const cert = new X509Certificate(readFileSync(join(runtime, "cert.pem")));
const pin = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
const edge = process.argv[2];
if (!edge) throw new Error("请传入本机msedge.exe路径，仅使用临时测试配置。");
const { stdout } = await promisify(execFile)(edge, ["--headless", "--no-first-run", "--disable-gpu", `--user-data-dir=${join(runtime, "edge-smoke")}`, "--host-resolver-rules=MAP 192.168.123.232:3001 127.0.0.1:3001", `--ignore-certificate-errors-spki-list=${pin}`, "--dump-dom", "https://192.168.123.232:3001/__local/status"], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
assert.match(stdout, /infinite-canvas-local/);
assert.match(stdout, /https:\/\/192\.168\.123\.232:3001/);
console.log("EDGE_LOCAL_ORIGIN_SMOKE_PASSED (isolated profile; original browser data not evaluated)");
