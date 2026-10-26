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
  await send("Page.navigate", { url: "http://127.0.0.1:8081/storage.html" });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await send("DOMStorage.enable");

  const { storageKey } = await send("Storage.getStorageKey");
  assert(storageKey === "http://127.0.0.1:8081", `unexpected key ${storageKey}`);

  const storageId = {
    storageKey,
    isLocalStorage: true,
  };
  const initial = await send("DOMStorage.getDOMStorageItems", { storageId });
  assert(
    initial.entries.some(
      ([name, value]) => name === "chill-key" && value === "chill-value"
    ),
    `missing initial storage entry: ${JSON.stringify(initial.entries)}`
  );

  await send("DOMStorage.setDOMStorageItem", {
    storageId,
    key: "extra",
    value: "42",
  });
  const added = await send("DOMStorage.getDOMStorageItems", { storageId });
  assert(
    added.entries.some(([name, value]) => name === "extra" && value === "42"),
    `missing added storage entry: ${JSON.stringify(added.entries)}`
  );

  await send("DOMStorage.removeDOMStorageItem", {
    storageId,
    key: "extra",
  });
  const removed = await send("DOMStorage.getDOMStorageItems", { storageId });
  assert(
    !removed.entries.some(([name]) => name === "extra"),
    `storage entry was not removed: ${JSON.stringify(removed.entries)}`
  );

  await send("DOMStorage.disable");

  console.log(
    JSON.stringify(
      {
        storageKey,
        initialEntries: initial.entries,
        added: added.entries,
        removed: removed.entries,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
