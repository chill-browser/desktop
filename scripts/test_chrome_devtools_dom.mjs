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

function findNode(node, predicate) {
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children || []) {
    const found = findNode(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
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
  await send("Page.navigate", { url: "http://127.0.0.1:8081/dom.html" });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await send("DOM.enable");
  await send("CSS.enable");
  await send("Overlay.enable");

  const { root } = await send("DOM.getDocument", { depth: -1 });
  assert(root?.nodeId, "DOM.getDocument should return a root node");

  const target = findNode(
    root,
    node =>
      node.nodeType === 1 &&
      node.attributes?.includes("id") &&
      node.attributes[node.attributes.indexOf("id") + 1] === "target"
  );
  assert(target, "target element should exist in the DOM tree");
  assert(target.nodeName === "DIV", "target nodeName should be DIV");
  assert(target.localName === "div", "target localName should be div");

  const queried = await send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#target",
  });
  assert(queried.nodeId, "DOM.querySelector should return a nodeId");

  const attributes = await send("DOM.getAttributes", {
    nodeId: queried.nodeId,
  });
  assert(
    attributes.attributes.includes("data-test"),
    "target should have data-test attribute"
  );

  const computed = await send("CSS.getComputedStyleForNode", {
    nodeId: queried.nodeId,
  });
  const color = computed.computedStyle?.find(item => item.name === "color");
  assert(color, "computed style should include color");
  assert(
    String(color.value).includes("255"),
    `expected red color, got ${color.value}`
  );

  const matched = await send("CSS.getMatchedStylesForNode", {
    nodeId: queried.nodeId,
  });
  assert(
    matched.matchedCSSRules?.length > 0,
    "matched styles should include at least one rule"
  );
  assert(
    JSON.stringify(matched.matchedCSSRules).includes("#target"),
    "matched styles should include the #target selector"
  );

  const boxModel = await send("DOM.getBoxModel", {
    nodeId: queried.nodeId,
  });
  assert(boxModel.model?.width > 0, "box model width should be positive");
  assert(boxModel.model?.height > 0, "box model height should be positive");

  await send("Overlay.highlightNode", { nodeId: queried.nodeId });
  await send("Overlay.hideHighlight");

  console.log(
    JSON.stringify(
      {
        rootNodeId: root.nodeId,
        targetNodeId: target.nodeId,
        nodeName: target.nodeName,
        localName: target.localName,
        attributes: attributes.attributes,
        color: color.value,
        matchedRules: matched.matchedCSSRules.length,
        boxModel: {
          width: boxModel.model.width,
          height: boxModel.model.height,
        },
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
