/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const socket = new WebSocket(`ws://127.0.0.1:${port}/`);

const pending = new Map();
const events = [];
const eventWaiters = [];
let nextId = 1;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
  const existing = events.find(
    event => event.method === method && predicate(event.params || {})
  );
  if (existing) {
    return Promise.resolve(existing.params || {});
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      method,
      predicate,
      resolve,
      reject,
      timeout: setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) {
          eventWaiters.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for event ${method}`));
      }, timeoutMs),
    };
    eventWaiters.push(waiter);
  });
}

socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result);
    }
    return;
  }
  events.push(message);
  for (const waiter of [...eventWaiters]) {
    if (
      waiter.method === message.method &&
      waiter.predicate(message.params || {})
    ) {
      clearTimeout(waiter.timeout);
      eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
      waiter.resolve(message.params || {});
    }
  }
});

socket.addEventListener("error", event => {
  console.error("WebSocket error", event);
  process.exitCode = 1;
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await send("Page.navigate", { url: "http://127.0.0.1:8081/debug.html" });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await send("Debugger.enable");

  const script = await waitForEvent(
    "Debugger.scriptParsed",
    params => params.url?.endsWith("/debug.js")
  );
  assert(script.scriptId, "debug.js should have a scriptId");

  const source = await send("Debugger.getScriptSource", {
    scriptId: script.scriptId,
  });
  assert(
    source.scriptSource.includes("function chillTest"),
    "script source should contain chillTest"
  );

  const possible = await send("Debugger.getPossibleBreakpoints", {
    start: {
      scriptId: script.scriptId,
      lineNumber: 1,
      columnNumber: 0,
    },
    end: {
      scriptId: script.scriptId,
      lineNumber: 2,
      columnNumber: 0,
    },
  });
  assert(
    possible.locations.some(location => location.lineNumber === 1),
    "line 2 should have a breakpoint location"
  );

  const breakpoint = await send("Debugger.setBreakpointByUrl", {
    url: script.url,
    lineNumber: 1,
    columnNumber: 0,
  });
  assert(breakpoint.breakpointId, "breakpoint should have an id");
  assert(
    breakpoint.locations.length > 0,
    "breakpoint should resolve to a location"
  );

  const evaluation = send("Runtime.evaluate", {
    expression: "chillTest(5)",
    returnByValue: true,
  });

  const paused = await waitForEvent("Debugger.paused");
  assert(paused.reason === "breakpoint", `unexpected reason ${paused.reason}`);
  assert(paused.callFrames.length > 0, "pause should include call frames");
  assert(
    paused.callFrames[0].functionName === "chillTest",
    `unexpected function ${paused.callFrames[0].functionName}`
  );

  assert(
    paused.callFrames[0].scopeChain?.length > 0,
    "pause should include a scope chain"
  );
  let xProperty = null;
  for (const scope of paused.callFrames[0].scopeChain) {
    const scopeProperties = await send("Runtime.getProperties", {
      objectId: scope.object.objectId,
    });
    xProperty = scopeProperties.result.find(
      property => property.name === "x"
    );
    if (xProperty) {
      break;
    }
  }
  assert(
    xProperty?.value?.value === 5,
    `expected scope x to be 5, got ${JSON.stringify(xProperty)}`
  );

  const frameValue = await send("Debugger.evaluateOnCallFrame", {
    callFrameId: paused.callFrames[0].callFrameId,
    expression: "x",
    returnByValue: true,
  });
  assert(
    frameValue.result.value === 5,
    `expected x to be 5, got ${frameValue.result.value}`
  );

  await send("Debugger.resume");
  await waitForEvent("Debugger.resumed");

  const result = await evaluation;
  assert(
    result.result.value === 11,
    `expected chillTest(5) to be 11, got ${result.result.value}`
  );

  await send("Debugger.removeBreakpoint", {
    breakpointId: breakpoint.breakpointId,
  });
  await send("Debugger.disable");

  console.log(
    JSON.stringify(
      {
        scriptUrl: script.url,
        scriptId: script.scriptId,
        breakpointLocation: breakpoint.locations[0],
        pausedFunction: paused.callFrames[0].functionName,
        scopeCount: paused.callFrames[0].scopeChain.length,
        scopeX: xProperty.value.value,
        frameValue: frameValue.result.value,
        evaluationResult: result.result.value,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
