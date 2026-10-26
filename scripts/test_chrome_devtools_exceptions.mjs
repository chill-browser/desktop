/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
const pending = new Map();
const events = [];
let nextId = 1;

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

socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id) {
    events.push(message);
    return;
  }
  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  clearTimeout(request.timeout);
  pending.delete(message.id);
  message.error
    ? request.reject(new Error(message.error.message))
    : request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await send("Page.navigate", {
    url: "http://127.0.0.1:8081/exception.html",
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  await send("Debugger.enable");
  await send("Debugger.setPauseOnExceptions", { state: "all" });

  const deadline = Date.now() + 5000;
  let paused = null;
  while (Date.now() < deadline) {
    paused = events.find(
      event =>
        event.method === "Debugger.paused" &&
        event.params?.reason === "exception"
    );
    if (paused) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!paused) {
    throw new Error("no exception pause received");
  }
  await send("Debugger.resume");
  await send("Debugger.setPauseOnExceptions", { state: "none" });
  console.log(
    JSON.stringify(
      {
        reason: paused.params.reason,
        exceptionText: paused.params.data?.description,
        callFrames: paused.params.callFrames.length,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
