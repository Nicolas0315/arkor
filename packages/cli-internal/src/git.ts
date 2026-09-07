import { spawn } from "node:child_process";

// IMPORTANT: do NOT pass `shell: process.platform === "win32"` to these
// `spawn("git", ...)` calls. `git` ships as `git.exe` on Windows so libuv
// resolves it through PATHEXT without a shell, and routing through cmd.exe
// instead corrupts the `git commit -m "<message>"` argument: the message
// includes spaces and backticks (e.g. ``Initial commit from `arkor init` ``),
// and Node's Windows shell-mode quoting wraps the whole arg in double quotes
// while the surrounding cmd.exe `/c "<cmd>"` framing turns the resulting
// nested quotes into a malformed command line. Git then sees a shorter or
// empty message and either silently no-ops or commits unexpected content,
// reporting exit 0, leaving the scaffolded directory with a `.git/HEAD` but
// no commit. Only `pnpm`/`yarn`/`bun`-style `.cmd` shims need shell:true
// (see `install.ts`); plain `.exe` binaries do not.

/**
 * Whether `cwd` is already inside a Git working tree. We check so we don't
 * clobber an existing repo by running `git init` on top of it.
 */
export async function isInGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export interface InitialCommitResult {
  /**
   * `true` when the user's signing config was active but the actual signing
   * step failed (missing key, agent timeout, etc.); we then retried with
   * `commit.gpgsign=false` and produced an unsigned commit. Callers can use
   * this to surface a one-line notice.
   */
  signingFallback: boolean;
}

// A broken signing agent can block `git commit` without ever returning an
// error (observed with op-ssh-sign.exe on Windows). Keep the escape hatch
// bounded so scaffold commands do not hang indefinitely, while leaving
// ordinary Git commands untouched.
const INITIAL_COMMIT_TIMEOUT_MS = 5_000;

/**
 * `git init && git add -A && git commit -m <message>` in `cwd`.
 *
 * Signing policy: respect the user's git config first. If the commit fails
 * specifically because signing failed (broken GPG/SSH setup), retry once with
 * signing disabled so the scaffold finishes; any other failure surfaces.
 */
export async function gitInitialCommit(
  cwd: string,
  message: string,
): Promise<InitialCommitResult> {
  await runGit(cwd, ["init", "-q"]);
  await runGit(cwd, ["add", "-A"]);

  const first = await tryGit(
    cwd,
    ["commit", "-q", "-m", message],
    INITIAL_COMMIT_TIMEOUT_MS,
  );
  if (first.code === 0) return { signingFallback: false };

  if (looksLikeSigningFailure(first.stderr) || first.timedOut) {
    await runGit(cwd, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ]);
    return { signingFallback: true };
  }

  throw new Error(
    `\`git commit\` exited with code ${first.code}: ${
      first.stderr.trim() || "(no stderr)"
    }`,
  );
}

function looksLikeSigningFailure(stderr: string): boolean {
  // Covers GPG (`gpg failed to sign`, `gpg: signing failed`) and SSH
  // (`error: signing failed: <reason>`) variants. 1Password's SSH signer
  // reports an agent error followed by Git's generic commit-object failure.
  return /failed to sign|signing failed|gpg failed|1password:\s*agent returned an error/i.test(
    stderr,
  );
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`\`git ${args.join(" ")}\` exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function tryGit(
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            // On Windows, `git commit` can leave its signing helper alive
            // after the parent is killed. Terminate the whole tree first so
            // the helper cannot retain `.git/index.lock` during the retry.
            if (process.platform === "win32" && child.pid !== undefined) {
              const killer = spawn(
                "taskkill.exe",
                ["/PID", String(child.pid), "/T", "/F"],
                { stdio: "ignore" },
              );
              killer.on("error", () => child.kill());
              killer.on("close", (code) => {
                if (code !== 0 && !child.killed) child.kill();
              });
            } else {
              child.kill();
            }
          }, timeoutMs);
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stderr: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });
  });
}
