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

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return response.result?.value;
}

try {
  await send("Emulation.setUserAgentOverride", {
    userAgent: "ChillUA/1.0",
  });
  await send("Page.navigate", { url: "http://127.0.0.1:8081/dom.html" });
  const userAgent = await evaluate("navigator.userAgent");
  assert(userAgent === "ChillUA/1.0", `unexpected UA ${userAgent}`);

  await send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  const dark = await evaluate(
    "matchMedia('(prefers-color-scheme: dark)').matches"
  );
  assert(dark === true, "prefers-color-scheme dark should be active");

  await send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const touch = await evaluate("navigator.maxTouchPoints");
  assert(touch > 0, "touch emulation should be active");

  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setEmulatedMedia", {
    media: "",
    features: [],
  });
  await send("Emulation.setUserAgentOverride", { userAgent: "" });

  console.log(
    JSON.stringify(
      {
        userAgent,
        dark,
        touch,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
