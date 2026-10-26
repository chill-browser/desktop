/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
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
    url: "http://127.0.0.1:8081/sw.html",
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await send("ServiceWorker.enable");
  await new Promise(resolve => setTimeout(resolve, 500));

  const registrationEvent = events.find(
    event => event.method === "ServiceWorker.workerRegistrationUpdated"
  );
  assert(registrationEvent, "missing workerRegistrationUpdated");
  const registration = registrationEvent.params.registrations.find(item =>
    item.scopeURL.endsWith("/")
  );
  assert(registration, "missing service worker registration");

  const versionEvent = events.find(
    event => event.method === "ServiceWorker.workerVersionUpdated"
  );
  assert(versionEvent, "missing workerVersionUpdated");
  const version = versionEvent.params.versions.find(item =>
    item.scriptURL.endsWith("/sw.js")
  );
  assert(version, "missing service worker version");

  const eventCount = events.length;
  await send("Runtime.evaluate", {
    expression:
      "navigator.serviceWorker.getRegistration().then(registration => registration?.unregister())",
  });
  const deadline = Date.now() + 5000;
  let deleted = null;
  while (Date.now() < deadline) {
    deleted = events
      .slice(eventCount)
      .find(
        event =>
          event.method === "ServiceWorker.workerRegistrationUpdated" &&
          event.params?.registrations?.some(item => item.isDeleted)
      );
    if (deleted) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(deleted, "missing service worker deletion event");

  console.log(
    JSON.stringify(
      {
        registrationId: registration.registrationId,
        scopeURL: registration.scopeURL,
        scriptURL: version.scriptURL,
        status: version.status,
        deleted: true,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
