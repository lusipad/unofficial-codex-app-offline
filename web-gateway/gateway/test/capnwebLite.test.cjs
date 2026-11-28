const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RpcTarget,
  createElectronPortPair,
  encodeCapnwebFrame,
  decodeCapnwebFrame,
  createStructuredCapnwebSession,
} = require("../dist/official/capnwebLite.js");

test("encodeCapnwebFrame / decodeCapnwebFrame round-trips structuredClonable values losslessly", () => {
  const input = {
    undef: undefined,
    nil: null,
    bool: true,
    num: 42.5,
    nan: Number.NaN,
    inf: Infinity,
    negInf: -Infinity,
    big: BigInt("9007199254740993123456"),
    date: new Date("2026-11-28T06:00:00.000Z"),
    invalidDate: new Date(Number.NaN),
    bytes: new Uint8Array([1, 2, 3, 255]),
    int16: new Int16Array([-5, 1024]),
    nested: [undefined, "ok", { $cw: "user-data", count: 2 }],
  };

  const wire = JSON.parse(JSON.stringify(encodeCapnwebFrame(input)));
  const restored = decodeCapnwebFrame(wire);

  assert.equal(Object.prototype.hasOwnProperty.call(restored, "undef"), true);
  assert.equal(restored.undef, undefined);
  assert.equal(restored.nil, null);
  assert.equal(restored.bool, true);
  assert.equal(restored.num, 42.5);
  assert.ok(Number.isNaN(restored.nan));
  assert.equal(restored.inf, Infinity);
  assert.equal(restored.negInf, -Infinity);
  assert.equal(restored.big, BigInt("9007199254740993123456"));
  assert.ok(restored.date instanceof Date);
  assert.equal(restored.date.toISOString(), "2026-11-28T06:00:00.000Z");
  assert.ok(restored.invalidDate instanceof Date);
  assert.ok(Number.isNaN(restored.invalidDate.getTime()));
  assert.ok(restored.bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(restored.bytes), [1, 2, 3, 255]);
  assert.ok(restored.int16 instanceof Int16Array);
  assert.deepEqual(Array.from(restored.int16), [-5, 1024]);
  assert.equal(restored.nested[0], undefined);
  assert.equal(restored.nested[1], "ok");
  assert.deepEqual(restored.nested[2], { $cw: "user-data", count: 2 });
});

test("createStructuredCapnwebSession handles bidirectional RPC, targets, callbacks, pipelining, and errors", async () => {
  const { port1, port2 } = createElectronPortPair();
  let disposedLeases = 0;

  class LeaseTarget extends RpcTarget {
    ping(x) {
      return `pong:${x}`;
    }
    [Symbol.dispose]() {
      disposedLeases += 1;
    }
  }

  class ServerMain extends RpcTarget {
    add(a, b) {
      return a + b;
    }
    async subscribe(onEvent) {
      await onEvent({ type: "ready", count: 7 });
      return {
        status: "ok",
        lease: new LeaseTarget(),
      };
    }
    fail() {
      throw new Error("boom");
    }
  }

  class ClientMain extends RpcTarget {}

  const server = createStructuredCapnwebSession(port1, new ServerMain());
  const client = createStructuredCapnwebSession(port2, new ClientMain());

  try {
    assert.equal(await client.remoteMain.add(3, 4), 7);

    const events = [];
    const subPromise = client.remoteMain.subscribe((ev) => {
      events.push(ev);
    });
    const sub = await subPromise;
    assert.equal(sub.status, "ok");
    assert.deepEqual(events, [{ type: "ready", count: 7 }]);

    assert.equal(await sub.lease.ping("hi"), "pong:hi");
    sub.lease[Symbol.dispose]();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(disposedLeases, 1);

    await assert.rejects(async () => await client.remoteMain.fail(), /boom/);
  } finally {
    client.dispose();
    server.dispose();
  }
});
