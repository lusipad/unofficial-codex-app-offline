// @ts-nocheck
export {};

const { EventEmitter } = require("node:events");

const CAPNWEB_SENTINEL = "$cw";

const TYPED_ARRAY_CONSTRUCTORS: Record<string, any> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

/** 标记本地对象为 Cap'n Web RpcTarget，传给对端时导出为引用而非按值序列化。 */
class RpcTarget {
  [key: string | symbol]: any;
}

function isRpcTarget(value: unknown): boolean {
  if (value instanceof RpcTarget) return true;
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto !== null && proto !== Object.prototype && !Array.isArray(value) && !(value instanceof Date) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && !(value instanceof Error);
}

/**
 * 模拟 Electron MessagePortMain 的配对内存端口。
 *
 * app-server-host.js 的 uz 传输层先调用 port.start() 再注册 port.on("message")，
 * 因此 start() 排空队列和 postMessage 投递都通过 queueMicrotask 调度，保证 FIFO 且不丢首包。
 */
function createElectronPortPair(): { port1: any; port2: any } {
  function makePort() {
    const emitter: any = new EventEmitter();
    emitter.started = false;
    emitter.closed = false;
    emitter.queue = [];
    emitter.peer = null;

    const flush = () => {
      if (!emitter.started || emitter.queue.length === 0) return;
      const pending = emitter.queue.splice(0, emitter.queue.length);
      for (const item of pending) {
        if (item.kind === "message") {
          emitter.emit("message", { data: item.data });
        } else if (item.kind === "close") {
          emitter.emit("close");
        }
      }
    };

    emitter.deliver = (data: unknown) => {
      if (emitter.closed) return;
      emitter.queue.push({ kind: "message", data });
      if (emitter.started) queueMicrotask(flush);
    };

    emitter.deliverClose = () => {
      if (emitter.closed) return;
      emitter.closed = true;
      emitter.queue.push({ kind: "message", data: null });
      emitter.queue.push({ kind: "close" });
      if (emitter.started) queueMicrotask(flush);
    };

    emitter.start = () => {
      if (emitter.started) return;
      emitter.started = true;
      if (emitter.queue.length > 0) queueMicrotask(flush);
    };

    emitter.postMessage = (data: unknown) => {
      if (emitter.closed || !emitter.peer) return;
      if (data === null) {
        emitter.peer.deliver(null);
        return;
      }
      emitter.peer.deliver(data);
    };

    emitter.postMessageWithSizeLimit = (data: unknown) => {
      emitter.postMessage(data);
    };

    emitter.close = () => {
      if (emitter.closed) return;
      emitter.closed = true;
      emitter.emit("close");
      if (emitter.peer && !emitter.peer.closed) {
        emitter.peer.deliverClose();
      }
    };

    emitter.off = emitter.removeListener.bind(emitter);
    return emitter;
  }

  const port1 = makePort();
  const port2 = makePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

/** 把 structuredClonable 树（含 undefined/BigInt/Date/Uint8Array/NaN/±Infinity）无损编码为纯 JSON 值。 */
function encodeCapnwebFrame(value: unknown): any {
  if (value === undefined) return { [CAPNWEB_SENTINEL]: "undef" };
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { [CAPNWEB_SENTINEL]: "nan" };
    if (value === Infinity) return { [CAPNWEB_SENTINEL]: "inf" };
    if (value === -Infinity) return { [CAPNWEB_SENTINEL]: "-inf" };
    return value;
  }
  if (typeof value === "bigint") {
    return { [CAPNWEB_SENTINEL]: "bigint", v: value.toString() };
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return { [CAPNWEB_SENTINEL]: "date", v: Number.isNaN(time) ? null : time };
  }
  if (value instanceof ArrayBuffer) {
    return { [CAPNWEB_SENTINEL]: "bytes", v: Buffer.from(value).toString("base64"), t: "ArrayBuffer" };
  }
  if (ArrayBuffer.isView(value)) {
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const ctorName = value.constructor?.name || "Uint8Array";
    return ctorName === "Uint8Array"
      ? { [CAPNWEB_SENTINEL]: "bytes", v: buf.toString("base64") }
      : { [CAPNWEB_SENTINEL]: "bytes", v: buf.toString("base64"), t: ctorName };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeCapnwebFrame(item));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, CAPNWEB_SENTINEL)) {
      return {
        [CAPNWEB_SENTINEL]: "obj",
        v: Object.entries(obj).map(([k, v]) => [k, encodeCapnwebFrame(v)]),
      };
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = encodeCapnwebFrame(v);
    }
    return out;
  }
  return null;
}

/** encodeCapnwebFrame 的逆操作，在接收端还原 Date/BigInt/Uint8Array/undefined 等类型。 */
function decodeCapnwebFrame(value: unknown): any {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeCapnwebFrame(item));
  const record = value as Record<string, any>;
  if (Object.prototype.hasOwnProperty.call(record, CAPNWEB_SENTINEL)) {
    switch (record[CAPNWEB_SENTINEL]) {
      case "undef":
        return undefined;
      case "nan":
        return Number.NaN;
      case "inf":
        return Infinity;
      case "-inf":
        return -Infinity;
      case "bigint":
        return BigInt(record.v);
      case "date":
        return record.v === null ? new Date(Number.NaN) : new Date(record.v);
      case "bytes": {
        const raw = Buffer.from(String(record.v || ""), "base64");
        const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        const typeName = record.t;
        if (!typeName || typeName === "Uint8Array") return new Uint8Array(ab);
        if (typeName === "ArrayBuffer") return ab;
        const Ctor = TYPED_ARRAY_CONSTRUCTORS[typeName];
        return Ctor ? new Ctor(ab) : new Uint8Array(ab);
      }
      case "obj": {
        const restored: Record<string, any> = {};
        if (Array.isArray(record.v)) {
          for (const [k, v] of record.v) {
            restored[k] = decodeCapnwebFrame(v);
          }
        }
        return restored;
      }
      default:
        break;
    }
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = decodeCapnwebFrame(v);
  }
  return out;
}

const IMPORT_ENTRY_SYMBOL = Symbol("capnwebLite.importEntry");

/**
 * 面向 Cap'n Web structuredClonable 协议（app-server-host.js）的轻量双向 RPC 会话。
 *
 * 与上游 RpcSession 遵循同一套正负 ID 约定：
 * - exports: 0=localMain; >=1 为对端 push/stream 分配的解析槽; <=-1 为本地导出的 RpcTarget/function。
 * - imports: 0=remoteMain; >=1 为己方 push 的调用结果; <=-1 为对端导出的 stub/callback。
 */
function createStructuredCapnwebSession(port: any, localMain: any = new RpcTarget()) {
  const exportsMap = new Map<number, any>();
  const reverseExports = new Map<any, number>();
  const importsMap = new Map<number, any>();
  const brokenCallbacks = new Set<() => void>();

  let nextPosExportId = 1;
  let nextNegExportId = -1;
  let nextPosImportId = 1;
  let abortReason: Error | null = null;

  exportsMap.set(0, { target: localMain, refcount: 1 });

  const remoteMainEntry = {
    importId: 0,
    isPromise: false,
    localRefcount: 1,
    remoteRefcount: 1,
    resolved: undefined as any,
    rejected: undefined as any,
    settled: false,
    pendingPull: null as null | { promise: Promise<any>; resolve: (v: any) => void; reject: (e: any) => void },
    brokenListeners: new Set<() => void>(),
  };
  importsMap.set(0, remoteMainEntry);

  function sendFrame(frame: any) {
    if (abortReason) return;
    try {
      port.postMessage(frame);
    } catch (error) {
      abortSession(error instanceof Error ? error : new Error(String(error)), false);
    }
  }

  function exportTarget(obj: any): number {
    const existingId = reverseExports.get(obj);
    if (existingId !== undefined && exportsMap.has(existingId)) {
      const entry = exportsMap.get(existingId);
      entry.refcount += 1;
      return existingId;
    }
    const id = nextNegExportId--;
    exportsMap.set(id, { target: obj, refcount: 1 });
    reverseExports.set(obj, id);
    return id;
  }

  function releaseExport(id: number, count: number) {
    const entry = exportsMap.get(id);
    if (!entry) return;
    entry.refcount -= count;
    if (entry.refcount <= 0) {
      exportsMap.delete(id);
      if (entry.target) {
        reverseExports.delete(entry.target);
        if (typeof entry.target[Symbol.dispose] === "function") {
          try {
            entry.target[Symbol.dispose]();
          } catch {}
        }
      }
    }
  }

  function devaluate(value: unknown, depth = 0): any {
    if (depth >= 256) throw new Error("Cap'n Web serialization exceeded maximum depth");
    if (value === undefined || value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      return value;
    }
    if (value instanceof Date) return value;
    if (value instanceof ArrayBuffer) {
      return ["bytes", new Uint8Array(value), "ArrayBuffer"];
    }
    if (ArrayBuffer.isView(value)) {
      const name = value.constructor?.name || "Uint8Array";
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return name === "Uint8Array" ? ["bytes", bytes] : ["bytes", bytes, name];
    }
    if (value instanceof Error) {
      return value.stack
        ? ["error", value.name || "Error", value.message || "", value.stack]
        : ["error", value.name || "Error", value.message || ""];
    }
    if (value && typeof value === "object" && (value as any)[IMPORT_ENTRY_SYMBOL]) {
      const entry = (value as any)[IMPORT_ENTRY_SYMBOL];
      return ["import", entry.importId];
    }
    if (typeof value === "function" || isRpcTarget(value)) {
      const id = exportTarget(value);
      return ["export", id];
    }
    if (Array.isArray(value)) {
      return [value.map((item) => devaluate(item, depth + 1))];
    }
    if (typeof value === "object") {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = devaluate(v, depth + 1);
      }
      return out;
    }
    return undefined;
  }

  function createImportStub(entry: any, isPromise: boolean): any {
    entry.localRefcount += 1;
    let disposed = false;

    const getPromise = () => {
      if (entry.settled) {
        return entry.rejected !== undefined
          ? Promise.reject(entry.rejected)
          : Promise.resolve(entry.resolved);
      }
      if (!entry.pendingPull) {
        let resolveFn!: (v: any) => void;
        let rejectFn!: (e: any) => void;
        const promise = new Promise((res, rej) => {
          resolveFn = res;
          rejectFn = rej;
        });
        entry.pendingPull = { promise, resolve: resolveFn, reject: rejectFn };
        sendFrame(["pull", entry.importId]);
      }
      return entry.pendingPull.promise;
    };

    const disposeStub = () => {
      if (disposed) return;
      disposed = true;
      entry.localRefcount -= 1;
      if (entry.localRefcount <= 0) {
        importsMap.delete(entry.importId);
        if (entry.importId !== 0 && entry.remoteRefcount > 0) {
          sendFrame(["release", entry.importId, entry.remoteRefcount]);
          entry.remoteRefcount = 0;
        }
      }
    };

    const fnTarget: any = function (...args: any[]) {
      return sendCall(entry.importId, [], args);
    };

    return new Proxy(fnTarget, {
      get(_target, prop) {
        if (prop === IMPORT_ENTRY_SYMBOL) return entry;
        if (prop === Symbol.dispose) return disposeStub;
        if (prop === "dup") return () => createImportStub(entry, false);
        if (prop === "onRpcBroken") {
          return (cb: () => void) => {
            if (abortReason) {
              try {
                cb();
              } catch {}
              return;
            }
            entry.brokenListeners.add(cb);
          };
        }
        if (prop === "then" || prop === "catch" || prop === "finally") {
          if (!isPromise) return undefined;
          const p = getPromise();
          return (p as any)[prop].bind(p);
        }
        if (typeof prop === "symbol") return undefined;
        return (...args: any[]) => sendCall(entry.importId, [String(prop)], args);
      },
      apply(_target, _thisArg, argArray) {
        return sendCall(entry.importId, [], argArray);
      },
    });
  }

  function sendCall(targetImportId: number, pathSegments: (string | number)[], args: any[]) {
    if (abortReason) return Promise.reject(abortReason);
    const id = nextPosImportId++;
    const entry = {
      importId: id,
      isPromise: true,
      localRefcount: 0,
      remoteRefcount: 1,
      resolved: undefined as any,
      rejected: undefined as any,
      settled: false,
      pendingPull: null as any,
      brokenListeners: new Set<() => void>(),
    };
    importsMap.set(id, entry);
    const wireArgs = devaluate(args); // wraps array in [[...]]
    const callExpr = ["pipeline", targetImportId, pathSegments, wireArgs[0]];
    sendFrame(["push", callExpr]);
    return createImportStub(entry, true);
  }

  async function resolveExportTarget(id: number): Promise<any> {
    const entry = exportsMap.get(id);
    if (!entry) throw new Error(`no such entry on exports table: ${id}`);
    if (entry.promise) return entry.promise;
    return entry.target;
  }

  async function evaluate(expr: unknown, depth = 0): Promise<any> {
    if (depth >= 256) throw new Error("Cap'n Web deserialization exceeded maximum depth");
    if (expr === null || typeof expr !== "object") return expr;
    if (expr instanceof Date) return expr;

    if (Array.isArray(expr)) {
      if (expr.length === 1 && Array.isArray(expr[0])) {
        const out = [];
        for (const item of expr[0]) {
          out.push(await evaluate(item, depth + 1));
        }
        return out;
      }

      switch (expr[0]) {
        case "undefined":
          return undefined;
        case "nan":
          return Number.NaN;
        case "inf":
          return Infinity;
        case "-inf":
          return -Infinity;
        case "bigint":
          return BigInt(expr[1]);
        case "date":
          return expr[1] === null ? new Date(Number.NaN) : new Date(expr[1]);
        case "bytes": {
          const raw = expr[1] instanceof Uint8Array
            ? expr[1]
            : Buffer.from(String(expr[1] || ""), "base64");
          if (expr.length === 2) return raw;
          const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
          if (expr[2] === "ArrayBuffer") return ab;
          const Ctor = TYPED_ARRAY_CONSTRUCTORS[expr[2]];
          return Ctor ? new Ctor(ab) : raw;
        }
        case "error": {
          const err = new Error(String(expr[2] || ""));
          err.name = String(expr[1] || "Error");
          if (typeof expr[3] === "string") err.stack = expr[3];
          return err;
        }
        case "import": {
          return resolveExportTarget(expr[1]);
        }
        case "pipeline": {
          const targetId = expr[1];
          const pathSegments = Array.isArray(expr[2]) ? expr[2] : [];
          let target = await resolveExportTarget(targetId);
          let parent: any = undefined;
          for (const segment of pathSegments) {
            parent = target;
            if (target == null) {
              throw new TypeError(`Cannot read RPC property "${String(segment)}" of null/undefined`);
            }
            target = target[segment];
          }
          if (expr.length >= 4 && Array.isArray(expr[3])) {
            const evaluatedArgs = await evaluate([expr[3]], depth + 1);
            if (typeof target !== "function") {
              throw new TypeError(`RPC target property ${pathSegments.join(".") || "<root>"} is not a function`);
            }
            return target.apply(parent, evaluatedArgs);
          }
          return target;
        }
        case "export":
        case "promise": {
          const remoteId = expr[1];
          let existing = importsMap.get(remoteId);
          if (!existing) {
            existing = {
              importId: remoteId,
              isPromise: expr[0] === "promise",
              localRefcount: 0,
              remoteRefcount: 1,
              resolved: undefined,
              rejected: undefined,
              settled: false,
              pendingPull: null,
              brokenListeners: new Set<() => void>(),
            };
            importsMap.set(remoteId, existing);
          } else {
            existing.remoteRefcount += 1;
          }
          return createImportStub(existing, expr[0] === "promise");
        }
        default:
          return expr;
      }
    }

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(expr as Record<string, unknown>)) {
      out[k] = await evaluate(v, depth + 1);
    }
    return out;
  }

  function ensureResolvingExport(exportId: number) {
    const entry = exportsMap.get(exportId);
    if (!entry || entry.resolving) return;
    entry.resolving = true;
    Promise.resolve(entry.promise).then(
      (value) => {
        if (abortReason) return;
        const encoded = devaluate(value);
        sendFrame(["resolve", exportId, encoded]);
        if (entry.autoRelease) releaseExport(exportId, 1);
      },
      (error) => {
        if (abortReason) return;
        const errObj = error instanceof Error ? error : new Error(String(error));
        sendFrame(["reject", exportId, devaluate(errObj)]);
        if (entry.autoRelease) releaseExport(exportId, 1);
      }
    );
  }

  function abortSession(error: Error, sendAbortFrame = true) {
    if (abortReason) return;
    abortReason = error;
    if (sendAbortFrame) {
      try {
        port.postMessage(["abort", devaluate(error)]);
      } catch {}
    }
    for (const entry of importsMap.values()) {
      if (!entry.settled) {
        entry.settled = true;
        entry.rejected = error;
        entry.pendingPull?.reject(error);
        entry.pendingPull = null;
      }
      for (const cb of entry.brokenListeners) {
        try {
          cb();
        } catch {}
      }
      entry.brokenListeners.clear();
    }
    for (const cb of brokenCallbacks) {
      try {
        cb();
      } catch {}
    }
    brokenCallbacks.clear();
    for (const [id, entry] of exportsMap.entries()) {
      if (id !== 0 && entry.target && typeof entry.target[Symbol.dispose] === "function") {
        try {
          entry.target[Symbol.dispose]();
        } catch {}
      }
    }
    try {
      port.close();
    } catch {}
  }

  port.start();
  port.on("message", (event: { data: any }) => {
    if (abortReason) return;
    const msg = event?.data;
    if (msg === null || msg === undefined) {
      abortSession(new Error("Peer closed MessagePort connection."), false);
      return;
    }
    if (!Array.isArray(msg)) return;

    switch (msg[0]) {
      case "push":
      case "stream": {
        const exportId = nextPosExportId++;
        const promise = evaluate(msg[1]);
        const entry: any = {
          promise,
          refcount: 1,
          autoRelease: msg[0] === "stream",
          resolving: false,
        };
        // Avoid unhandled rejection warnings before peer sends pull
        promise.catch(() => {});
        exportsMap.set(exportId, entry);
        if (entry.autoRelease) ensureResolvingExport(exportId);
        break;
      }
      case "pull": {
        ensureResolvingExport(msg[1]);
        break;
      }
      case "resolve":
      case "reject": {
        const importId = msg[1];
        const entry = importsMap.get(importId);
        if (!entry) break;
        if (msg[0] === "resolve") {
          evaluate(msg[2]).then(
            (val) => {
              entry.settled = true;
              entry.resolved = val;
              entry.pendingPull?.resolve(val);
              entry.pendingPull = null;
              if (entry.remoteRefcount > 0) {
                sendFrame(["release", importId, entry.remoteRefcount]);
                entry.remoteRefcount = 0;
              }
            },
            (err) => {
              entry.settled = true;
              entry.rejected = err;
              entry.pendingPull?.reject(err);
              entry.pendingPull = null;
            }
          );
        } else {
          evaluate(msg[2]).then(
            (err) => {
              entry.settled = true;
              entry.rejected = err instanceof Error ? err : new Error(String(err));
              entry.pendingPull?.reject(entry.rejected);
              entry.pendingPull = null;
            },
            (err) => {
              entry.settled = true;
              entry.rejected = err;
              entry.pendingPull?.reject(err);
              entry.pendingPull = null;
            }
          );
        }
        break;
      }
      case "release": {
        releaseExport(msg[1], msg[2]);
        break;
      }
      case "abort": {
        abortSession(new Error("RPC peer aborted"), false);
        break;
      }
      default:
        break;
    }
  });

  port.on("close", () => {
    abortSession(new Error("MessagePort closed"), false);
  });

  const remoteMain = createImportStub(remoteMainEntry, false);

  return {
    remoteMain,
    onBroken(cb: () => void) {
      if (abortReason) {
        cb();
        return;
      }
      brokenCallbacks.add(cb);
    },
    dispose() {
      abortSession(new Error("RPC session disposed"), true);
    },
  };
}

module.exports = {
  RpcTarget,
  createElectronPortPair,
  encodeCapnwebFrame,
  decodeCapnwebFrame,
  createStructuredCapnwebSession,
};
