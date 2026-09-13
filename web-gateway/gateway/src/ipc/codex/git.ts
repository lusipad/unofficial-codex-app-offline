// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function createGitIpcHandlers(deps) {
  const realpathSafe = deps.realpathSafe;
  const isWithinAllowedRoots = deps.isWithinAllowedRoots;
  const parseWorkspaceRoots = deps.parseWorkspaceRoots;

  /** 从任意项目路径向上寻找 git root，并校验仍在 allowlist 内。 */
  function findGitRoot(candidatePath) {
    const start = realpathSafe(candidatePath);
    if (!start || !isWithinAllowedRoots(start)) return null;
    const cwd = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
    try {
      const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const resolved = realpathSafe(output);
      return resolved && isWithinAllowedRoots(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }

  /** 从各类 git IPC payload 中解析 cwd/root/projectPath。 */
  function resolveGitTargetPath(payload) {
    const params =
      payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
        ? payload.params
        : payload;
    const direct =
      params && typeof params === "object"
        ? params.cwd || params.root || params.path || params.rootPath || params.projectPath || null
        : null;
    return typeof direct === "string" && direct.trim() ? direct : parseWorkspaceRoots()[0] || null;
  }

  /** 归一化 git 分支名，去掉状态行、远端前缀和展示附加信息。 */
  function normalizeBranchName(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.replace(/^##\s*/, "").trim();
    if (!trimmed) return null;
    return trimmed
      .split("...")[0]
      .replace(/\s+\[.*\]$/, "")
      .replace(/^heads\//, "")
      .trim() || null;
  }

  /** 获取 git common dir，兼容 worktree。 */
  function gitCommonDir(gitRoot) {
    try {
      const raw = execFileSync("git", ["-C", gitRoot, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(gitRoot, raw);
      return realpathSafe(resolved) || resolved;
    } catch {
      return path.join(gitRoot, ".git");
    }
  }

  /** stable-metadata IPC 返回 git root/commonDir，供 renderer 缓存项目身份。 */
  function gitStableMetadataForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return null;
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return null;
    return {
      root: gitRoot,
      commonDir: gitCommonDir(gitRoot),
    };
  }

  /** 获取当前分支；detached HEAD 时返回短 hash 展示值。 */
  function currentGitBranchForRoot(gitRoot) {
    try {
      const branch = execFileSync("git", ["-C", gitRoot, "branch", "--show-current"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (branch) return branch;
    } catch {}

    try {
      const branch = execFileSync("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (branch && branch !== "HEAD") return branch;
    } catch {}

    try {
      const revision = execFileSync("git", ["-C", gitRoot, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return revision ? `HEAD (${revision})` : null;
    } catch {
      return null;
    }
  }

  /** 读取仓库默认分支配置；没有配置时按 git 旧默认值 master 兜底。 */
  function gitDefaultBranchForRoot(gitRoot) {
    // 对齐桌面语义：优先远端 HEAD，其次当前分支，再退到本地分支列表（偏好 main/master）。
    try {
      const ref = execFileSync("git", ["-C", gitRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const branch = ref.replace(/^[^/]+\//, "");
      if (branch) return branch;
    } catch {}
    try {
      const current = execFileSync("git", ["-C", gitRoot, "branch", "--show-current"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (current) return current;
    } catch {}
    try {
      const branches = execFileSync("git", ["-C", gitRoot, "branch", "--format=%(refname:short)"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (branches.includes("main")) return "main";
      if (branches.includes("master")) return "master";
      if (branches.length > 0) return branches[0];
    } catch {}
    try {
      const branch = execFileSync("git", ["-C", gitRoot, "config", "--get", "init.defaultBranch"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (normalizeBranchName(branch)) return normalizeBranchName(branch);
    } catch {}
    // 空仓库/未知时返回 null，renderer 侧按 main 兜底。
    return null;
  }

  /** current-branch IPC 的本地实现。 */
  function currentBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: null };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), branch: null };
    return {
      root: gitRoot,
      branch: currentGitBranchForRoot(gitRoot),
    };
  }

  /** recent-branches/search-branches IPC 的本地实现。 */
  function recentBranchesForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    const limit =
      payload && typeof payload === "object" && Number.isFinite(Number(payload.limit))
        ? Math.max(1, Math.min(500, Number(payload.limit)))
        : 100;
    if (!target) return { branches: [] };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { branches: [] };

    try {
      const raw = execFileSync(
        "git",
        ["-C", gitRoot, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      const current = currentGitBranchForRoot(gitRoot);
      const seen = new Set();
      const branches = [];
      const add = (branch) => {
        const normalized = normalizeBranchName(branch);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        branches.push(normalized);
      };
      add(current);
      raw.split(/\r?\n/).forEach(add);
      if (!gitHasHeadCommit(gitRoot)) {
        for (const branch of [gitDefaultBranchForRoot(gitRoot), "master", "main"]) {
          add(branch);
        }
      }
      return { root: gitRoot, branches: branches.slice(0, limit) };
    } catch {
      return { root: gitRoot, branches: [] };
    }
  }

  /** 解析创建/切换分支所需的 cwd 和 branch。 */
  function gitBranchMutationPayload(payload) {
    const params =
      payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
        ? payload.params
        : payload;
    const cwd = resolveGitTargetPath(params);
    const branch =
      params && typeof params === "object" && typeof params.branch === "string"
        ? params.branch.trim()
        : "";
    return { params, cwd, branch };
  }

  /** 使用 git check-ref-format 校验分支名，避免 shell/路径注入。 */
  function validateBranchName(gitRoot, branch) {
    if (!branch) throw new Error("Missing branch name");
    try {
      execFileSync("git", ["-C", gitRoot, "check-ref-format", "--branch", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error(`Invalid branch name: ${branch}`);
    }
  }

  /** 判断本地分支是否存在。 */
  function gitBranchExists(gitRoot, branch) {
    try {
      execFileSync("git", ["-C", gitRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 判断仓库是否已有 HEAD 提交；新仓库创建分支要走 unborn 分支路径。 */
  function gitHasHeadCommit(gitRoot) {
    try {
      execFileSync("git", ["-C", gitRoot, "rev-parse", "--verify", "--quiet", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 新仓库还没有提交时，通过 symbolic-ref 切换 unborn 分支。 */
  function setGitSymbolicHead(gitRoot, branch) {
    execFileSync("git", ["-C", gitRoot, "symbolic-ref", "HEAD", `refs/heads/${branch}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** 把 git 操作异常统一成 renderer 可展示的对象。 */
  function gitMutationError(error, fallbackMessage = "Git operation failed") {
    const message = error instanceof Error ? error.message : String(error || fallbackMessage);
    return {
      status: "error",
      error: message || fallbackMessage,
      message: message || fallbackMessage,
      execOutput: message || null,
    };
  }

  /** 创建本地分支；兼容空仓库，不再假设一定存在 master。 */
  function createGitBranchForPayload(payload) {
    const { params, cwd, branch } = gitBranchMutationPayload(payload);
    if (!cwd) return gitMutationError("Missing cwd");
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return gitMutationError("Not a git repository");

    try {
      validateBranchName(gitRoot, branch);
      if (!gitHasHeadCommit(gitRoot)) {
        const current = currentGitBranchForRoot(gitRoot);
        if (current === branch) {
          return { status: "success", branch, root: gitRoot, alreadyCurrent: true, unborn: true };
        }
        setGitSymbolicHead(gitRoot, branch);
        return { status: "success", branch, root: gitRoot, unborn: true };
      }

      const exists = gitBranchExists(gitRoot, branch);
      if (exists) {
        if (params && typeof params === "object" && params.failIfExists) {
          return gitMutationError(`Branch already exists: ${branch}`, "Branch already exists");
        }
        return { status: "success", branch, root: gitRoot, alreadyExists: true };
      }

      execFileSync("git", ["-C", gitRoot, "branch", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: "success", branch, root: gitRoot };
    } catch (error) {
      return gitMutationError(error);
    }
  }

  /** 切换分支；遇到工作区阻塞时返回 renderer 能识别的 errorType。 */
  function checkoutGitBranchForPayload(payload) {
    const { cwd, branch } = gitBranchMutationPayload(payload);
    if (!cwd) return gitMutationError("Missing cwd");
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return gitMutationError("Not a git repository");

    try {
      validateBranchName(gitRoot, branch);
      if (currentGitBranchForRoot(gitRoot) === branch) {
        return { status: "success", branch, root: gitRoot, alreadyCurrent: true };
      }
      if (!gitHasHeadCommit(gitRoot)) {
        setGitSymbolicHead(gitRoot, branch);
        return { status: "success", branch, root: gitRoot, unborn: true };
      }

      execFileSync("git", ["-C", gitRoot, "checkout", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: "success", branch, root: gitRoot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = gitMutationError(error);
      if (/would be overwritten|Please commit your changes|would be lost/i.test(message)) {
        result.errorType = "blocked-by-working-tree-changes";
        result.conflictedPaths = [];
      }
      return result;
    }
  }

  /** 计算 base branch，优先 origin/HEAD，其次 main/master，最后当前分支。 */
  function baseBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: "main", baseBranch: "main", defaultBranch: "main" };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { branch: "main", baseBranch: "main", defaultBranch: "main" };

    if (!gitHasHeadCommit(gitRoot)) {
      const branch = gitDefaultBranchForRoot(gitRoot);
      return { root: gitRoot, branch, baseBranch: branch, defaultBranch: branch, unborn: true };
    }

    const candidates = [];
    try {
      const originHead = execFileSync("git", ["-C", gitRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (originHead) candidates.push(originHead.replace(/^origin\//, ""));
    } catch {}
    for (const candidate of ["main", "master"]) {
      if (gitBranchExists(gitRoot, candidate)) candidates.push(candidate);
    }
    const branch = candidates.find(Boolean) || currentGitBranchForRoot(gitRoot) || "main";
    return { root: gitRoot, branch, baseBranch: branch, defaultBranch: branch };
  }

  function gitDefaultBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: null, defaultBranch: null };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), branch: null, defaultBranch: null };
    const branch = gitDefaultBranchForRoot(gitRoot);
    return { root: gitRoot, gitRoot, branch, defaultBranch: branch };
  }

  function gitUpstreamBranchForRoot(gitRoot) {
    try {
      const upstreamRef = execFileSync("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return upstreamRef || null;
    } catch {
      return null;
    }
  }

  function gitUpstreamBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: null, upstreamRef: null };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), gitRoot: null, branch: null, upstreamRef: null };
    return {
      root: gitRoot,
      gitRoot,
      branch: currentGitBranchForRoot(gitRoot),
      upstreamRef: gitUpstreamBranchForRoot(gitRoot),
    };
  }

  function gitBranchAheadCountForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { gitRoot: null, branch: null, defaultBranch: null, upstreamRef: null, commitsAhead: 0 };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) {
      return {
        root: realpathSafe(target) || path.resolve(target),
        gitRoot: null,
        branch: null,
        defaultBranch: null,
        upstreamRef: null,
        commitsAhead: 0,
      };
    }
    const branch = currentGitBranchForRoot(gitRoot);
    const defaultBranch = gitDefaultBranchForRoot(gitRoot);
    const upstreamRef = gitUpstreamBranchForRoot(gitRoot);
    let commitsAhead = 0;
    if (upstreamRef && gitHasHeadCommit(gitRoot)) {
      try {
        const raw = execFileSync("git", ["-C", gitRoot, "rev-list", "--count", `${upstreamRef}..HEAD`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        commitsAhead = Number.parseInt(raw, 10) || 0;
      } catch {
        commitsAhead = 0;
      }
    }
    return { root: gitRoot, gitRoot, branch, defaultBranch, upstreamRef, commitsAhead };
  }

  /** branch-diff-stats IPC：统计当前分支相对 base branch 的增删行数。 */
  function gitBranchDiffStatsForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return null;
    const gitRoot = findGitRoot(target);
    if (!gitRoot || !gitHasHeadCommit(gitRoot)) return null;

    const params =
      payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
        ? payload.params
        : payload;
    const explicitBase =
      params && typeof params === "object" && typeof params.baseBranch === "string"
        ? params.baseBranch.trim()
        : "";
    const baseBranch = explicitBase || baseBranchForPayload(params).baseBranch || gitUpstreamBranchForRoot(gitRoot);
    const candidates = [];
    if (baseBranch) {
      candidates.push(baseBranch);
      if (!baseBranch.includes("/") && baseBranch !== "HEAD") candidates.push(`origin/${baseBranch}`);
    }
    const upstreamRef = gitUpstreamBranchForRoot(gitRoot);
    if (upstreamRef) candidates.push(upstreamRef);

    let raw = null;
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      try {
        raw = execFileSync("git", ["-C", gitRoot, "diff", "--numstat", `${candidate}...HEAD`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        });
        break;
      } catch {}
    }
    if (raw == null) {
      try {
        raw = execFileSync("git", ["-C", gitRoot, "diff", "--numstat", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        });
      } catch {
        return null;
      }
    }

    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const line of String(raw).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [added, removed] = line.split(/\t/);
      const addedCount = Number.parseInt(added, 10);
      const removedCount = Number.parseInt(removed, 10);
      if (Number.isFinite(addedCount)) additions += addedCount;
      if (Number.isFinite(removedCount)) deletions += removedCount;
      filesChanged += 1;
    }
    return { additions, deletions, filesChanged };
  }

  function gitStatusSummaryForPayload(payload) {
    const status = gitStatusForPayload(payload);
    if (!status) return { isGitRepo: false, branch: null, clean: true, entries: [] };
    return {
      ...status,
      hasUncommittedChanges: Array.isArray(status.entries) ? status.entries.length > 0 : !status.clean,
    };
  }

  function gitSubmodulePathsForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { root: null, paths: [] };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), paths: [] };
    try {
      const raw = execFileSync("git", ["-C", gitRoot, "config", "--file", ".gitmodules", "--get-regexp", "path"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const paths = raw
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
        .filter(Boolean);
      return { root: gitRoot, paths };
    } catch {
      return { root: gitRoot, paths: [] };
    }
  }

  /** 扫描 worktree 目录对应的主仓库根（对齐桌面 worker 的 gitDir 契约）。 */
  function gitCommonRootForWorktreeDir(dir) {
    const result = runQuietCommand("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], 1500);
    if (!result.ok || !result.stdout) return null;
    const commonDir = path.normalize(result.stdout.trim());
    if (!commonDir) return null;
    return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  }

  // 26.908 桌面 worker 契约（Khe）：扫描 worktreesRoot 下两级目录，
  // 返回 {dir, gitDir}；renderer 按 gitDir 分组、按 dir 统计会话。
  function codexWorktreesForPayload(payload) {
    const rootParam =
      payload && typeof payload === "object" && typeof payload.worktreesRoot === "string"
        ? payload.worktreesRoot.trim()
        : "";
    const worktreesRoot = rootParam || path.join(require("os").homedir(), ".codex", "worktrees");
    const worktrees = [];
    let parents = [];
    try {
      parents = fs.readdirSync(worktreesRoot, { withFileTypes: true });
    } catch {
      return { worktrees };
    }
    for (const parent of parents) {
      if (!parent.isDirectory()) continue;
      const parentPath = path.join(worktreesRoot, parent.name);
      let entries = [];
      try {
        entries = fs.readdirSync(parentPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(parentPath, entry.name);
        // 链接 worktree 的 .git 是指向主仓库的文本文件，普通仓库是目录，二者都算。
        if (!fs.existsSync(path.join(dir, ".git"))) continue;
        worktrees.push({ dir, gitDir: gitCommonRootForWorktreeDir(dir) || dir });
      }
    }
    return { worktrees };
  }

  /** 解析 git status --porcelain 输出为 renderer 更容易消费的结构。 */
  function parseGitStatusLines(lines) {
    return lines
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        if (line.startsWith("##")) {
          return { kind: "branch", raw: line };
        }
        const status = line.slice(0, 2);
        const filePath = line.slice(3);
        return {
          kind: "file",
          status,
          path: filePath,
          staged: status[0] !== " " && status[0] !== "?",
          unstaged: status[1] !== " ",
          untracked: status === "??",
        };
      });
  }

  /** git:status 的本地快速实现，失败时上层会再尝试 app-server。 */
  function gitStatusForPayload(payload) {
    const requestedPath =
      (payload && typeof payload === "object" && (payload.path || payload.root || payload.rootPath || payload.projectPath)) ||
      null;
    const target = requestedPath || parseWorkspaceRoots()[0] || null;
    if (!target) return null;

    const gitRoot = findGitRoot(target);
    if (!gitRoot) {
      return {
        root: realpathSafe(target) || path.resolve(target),
        isGitRepo: false,
        branch: null,
        clean: true,
        entries: [],
      };
    }

    try {
      const raw = execFileSync("git", ["-C", gitRoot, "status", "--short", "--branch"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const entries = parseGitStatusLines(lines);
      const branchLine = entries.find((entry) => entry.kind === "branch");
      const branch = branchLine ? normalizeBranchName(branchLine.raw) : null;
      const fileEntries = entries.filter((entry) => entry.kind === "file");
      return {
        root: gitRoot,
        isGitRepo: true,
        branch,
        clean: fileEntries.length === 0,
        entries: fileEntries,
      };
    } catch {
      return {
        root: gitRoot,
        isGitRepo: true,
        branch: null,
        clean: true,
        entries: [],
      };
    }
  }

  /** 执行本机命令并只返回结果，stdout/stderr 不落日志，避免泄露用户环境细节。 */
  /** 读取仓库 git config；键不存在或仓库无效时返回 null（对齐桌面 worker 行为）。 */
  function gitConfigValueForScope(root, scopeArgs, key) {
    if (!findGitRoot(root)) return null;
    try {
      const out = execFileSync("git", ["-C", root, "config", ...scopeArgs, "--get", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      return out || null;
    } catch {
      return null;
    }
  }

  function runQuietCommand(command, args, timeoutMs) {
    try {
      return {
        ok: true,
        stdout: execFileSync(command, args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: timeoutMs,
        }),
      };
    } catch {
      return { ok: false, stdout: "" };
    }
  }

  /** gh-cli-status IPC：检查 GitHub CLI 是否安装，以及当前本机是否已登录。 */
  function ghCliStatus() {
    const versionResult = runQuietCommand("gh", ["--version"], 1500);
    if (!versionResult.ok) {
      return { isInstalled: false, isAuthenticated: false, version: null };
    }
    const authResult = runQuietCommand("gh", ["auth", "status", "--hostname", "github.com"], 2500);
    const version = versionResult.stdout.split(/\r?\n/).find(Boolean) || null;
    return {
      isInstalled: true,
      isAuthenticated: authResult.ok,
      version,
    };
  }



  /** git worktree list --porcelain 的结构化解析，供 list-worktrees / resolve-worktree-for-thread 使用。 */
  function gitWorktreeListForRoot(gitRoot) {
    const result = runQuietCommand("git", ["-C", gitRoot, "worktree", "list", "--porcelain"], 5000);
    if (!result.ok || !result.stdout) return [];
    const worktrees = [];
    let current = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice(9).trim(), head: null, branch: null, detached: false };
        worktrees.push(current);
      } else if (line.startsWith("HEAD ") && current) {
        current.head = line.slice(5).trim();
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      } else if (line === "detached" && current) {
        current.detached = true;
      }
    }
    return worktrees;
  }

  /** list-worktrees：对齐桌面 getWorktrees，非仓库返回空数组。 */
  function listWorktreesForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    const gitRoot = target ? findGitRoot(target) : null;
    if (!gitRoot) return { worktrees: [] };
    return { worktrees: gitWorktreeListForRoot(gitRoot) };
  }

  function gitConfigGet(dir, key) {
    const result = runQuietCommand("git", ["-C", dir, "config", "--get", key], 1500);
    return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
  }

  function gitConfigSet(dir, key, value) {
    return runQuietCommand("git", ["-C", dir, "config", key, value], 1500).ok;
  }

  function gitHasUncommittedChanges(gitRoot) {
    const result = runQuietCommand("git", ["-C", gitRoot, "status", "--porcelain"], 5000);
    return !!(result.ok && result.stdout.trim());
  }

  /** resolve-worktree-for-thread：cwd 已在 linked worktree 中直接复用；否则按 owner 元数据匹配 conversationId。 */
  function resolveWorktreeForThreadPayload(payload) {
    const params = payload && typeof payload === "object" && payload.params && typeof payload.params === "object" ? payload.params : payload;
    const fallback = { worktreeGitRoot: null, worktreeWorkspaceRoot: null, hasUncommittedChanges: false };
    const cwd = params && typeof params.cwd === "string" ? params.cwd : "";
    if (!cwd) return fallback;
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return fallback;
    const dotGit = path.join(gitRoot, ".git");
    const isLinkedWorktree = fs.existsSync(dotGit) && !fs.statSync(dotGit).isDirectory();
    if (isLinkedWorktree) {
      return {
        worktreeGitRoot: gitRoot,
        worktreeWorkspaceRoot: realpathSafe(cwd) || path.resolve(cwd),
        hasUncommittedChanges: gitHasUncommittedChanges(gitRoot),
      };
    }
    const conversationId = params && typeof params.conversationId === "string" ? params.conversationId : "";
    if (conversationId) {
      for (const worktree of gitWorktreeListForRoot(gitRoot)) {
        if (path.resolve(worktree.path) === path.resolve(gitRoot)) continue;
        if (gitConfigGet(worktree.path, "codex.ownerThreadId") === conversationId) {
          return {
            worktreeGitRoot: worktree.path,
            worktreeWorkspaceRoot: worktree.path,
            hasUncommittedChanges: gitHasUncommittedChanges(worktree.path),
          };
        }
      }
    }
    return fallback;
  }

  /** managed-worktree-state：对齐桌面 Mge 的 available/gone 主路径；snapshot 恢复暂不实现。 */
  function managedWorktreeStateForPayload(payload) {
    const params = payload && typeof payload === "object" && payload.params && typeof payload.params === "object" ? payload.params : payload;
    const worktreePath = params && typeof params.worktreePath === "string" ? params.worktreePath : "";
    try {
      if (worktreePath && fs.statSync(worktreePath).isDirectory()) return { kind: "available" };
    } catch {}
    return { kind: "gone" };
  }

  /** delete-worktree：git worktree remove --force；worktree 参数兼容 {dir, gitDir} 或裸路径。 */
  function deleteWorktreeForPayload(payload) {
    const params = payload && typeof payload === "object" && payload.params && typeof payload.params === "object" ? payload.params : payload;
    const worktree = params ? params.worktree : null;
    const dir =
      typeof worktree === "string"
        ? worktree
        : worktree && typeof worktree === "object"
          ? worktree.dir || worktree.path || ""
          : "";
    if (!dir) return { success: false, worktreeId: null };
    const gitDir = worktree && typeof worktree === "object" && typeof worktree.gitDir === "string" ? worktree.gitDir : dir;
    const result = runQuietCommand("git", ["-C", gitDir, "worktree", "remove", "--force", dir], 30000);
    return { success: result.ok, worktreeId: dir };
  }

  /** worktree-set-owner-thread fetch 端点：把会话归属写进 worktree 的 git config。 */
  function setWorktreeOwnerThreadForPayload(payload) {
    const params = payload && typeof payload === "object" && payload.params && typeof payload.params === "object" ? payload.params : payload;
    const worktree = params ? params.worktree : null;
    const dir =
      typeof worktree === "string"
        ? worktree
        : worktree && typeof worktree === "object"
          ? worktree.dir || worktree.path || worktree.worktreeGitRoot || ""
          : "";
    const conversationId = params && typeof params.conversationId === "string" ? params.conversationId : "";
    if (!dir || !conversationId) return null;
    gitConfigSet(dir, "codex.ownerThreadId", conversationId);
    return null;
  }

  /** Git worker 的业务方法分发，复用本文件中的本地 git 实现。 */
  function handleGitWorkerMethod(method, params) {
    switch (method) {
      case "stable-metadata":
        return gitStableMetadataForPayload(params);
      case "watch-repo":
      case "unwatch-repo":
        return true;
      case "current-branch":
        return currentBranchForPayload(params);
      case "has-head-commit": {
        const target = resolveGitTargetPath(params);
        const gitRoot = target ? findGitRoot(target) : null;
        return { hasHeadCommit: !!(gitRoot && gitHasHeadCommit(gitRoot)) };
      }
      case "upstream-branch":
        return gitUpstreamBranchForPayload(params);
      case "branch-ahead-count":
        return gitBranchAheadCountForPayload(params);
      case "branch-diff-stats":
        return gitBranchDiffStatsForPayload(params);
      case "default-branch":
        return gitDefaultBranchForPayload(params);
      case "status-summary":
        return gitStatusSummaryForPayload(params);
      case "submodule-paths":
        return gitSubmodulePathsForPayload(params);
      case "codex-worktrees":
        return codexWorktreesForPayload(params);
      case "list-worktrees":
        return listWorktreesForPayload(params);
      case "resolve-worktree-for-thread":
        return resolveWorktreeForThreadPayload(params);
      case "managed-worktree-state":
        return managedWorktreeStateForPayload(params);
      case "delete-worktree":
        return deleteWorktreeForPayload(params);
      case "recent-branches":
      case "search-branches": {
        const result = recentBranchesForPayload(params);
        const query =
          params && typeof params === "object" && typeof params.query === "string"
            ? params.query.trim().toLowerCase()
            : "";
        if (!query) return result;
        return {
          ...result,
          branches: result.branches.filter((branch) => branch.toLowerCase().includes(query)),
        };
      }
      case "git-create-branch":
        return createGitBranchForPayload(params);
      case "git-checkout-branch":
        return checkoutGitBranchForPayload(params);
      case "base-branch":
        return baseBranchForPayload(params);
      // 26.908 renderer 新增：live-query 订阅。Web 端没有 worker 推送通道，ACK 即可
      //（renderer 成败走同一回调）。
      case "subscribe-live-query":
        return true;
      // 26.908 新增：git 可用性探测，与桌面 worker 的 {available} 契约一致。
      case "availability":
        return { available: runQuietCommand("git", ["--version"], 1500).ok };
      // 26.908 新增：按 scope 读 git config；缺仓库或键时返回 null（同桌面 worker）。
      case "config-value": {
        const configTarget = resolveGitTargetPath(params);
        const configScope = params && typeof params.scope === "string" ? params.scope : "";
        const scopeArgs = ["local", "global", "system", "worktree"].includes(configScope)
          ? [`--${configScope}`]
          : [];
        const configKey = params && typeof params.key === "string" ? params.key : "";
        if (!configTarget || !configKey) return { value: null };
        return { value: gitConfigValueForScope(configTarget, scopeArgs, configKey) };
      }
      // 26.908 新增：review 摘要。Gateway 没有 review 管线，返回桌面 worker 仓库不可用时的
      // 契约形态，renderer 按“不可评审”正常渲染而不是反复重试。
      case "review-summary":
        return { type: "error", source: params && params.source, failureReason: "repository_unavailable" };
      default:
        throw new Error(`Unsupported git worker method: ${method}`);
    }
  }


  return {
    baseBranchForPayload,
    checkoutGitBranchForPayload,
    createGitBranchForPayload,
    currentBranchForPayload,
    ghCliStatus,
    gitStableMetadataForPayload,
    gitStatusForPayload,
    handleGitWorkerMethod,
    recentBranchesForPayload,
    setWorktreeOwnerThreadForPayload,
  };
}

module.exports = {
  createGitIpcHandlers,
};
