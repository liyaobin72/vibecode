const { spawnSync } = require("child_process");
const path = require("path");

const root = __dirname;
const extra = process.argv.slice(2);
const args = [path.join(root, "server.py"), "--refresh", ...extra];
const result = spawnSync("python", args, { cwd: root, encoding: "utf8", stdio: "inherit", timeout: 2 * 60 * 60 * 1000 });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
