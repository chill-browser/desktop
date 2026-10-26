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
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
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
  message.error
    ? request.reject(new Error(message.error.message))
    : request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await send("DOM.enable");
  const counts = [];
  for (let index = 0; index < 6; index++) {
    await send("Page.navigate", {
      url:
        index % 2
          ? "http://127.0.0.1:8081/dom.html"
          : "http://127.0.0.1:8081/manifest.html",
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    const document = await send("DOM.getDocument", { depth: -1 });
    const childCount = document.root.children?.length || 0;
    counts.push(childCount);
    assert(childCount > 0, `empty DOM tree after navigation ${index}`);
  }
  console.log(JSON.stringify({ childCounts: counts }, null, 2));
} finally {
  socket.close();
}
