import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const uninstall = await readFile(new URL("../uninstall.sh", import.meta.url), "utf8");
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** put_command with every path in a temporary folder and the server account being whoever runs the test. */
async function putCommand({ existing, existingMetal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "omb-install-command-"));
  dirs.push(dir);
  const home = join(dir, "home"), cli = join(dir, "duskbot"), metal = join(dir, "metal");
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(join(home, ".local/bin/duskbot"), '#!/bin/sh\necho "server duskbot $HOME $*"\n', { mode: 0o755 });
  if (existing !== undefined) await writeFile(cli, existing, { mode: 0o755 });
  if (existingMetal !== undefined) await writeFile(metal, existingMetal, { mode: 0o755 });
  const file = join(dir, "fixture.sh");
  await writeFile(file, `${script}
SVC_USER=${userInfo().username} SVC_HOME=${home} CLI=${cli} TMP=${dir}
install() {
  _args=""
  while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) _args="$_args '$1'"; shift ;; esac; done
  eval "command install $_args"
}
put_command
`);
  const { stdout } = await run("sh", [file], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
  return { stdout, cli, metal, home, wrapper: await readFile(cli, "utf8") };
}

describe("the commands an install puts on the PATH", () => {
  it("runs the server account's own build as that account via metal or duskbot", async () => {
    const { stdout, cli, metal, home, wrapper } = await putCommand();
    expect(stdout).toContain("duskbot now runs from any login on this server");
    expect(stdout).toContain("metal now runs from any login on this server");
    expect(wrapper).toContain("managed by duskbot-link");
    expect(wrapper).toContain(`runuser -u ${userInfo().username} -- env HOME=${home}`);
    expect(wrapper).toContain(`sudo -u ${userInfo().username} -- env HOME=${home}`);
    for (const command of [cli, metal]) {
      const ran = await run(command, ["pair", "--label", "desktop"], { env: { PATH: "/usr/bin:/bin", HOME: "/nowhere" } });
      expect(ran.stdout.trim()).toBe(`server duskbot ${home} pair --label desktop`);
    }
  });

  it("leaves commands that something else installed", async () => {
    const { stdout, cli, metal, wrapper } = await putCommand({ existing: "#!/bin/sh\necho npm\n", existingMetal: "#!/bin/sh\necho another metal\n" });
    expect(stdout).toContain(`left ${cli} as it is`);
    expect(stdout).toContain(`left ${metal} as it is`);
    expect(wrapper).toBe("#!/bin/sh\necho npm\n");
    expect(await readFile(metal, "utf8")).toBe("#!/bin/sh\necho another metal\n");
  });

  it("writes nothing when its own wrapper is already there, and refreshes an older one of its own", async () => {
    const first = await putCommand();
    const again = await run("sh", [join(first.cli, "..", "fixture.sh")], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
    expect(again.stdout).toBe("");
    const older = await putCommand({ existing: "#!/bin/sh\n# managed by duskbot-link: an older wrapper\n" });
    expect(older.stdout).toContain("duskbot now runs from any login on this server");
    expect(older.wrapper).toContain("runuser -u");
  });

  it("is taken off by uninstall only when it is ours", () => {
    expect(uninstall).toContain("CLI=/usr/local/bin/duskbot");
    expect(uninstall).toContain('for path in "$CLI" "${CLI%/*}/metal"; do');
    expect(uninstall).toMatch(/cli_ours\(\) \{ \[ ! -L "\$1" \] && grep -qs "managed by duskbot-link" "\$1"; \}/);
    expect(uninstall).toMatch(/if cli_ours "\$path"; then x rm -f "\$path"/);
  });
});
