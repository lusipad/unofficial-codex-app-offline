// @ts-nocheck
export {};

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

/**
 * 26.908 pending worktree 状态机，对齐桌面主进程 WorktreeService（XVe）的契约：
 * renderer 通过 dispatchMessage('pending-worktree-create', {hostId, request}) 把
 * worktree 创建托管给宿主；宿主推进 queued → creating → setting-up → worktree-ready/failed，
 * 每一步全量广播 pending_worktrees shared object。thread/start 由 renderer 自己发起，
 * 宿主不代劳；settle 后 renderer 发 pending-worktree-update-metadata / -dismiss 收尾。
 */
function createPendingWorktreeHandlers(deps) {
  const broadcast = deps.broadcast;
  const logger = deps.logger;
  const SHARED_OBJECT_SNAPSHOT = deps.sharedObjectSnapshot;
  const codexHome = deps.codexHome;

  const entriesById = new Map();
  const abortControllersById = new Map();

  function publish() {
    const value = [...entriesById.values()];
    SHARED_OBJECT_SNAPSHOT.set("pending_worktrees", value);
    if (typeof broadcast === "function") {
      broadcast({ channel: "shared-object-updated", payload: { key: "pending_worktrees", value } });
    }
  }

  function updateEntry(id, updater) {
    const entry = entriesById.get(id);
    if (!entry) return null;
    const next = updater(entry);
    entriesById.set(id, next);
    publish();
    return next;
  }

  function runGit(args, options) {
    options = options || {};
    return new Promise((resolve) => {
      const child = execFile(
        "git",
        args,
        { encoding: "utf8", timeout: options.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
            error: error || null,
          });
        }
      );
      const controller = options.signalController;
      if (controller) {
        controller.__gitChild = child;
      }
    });
  }

  function abortCreation(id) {
    const controller = abortControllersById.get(id);
    if (!controller) return;
    controller.aborted = true;
    if (controller.__gitChild) {
      try {
        controller.__gitChild.kill();
      } catch {}
    }
  }

  function isAborted(id) {
    const controller = abortControllersById.get(id);
    return !!(controller && controller.aborted);
  }

  /** 计算 worktree 落盘路径：<worktreesRoot>/<4位十六进制>/<仓库名>，冲突时追加序号。 */
  function allocateWorktreePath(worktreesRoot, repoRoot) {
    const segment = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
    const base = path.basename(repoRoot) || "worktree";
    const parent = path.join(worktreesRoot, segment);
    let candidate = path.join(parent, base);
    let counter = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(parent, `${base}-${counter}`);
      counter += 1;
    }
    return candidate;
  }

  function defaultWorktreesRoot() {
    return path.join(codexHome || path.join(os.homedir(), ".codex"), "worktrees");
  }

  function removeWorktreeQuietly(repoRoot, worktreePath) {
    // 对齐桌面 delete-worktree 的 git worktree remove --force；失败只记日志，不阻断状态机。
    runGit(["-C", repoRoot, "worktree", "remove", "--force", worktreePath]).then((result) => {
      if (!result.ok && logger && logger.warn) {
        logger.warn(`[pending-worktree] cleanup failed for ${worktreePath}: ${result.stderr || result.error}`);
      }
    });
  }

  async function startCreation(id) {
    const entry = entriesById.get(id);
    if (!entry) return;
    const controller = { aborted: false, __gitChild: null };
    abortControllersById.set(id, controller);

    updateEntry(id, (current) => ({
      ...current,
      phase: "creating",
      worktreeOutputText: "[info] Starting worktree creation\n",
    }));

    const fail = (message) => {
      if (isAborted(id)) return;
      updateEntry(id, (current) => ({
        ...current,
        phase: "failed",
        errorMessage: message,
        needsAttention: true,
        worktreeOutputText: `${entriesById.get(id).worktreeOutputText || ""}[stderr] ${message}\n`,
      }));
    };

    const cwd = typeof entry.sourceWorkspaceRoot === "string" ? entry.sourceWorkspaceRoot : "";
    if (!cwd) {
      fail("Missing sourceWorkspaceRoot");
      return;
    }

    const runGitControlled = (args) => runGit(args, { signalController: controller });
    const topLevel = await runGitControlled(["-C", cwd, "rev-parse", "--show-toplevel"]);
    if (isAborted(id)) return;
    if (!topLevel.ok || !topLevel.stdout.trim()) {
      fail((topLevel.stderr || "Not a git repository").trim());
      return;
    }
    const repoRoot = topLevel.stdout.trim();

    // startingState: {type:'branch', branchName} 或 {type:'working-tree'}（含未提交改动）。
    const startingState = entry.startingState && typeof entry.startingState === "object" ? entry.startingState : {};
    let startingRef = "HEAD";
    if (startingState.type === "branch" && typeof startingState.branchName === "string" && startingState.branchName) {
      startingRef = startingState.branchName;
    }

    // working-tree：先把未提交改动打成 patch，建好后应用到新 worktree。
    let pendingDiff = null;
    let untrackedFiles = [];
    if (startingState.type === "working-tree") {
      const diff = await runGitControlled(["-C", repoRoot, "diff", "HEAD", "--binary"]);
      if (isAborted(id)) return;
      if (diff.ok && diff.stdout) pendingDiff = diff.stdout;
      const status = await runGitControlled(["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"]);
      if (isAborted(id)) return;
      if (status.ok && status.stdout) {
        untrackedFiles = status.stdout.split("\0").filter(Boolean);
      }
    }

    const worktreesRoot = defaultWorktreesRoot();
    const worktreePath = allocateWorktreePath(worktreesRoot, repoRoot);
    try {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }

    const add = await runGitControlled(["-C", repoRoot, "worktree", "add", "--detach", worktreePath, startingRef]);
    if (isAborted(id)) return;
    if (!add.ok) {
      fail((add.stderr || (add.error && add.error.message) || "git worktree add failed").trim());
      return;
    }

    if (pendingDiff) {
      const apply = await runGitControlled(["-C", worktreePath, "apply", "--whitespace=nowarn", "-"], null);
      if (isAborted(id)) return;
      if (!apply.ok) {
        removeWorktreeQuietly(repoRoot, worktreePath);
        fail((apply.stderr || "Failed to apply working-tree changes").trim());
        return;
      }
    }
    for (const relative of untrackedFiles) {
      try {
        const from = path.join(repoRoot, relative);
        const to = path.join(worktreePath, relative);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      } catch {}
    }

    if (isAborted(id)) return;
    // worktreeGitRoot = 新 worktree 的仓库根；worktreeWorkspaceRoot = 源 cwd 映射到 worktree 内的对应路径。
    const relativeCwd = path.relative(repoRoot, path.resolve(cwd));
    const worktreeWorkspaceRoot =
      relativeCwd && !relativeCwd.startsWith("..") && !path.isAbsolute(relativeCwd)
        ? path.join(worktreePath, relativeCwd)
        : worktreePath;
    updateEntry(id, (current) => ({
      ...current,
      phase: "worktree-ready",
      worktreeGitRoot: worktreePath,
      worktreeWorkspaceRoot,
    }));
  }

  function handleCreate(payload) {
    const request = payload && typeof payload === "object" ? payload.request : null;
    if (!request || typeof request !== "object" || typeof request.id !== "string" || !request.id) {
      throw new Error("pending-worktree-create is missing request.id");
    }
    // 对齐桌面 create(e)：先补默认值再登记，renderer 卡片组件直接读这些字段。
    entriesById.set(request.id, {
      createdAt: Date.now(),
      attempt: 1,
      phase: "queued",
      labelEdited: false,
      worktreeOutputText: "",
      setupOutputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
      isPinned: false,
      pinnedBeforeThreadId: null,
      ...request,
    });
    publish();
    startCreation(request.id).catch((error) => {
      if (logger && logger.warn) logger.warn("[pending-worktree] create failed", error);
      updateEntry(request.id, (current) => ({
        ...current,
        phase: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        needsAttention: true,
      }));
    });
    return true;
  }

  function handleCancel(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const entry = entriesById.get(id);
    if (!entry) return true;
    const continueLocally = payload.continueLocally === true;
    abortCreation(id);
    if (continueLocally) {
      updateEntry(id, (current) => ({
        ...current,
        executionTarget: "source-workspace",
        phase: "worktree-ready",
        worktreeWorkspaceRoot: current.sourceWorkspaceRoot,
        worktreeGitRoot: null,
        errorMessage: null,
        needsAttention: false,
      }));
      if (entry.worktreeGitRoot && entry.phase !== "worktree-ready") {
        removeWorktreeQuietly(entry.worktreeGitRoot, entry.worktreeGitRoot);
      }
      return true;
    }
    entriesById.delete(id);
    publish();
    return true;
  }

  function handleDismiss(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const entry = entriesById.get(id);
    abortCreation(id);
    entriesById.delete(id);
    publish();
    if (entry && entry.phase === "failed" && entry.worktreeGitRoot) {
      removeWorktreeQuietly(entry.worktreeGitRoot, entry.worktreeGitRoot);
    }
    return true;
  }

  function handleRetry(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const entry = entriesById.get(id);
    if (!entry || entry.conversationStartResult != null) return true;
    abortCreation(id);
    updateEntry(id, (current) => ({
      ...current,
      attempt: (current.attempt || 1) + 1,
      phase: "queued",
      worktreeOutputText: "",
      setupOutputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
    }));
    startCreation(id).catch((error) => {
      updateEntry(id, (current) => ({
        ...current,
        phase: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        needsAttention: true,
      }));
    });
    return true;
  }

  function handleContinue(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const entry = entriesById.get(id);
    if (!entry || entry.phase !== "failed" || !entry.worktreeGitRoot || !entry.worktreeWorkspaceRoot) {
      return true;
    }
    updateEntry(id, (current) => ({
      ...current,
      phase: "worktree-ready",
      needsAttention: false,
      setupOutputText: `${current.setupOutputText || ""}[info] Continuing without local environment setup\n`,
    }));
    return true;
  }

  function handleUpdateMetadata(payload) {
    const id = typeof payload.id === "string" ? payload.id : "";
    const update = payload.update && typeof payload.update === "object" ? payload.update : null;
    if (!entriesById.has(id) || !update || typeof update.type !== "string") return true;
    updateEntry(id, (current) => {
      const next = { ...current };
      switch (update.type) {
        case "conversationStartResult":
          next.conversationStartResult = update.result !== undefined ? update.result : update.value;
          break;
        case "pinnedBeforeThreadId":
          next.pinnedBeforeThreadId = update.beforeThreadId !== undefined ? update.beforeThreadId : update.value;
          break;
        default:
          next[update.type] = update[update.type] !== undefined ? update[update.type] : update.value;
          break;
      }
      return next;
    });
    return true;
  }

  /** 处理 pending-worktree-* view message；不认识的类型返回 false 交回上层。 */
  function handlePendingWorktreeMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    switch (payload.type) {
      case "pending-worktree-create":
        return handleCreate(payload);
      case "pending-worktree-cancel":
        return handleCancel(payload);
      case "pending-worktree-dismiss":
        return handleDismiss(payload);
      case "pending-worktree-retry":
        return handleRetry(payload);
      case "pending-worktree-continue":
        return handleContinue(payload);
      case "pending-worktree-update-metadata":
        return handleUpdateMetadata(payload);
      default:
        return false;
    }
  }

  return {
    handlePendingWorktreeMessage,
  };
}

module.exports = {
  createPendingWorktreeHandlers,
};
