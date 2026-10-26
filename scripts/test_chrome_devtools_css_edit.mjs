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
  const styles = await send("CSS.getMatchedStylesForNode", {
    nodeId: target.nodeId,
  });
  const rule = styles.matchedCSSRules.find(
    entry => entry.rule.selectorList.text === "#target"
  );
  assert(rule, "missing #target rule");
  assert(rule.rule.styleSheetId, "rule should expose a styleSheetId");

  await send("CSS.setPropertyText", {
    styleSheetId: rule.rule.styleSheetId,
    text: "color: rgb(0, 128, 0)",
  });
  const edited = await send("CSS.getComputedStyleForNode", {
    nodeId: target.nodeId,
  });
  const color = edited.computedStyle.find(entry => entry.name === "color");
  assert(
    color?.value === "rgb(0, 128, 0)",
    `expected edited color, got ${color?.value}`
  );

  await send("CSS.setPropertyText", {
    styleSheetId: rule.rule.styleSheetId,
    text: "color: rgb(255, 0, 0)",
  });
  console.log(
    JSON.stringify(
      {
        styleSheetId: rule.rule.styleSheetId,
        selector: rule.rule.selectorList.text,
        editedColor: color.value,
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
