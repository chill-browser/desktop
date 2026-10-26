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
    url: "http://127.0.0.1:8081/sourcemap.html",
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await send("Debugger.enable");
  await new Promise(resolve => setTimeout(resolve, 1000));

  const script = events
    .filter(event => event.method === "Debugger.scriptParsed")
    .map(event => event.params)
    .find(params => params.url?.endsWith("/sourcemap.js"));
  assert(script, "sourcemap.js was not parsed");
  assert(
    script.sourceMapURL === "sourcemap.js.map",
    `unexpected sourceMapURL ${script.sourceMapURL}`
  );

  const source = await send("Debugger.getScriptSource", {
    scriptId: script.scriptId,
  });
  assert(
    source.scriptSource.includes("sourceMappingURL=sourcemap.js.map"),
    "script source should reference its source map"
  );

  const mapResponse = await fetch("http://127.0.0.1:8081/sourcemap.js.map");
  const sourceMap = await mapResponse.json();
  assert(
    sourceMap.sources.includes("sourcemap.src.js"),
    "source map should reference sourcemap.src.js"
  );
  assert(
    sourceMap.sourcesContent?.[0]?.includes("function chillAdd"),
    "source map should embed original source"
  );

  console.log(
    JSON.stringify(
      {
        scriptUrl: script.url,
        sourceMapURL: script.sourceMapURL,
        sources: sourceMap.sources,
        hasSourcesContent: !!sourceMap.sourcesContent,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
