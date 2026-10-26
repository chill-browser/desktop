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
  await send("Page.navigate", { url: "http://127.0.0.1:8081/a11y.html" });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await send("Accessibility.enable");
  const { nodes } = await send("Accessibility.getFullAXTree");
  assert(nodes.length > 0, "accessibility tree should not be empty");

  const button = nodes.find(
    node => node.role?.value === "button" && node.name?.value === "Chill button"
  );
  assert(button, `button node not found in ${nodes.length} nodes`);

  const heading = nodes.find(
    node => node.role?.value === "heading" && node.name?.value === "Accessibility"
  );
  assert(heading, "heading node not found");

  const security = await send("Security.getSecurityState");
  assert(
    security.securityState === "insecure",
    `expected insecure for http, got ${security.securityState}`
  );

  console.log(
    JSON.stringify(
      {
        nodeCount: nodes.length,
        button: { role: button.role.value, name: button.name.value },
        heading: { role: heading.role.value, name: heading.name.value },
        securityState: security.securityState,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
