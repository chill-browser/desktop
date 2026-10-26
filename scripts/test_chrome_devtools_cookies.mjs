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
  const url = "http://127.0.0.1:8081/cookies.html";
  await send("Page.navigate", { url });
  await new Promise(resolve => setTimeout(resolve, 1000));

  const initial = await send("Network.getCookies", { urls: [url] });
  assert(
    initial.cookies.some(
      cookie => cookie.name === "chill-cookie" && cookie.value === "chill-value"
    ),
    `missing initial cookie: ${JSON.stringify(initial.cookies)}`
  );

  const added = await send("Network.setCookie", {
    name: "extra-cookie",
    value: "42",
    url,
    path: "/",
  });
  assert(added.success, "Network.setCookie should succeed");

  const afterSet = await send("Network.getCookies", { urls: [url] });
  assert(
    afterSet.cookies.some(
      cookie => cookie.name === "extra-cookie" && cookie.value === "42"
    ),
    `missing added cookie: ${JSON.stringify(afterSet.cookies)}`
  );

  await send("Network.deleteCookies", {
    name: "extra-cookie",
    url,
    path: "/",
  });
  const afterDelete = await send("Network.getCookies", { urls: [url] });
  assert(
    !afterDelete.cookies.some(cookie => cookie.name === "extra-cookie"),
    `cookie was not deleted: ${JSON.stringify(afterDelete.cookies)}`
  );

  console.log(
    JSON.stringify(
      {
        initial: initial.cookies,
        afterSet: afterSet.cookies,
        afterDelete: afterDelete.cookies,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
