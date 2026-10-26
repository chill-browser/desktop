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
  await send("Page.navigate", { url: "http://127.0.0.1:8081/manifest.html" });
  await new Promise(resolve => setTimeout(resolve, 1200));

  const manifest = await send("Page.getAppManifest");
  assert(manifest.data, "manifest data should be present");
  const parsed = JSON.parse(manifest.data);
  assert(parsed.name === "Chill App", `unexpected manifest ${manifest.data}`);

  const screenshot = await send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 50,
  });
  assert(screenshot.data.length > 1000, "screenshot data is too small");

  const metrics = await send("Page.getLayoutMetrics");
  assert(
    metrics.layoutViewport.clientWidth > 0,
    "layout viewport should have a width"
  );

  await send("Page.reload", { ignoreCache: true });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const evaluated = await send("Runtime.evaluate", {
    expression: "JSON.stringify({url: location.href, title: document.title})",
    returnByValue: true,
  });
  const page = JSON.parse(evaluated.result.value);
  assert(page.url.endsWith("/manifest.html"), `unexpected URL ${page.url}`);

  console.log(
    JSON.stringify(
      {
        manifest: { name: parsed.name, start_url: parsed.start_url },
        screenshotBytes: screenshot.data.length,
        viewport: metrics.layoutViewport,
        page,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
