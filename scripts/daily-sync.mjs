import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";

const lockFile = path.resolve(process.env.SYNC_LOCK_FILE || "data/daily-sync.lock");
let fd;
try {
  fd = openSync(lockFile, "wx");
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error(`已有同步任务运行中，跳过本次执行（${lockFile}）`);
    process.exit(0);
  }
  throw error;
}

const cleanup = () => {
  try { closeSync(fd); } catch {}
  try { unlinkSync(lockFile); } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "cli", "--", "run", "--out", "out"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(`每日同步启动失败：${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`每日同步被信号 ${signal} 终止`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
