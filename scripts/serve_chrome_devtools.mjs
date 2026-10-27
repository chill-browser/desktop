/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const revision = "7da823b1d594d1b49797911900e003ec96a8c0e7";
const root = resolve(
  process.argv[2] ??
    `.cache/chrome-devtools-frontend/${revision}`
);
const port = Number(process.argv[3] ?? 8080);
const host = "127.0.0.1";

const chillShim = `
(() => {
  const setFrontendTheme = () => {
    const value = JSON.stringify("dark");
    for (const key of ["ui-theme", "__custom__ui-theme", "__bundled__ui-theme"]) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    }
  };
  setFrontendTheme();

  const DEVICE_MODE_SETTING = "emulation.show-device-mode";

  const installFrontendThemeBackground = () => {
    if (document.getElementById("chill-devtools-theme-background")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "chill-devtools-theme-background";
    style.textContent =
      "html, body { background-color: #1e1e1e !important; }";
    document.documentElement.appendChild(style);
  };


  const installFrontendChrome = () => {
    installFrontendThemeBackground();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installFrontendChrome, {
      once: true,
    });
  } else {
    installFrontendChrome();
  }

  try {
    localStorage.removeItem(DEVICE_MODE_SETTING);
  } catch {}

  const wsParam = new URL(location.href).searchParams.get("ws");
  let active = false;
  let nextId = 1;
  let socket = null;
  let connecting = null;
  const pending = new Map();

  const findMainMenuButton = () => {
    const walk = root => {
      for (const element of root.querySelectorAll(".main-menu")) {
        return element;
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          const found = walk(element.shadowRoot);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };
    return walk(document);
  };

  const installResizeGrip = () => {
    if (document.querySelector(".chill-resize-grip")) {
      return;
    }
    const grip = document.createElement("div");
    grip.className = "chill-resize-grip";
    grip.title = "Drag to resize DevTools";
    grip.style.cssText =
      "position:fixed;left:0;top:0;bottom:0;width:10px;cursor:ew-resize;z-index:2147483647;background:transparent;";
    grip.addEventListener("mouseenter", () => {
      grip.style.background = "rgba(120,170,255,0.35)";
    });
    grip.addEventListener("mouseleave", () => {
      grip.style.background = "transparent";
    });
    grip.addEventListener("mousedown", event => {
      event.preventDefault();
      event.stopPropagation();
      const startScreenX = event.screenX;
      const startWidth = window.innerWidth;
      grip.style.background = "rgba(120,170,255,0.7)";
      const onMove = moveEvent => {
        const width = startWidth + (startScreenX - moveEvent.screenX);
        send("Chill.setFrontendWidth", { width }).catch(() => {});
      };
      const onUp = () => {
        grip.style.background = "transparent";
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
    document.documentElement.appendChild(grip);
  };

  const installToolbarClose = () => {
    const menu = findMainMenuButton();
    if (!menu || !menu.parentElement) {
      return;
    }
    const parent = menu.parentElement;
    const existing = parent.querySelector(":scope > .chill-toolbar-close");
    if (existing) {
      if (menu.nextElementSibling !== existing) {
        menu.after(existing);
      }
      return;
    }
    const button = document.createElement("button");
    button.className = "chill-toolbar-close";
    button.type = "button";
    button.title = "Close DevTools";
    button.setAttribute("aria-label", "Close DevTools");
    button.textContent = "✕";
    button.style.cssText =
      "display:flex;align-items:center;justify-content:center;width:24px;height:24px;min-width:24px;background:transparent;border:none;color:var(--icon-default,#c0c0c0);cursor:pointer;font-size:16px;line-height:24px;padding:0;";
    button.addEventListener("mouseenter", () => {
      button.style.background =
        "var(--sys-color-state-hover-on-subtle, rgba(255,255,255,0.12))";
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "transparent";
    });
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      send("Chill.closeDevTools").catch(() => {});
    });
    menu.after(button);
  };

  const isDeviceButton = element => {
    if (!element || element.nodeType !== 1) {
      return false;
    }
    if (element.jslogContext === "emulation.toggle-device-mode") {
      return true;
    }
    const jslog = (element.getAttribute && element.getAttribute("jslog")) || "";
    if (jslog.includes("emulation.toggle-device-mode")) {
      return true;
    }
    const title = (element.getAttribute && element.getAttribute("title")) || "";
    return (
      /Toggle device toolbar/i.test(title) ||
      /(Ctrl|Cmd|Meta|Shift|⌘|⇧)[+\\s]*(Shift|Ctrl|Cmd|Meta|⇧|⌘)[+\\s]*M/i.test(
        title
      )
    );
  };

  const findButtons = () => {
    const buttons = [];
    const walk = root => {
      for (const element of root.querySelectorAll("devtools-button, button")) {
        if (isDeviceButton(element)) {
          buttons.push(element);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          walk(element.shadowRoot);
        }
      }
    };
    walk(document);
    return buttons;
  };

  let cachedButtons = [];

  const paint = () => {
    cachedButtons = cachedButtons.filter(button => button.isConnected);
    if (!cachedButtons.length) {
      cachedButtons = findButtons();
    }
    for (const button of cachedButtons) {
      if ("toggled" in button) {
        button.toggled = active;
      } else {
        button.setAttribute("aria-pressed", String(active));
      }
    }
  };

  const handleMessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method === "Chill.deviceModeChanged") {
      active = !!(message.params && message.params.active);
      paint();
    }
  };

  const ensureSocket = () => {
    if (!wsParam) {
      return Promise.reject(new Error("Missing ws parameter"));
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      return Promise.resolve(socket);
    }
    if (connecting) {
      return connecting;
    }
    connecting = new Promise((resolve, reject) => {
      const next = new WebSocket("ws://" + wsParam);
      socket = next;
      next.addEventListener("message", handleMessage);
      next.addEventListener("open", () => resolve(next), { once: true });
      next.addEventListener("error", () => reject(new Error("ws error")), {
        once: true,
      });
      next.addEventListener("close", () => {
        socket = null;
        connecting = null;
        for (const entry of pending.values()) {
          entry.reject(new Error("ws closed"));
        }
        pending.clear();
      });
    });
    return connecting;
  };

  const send = (method, params = {}) => {
    return ensureSocket().then(
      next =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          next.send(JSON.stringify({ id, method, params }));
        })
    );
  };

  const toggle = () => {
    send("Chill.toggleDeviceToolbar")
      .then(result => {
        if (result && typeof result.active === "boolean") {
          active = result.active;
          paint();
        }
      })
      .catch(() => {});
  };

  document.addEventListener(
    "click",
    event => {
      const path = event.composedPath ? event.composedPath() : [];
      const closeButton = path.find(
        element =>
          element &&
          element.nodeType === 1 &&
          element.classList &&
          element.classList.contains("close-devtools")
      );
      if (closeButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        send("Chill.closeDevTools").catch(() => {});
        return;
      }
      if (!path.some(isDeviceButton)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      toggle();
    },
    true
  );

  const boot = () => {
    send("Chill.getDeviceModeState")
      .then(result => {
        active = !!(result && result.active);
        paint();
      })
      .catch(() => {});
    paint();
    setInterval(paint, 1000);
    setInterval(installToolbarClose, 500);
    installToolbarClose();
    setInterval(installResizeGrip, 500);
    installResizeGrip();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
`;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
]);

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const pathname =
    url.pathname === "/" ? "/inspector.html" : decodeURIComponent(url.pathname);

  if (pathname === "/chill-devtools-shim.js") {
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(chillShim);
    return;
  }

  const file = resolve(root, `.${pathname}`);

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    if (!statSync(file).isFile()) {
      throw new Error("Not a file");
    }
    response.writeHead(200, {
      "Content-Type":
        mimeTypes.get(extname(file).toLowerCase()) ??
        "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (extname(file).toLowerCase() === ".html") {
      let html = readFileSync(file, "utf8");
      if (pathname.endsWith("/inspector.html")) {
        html = html.replace(
          "./entrypoints/inspector/inspector.js",
          "./entrypoints/devtools_app/devtools_app.js"
        );
        html += '<script src="/chill-devtools-shim.js"></script>';
      }
      response.end(html);
      return;
    }
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, host, () => {
  console.log(`Chrome DevTools frontend: http://${host}:${port}/inspector.html`);
});
