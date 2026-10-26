/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const endpoint = `ws://127.0.0.1:${port}/`;
const socket = new WebSocket(endpoint);

const pending = new Map();
const events = [];
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
    }, 5000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function waitForEvent(method) {
  const existing = events.find(event => event.method === method);
  if (existing) {
    events.splice(events.indexOf(existing), 1);
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(item => item.method === method);
      if (event) {
        clearInterval(timer);
        events.splice(events.indexOf(event), 1);
        resolve(event);
      } else if (Date.now() - started > 5000) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for event ${method}`));
      }
    }, 50);
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
  await send("Runtime.enable");

  const sum = await send("Runtime.evaluate", {
    expression: "1 + 1",
    returnByValue: true,
  });
  assert(sum.result?.value === 2, "1 + 1 should return 2");

  const objectResult = await send("Runtime.evaluate", {
    expression: "({ a: 1, b: 'x' })",
  });
  assert(objectResult.result?.objectId, "object evaluation should return objectId");

  const properties = await send("Runtime.getProperties", {
    objectId: objectResult.result.objectId,
    ownProperties: true,
  });
  const propertyA = properties.result?.find(property => property.name === "a");
  assert(propertyA?.value?.value === 1, "object property a should be 1");

  const exception = await send("Runtime.evaluate", {
    expression: "throw new Error('boom')",
  });
  assert(exception.exceptionDetails, "throw should return exceptionDetails");

  const consoleEventPromise = waitForEvent("Runtime.consoleAPICalled");
  await send("Runtime.evaluate", {
    expression: "console.log('G1 real', 1 + 1)",
  });
  const consoleEvent = await consoleEventPromise;
  assert(
    consoleEvent.params?.args?.[1]?.value === 2,
    "console event should contain 2"
  );

  console.log(
    JSON.stringify(
      {
        sum: sum.result,
        objectProperties: properties.result.map(property => property.name),
        exceptionText: exception.exceptionDetails.text,
        consoleEvent: consoleEvent.params,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
