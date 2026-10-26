/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
const pending = new Map();
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

function valueOf(response) {
  return response?.result?.value;
}

socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id) {
    return;
  }
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
  await send("Page.navigate", { url: "http://127.0.0.1:8081/dom.html" });
  await new Promise(resolve => setTimeout(resolve, 1000));

  await send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 667,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  const emulated = await send("Runtime.evaluate", {
    expression: "JSON.stringify({w: innerWidth, h: innerHeight})",
    returnByValue: true,
  });
  const size = JSON.parse(valueOf(emulated));
  assert(size.w === 375, `expected innerWidth 375, got ${size.w}`);
  assert(size.h === 667, `expected innerHeight 667, got ${size.h}`);

  await send("Emulation.clearDeviceMetricsOverride");
  await new Promise(resolve => setTimeout(resolve, 500));
  const restored = await send("Runtime.evaluate", {
    expression: "JSON.stringify({w: innerWidth, h: innerHeight})",
    returnByValue: true,
  });
  const restoredSize = JSON.parse(valueOf(restored));
  assert(restoredSize.w > 375, `expected restored width, got ${restoredSize.w}`);

  console.log(
    JSON.stringify({ emulated: size, restored: restoredSize }, null, 2)
  );
} finally {
  socket.close();
}
