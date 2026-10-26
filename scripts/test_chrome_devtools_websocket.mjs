/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[2] ?? 9230);
const server = http.createServer();
let serverSocket = null;

server.on("upgrade", (request, socket) => {
  serverSocket = socket;
  const accept = crypto
    .createHash("sha1")
    .update(
      request.headers["sec-websocket-key"] +
        "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    )
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const frame = text => {
    const data = Buffer.from(text);
    socket.write(Buffer.concat([Buffer.from([0x81, data.length]), data]));
  };
  frame("hello-from-server");
  socket.on("data", buffer => {
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const length = buffer[offset + 1] & 0x7f;
      if (offset + 6 + length > buffer.length) {
        break;
      }
      const mask = buffer.subarray(offset + 2, offset + 6);
      const data = Buffer.from(
        buffer.subarray(offset + 6, offset + 6 + length)
      );
      for (let index = 0; index < data.length; index++) {
        data[index] ^= mask[index % 4];
      }
      frame(`echo:${data.toString()}`);
      offset += 6 + length;
    }
  });
});

await new Promise(resolve => server.listen(8082, "127.0.0.1", resolve));

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
  await send("Network.enable");
  await send("Page.navigate", {
    url: "http://127.0.0.1:8081/ws.html",
  });
  await new Promise(resolve => setTimeout(resolve, 2000));

  const created = events.find(
    event => event.method === "Network.webSocketCreated"
  );
  assert(created, "missing webSocketCreated");
  const received = events.find(
    event =>
      event.method === "Network.webSocketFrameReceived" &&
      event.params?.response?.payloadData === "hello-from-server"
  );
  assert(received, "missing server frame");
  const sent = events.find(
    event =>
      event.method === "Network.webSocketFrameSent" &&
      event.params?.response?.payloadData === "hello-from-page"
  );
  assert(sent, "missing page frame");

  console.log(
    JSON.stringify(
      {
        url: created.params.url,
        sent: sent.params.response.payloadData,
        received: received.params.response.payloadData,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
  serverSocket?.destroy();
  server.close();
}
