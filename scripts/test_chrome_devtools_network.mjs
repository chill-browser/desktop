/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const url = process.argv[3] ?? "http://127.0.0.1:8081/";
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

function waitFor(predicate, message) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for ${message}`));
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
  await send("Network.enable");
  await send("Runtime.evaluate", {
    expression:
      'fetch("/data.json?after=1").then(r => r.text()).then(t => console.log("net-g2", t))',
  });

  await waitFor(
    () =>
      events.some(
        event =>
          event.method === "Network.requestWillBeSent" &&
          event.params.request.url.includes("/data.json?after=1")
      ),
    "data.json request"
  );
  await waitFor(
    () =>
      events.some(
        event =>
          event.method === "Network.responseReceived" &&
          event.params.response.url.includes("/data.json?after=1")
      ),
    "data.json response"
  );
  await waitFor(
    () =>
      events.some(
        event =>
          event.method === "Network.loadingFinished" &&
          event.params.requestId ===
            events.find(
              item =>
                item.method === "Network.responseReceived" &&
                item.params.response.url.includes("/data.json?after=1")
            )?.params.requestId
      ),
    "data.json loadingFinished"
  );

  const requests = events
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => ({
      id: event.params.requestId,
      method: event.params.request.method,
      url: event.params.request.url,
      type: event.params.type,
    }));
  const responses = events
    .filter(event => event.method === "Network.responseReceived")
    .map(event => ({
      id: event.params.requestId,
      url: event.params.response.url,
      status: event.params.response.status,
      mimeType: event.params.response.mimeType,
    }));
  const finished = events.filter(
    event => event.method === "Network.loadingFinished"
  ).length;

  assert(requests.length >= 1, "expected at least one request");
  assert(responses.some(response => response.status === 200), "expected 200");
  assert(finished >= 1, "expected at least one finished request");

  const dataRequestId = events.find(
    event =>
      event.method === "Network.responseReceived" &&
      event.params.response.url.includes("/data.json?after=1")
  )?.params.requestId;
  const body = await send("Network.getResponseBody", {
    requestId: dataRequestId,
  });
  assert(
    body.body.includes('"ok":true'),
    `expected response body to contain ok, got ${body.body}`
  );

  console.log(
    JSON.stringify({ requests, responses, finished, body: body.body }, null, 2)
  );
} finally {
  socket.close();
}
