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
  await send("Page.navigate", { url: "http://127.0.0.1:8081/dom.html" });
  await new Promise(resolve => setTimeout(resolve, 800));
  const document = await send("DOM.getDocument", { depth: -1 });
  const target = await send("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "#target",
  });

  await send("DOM.setAttributeValue", {
    nodeId: target.nodeId,
    name: "data-test",
    value: "edited",
  });
  let attributes = await send("DOM.getAttributes", {
    nodeId: target.nodeId,
  });
  assert(
    attributes.attributes.includes("data-test") &&
      attributes.attributes.includes("edited"),
    "attribute should be edited"
  );

  await send("DOM.removeAttribute", {
    nodeId: target.nodeId,
    name: "data-test",
  });
  attributes = await send("DOM.getAttributes", { nodeId: target.nodeId });
  assert(
    !attributes.attributes.includes("data-test"),
    "attribute should be removed"
  );



  console.log(
    JSON.stringify(
      {
        nodeId: target.nodeId,
        attributeEdited: true,
        attributeRemoved: true,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
