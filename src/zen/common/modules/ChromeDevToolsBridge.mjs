/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { require } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);
const {
  LocalTabCommandsFactory,
} = require("devtools/client/framework/local-tab-commands-factory");
const WebSocketServer = require("devtools/server/socket/websocket-server");
const ResourceCommand = require("devtools/shared/commands/resource/resource-command.js");

const ServerSocket = Components.Constructor(
  "@mozilla.org/network/server-socket;1",
  "nsIServerSocket",
  "init"
);

const FRONTEND_BASE_URL = "http://127.0.0.1:8080/inspector.html";
const TARGET_ID = "chill-target-1";
const SESSION_ID = "chill-session-1";
const FRAME_ID = "chill-frame-1";
const EXECUTION_CONTEXT_ID = 1;
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const DEVICE_PRESETS = [
  { id: "responsive", label: "Responsive", width: 0, height: 0, mobile: false },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, mobile: true },
  {
    id: "iphone-12",
    label: "iPhone 12 Pro",
    width: 390,
    height: 844,
    mobile: true,
  },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915, mobile: true },
  {
    id: "galaxy-s20",
    label: "Galaxy S20",
    width: 360,
    height: 800,
    mobile: true,
  },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024, mobile: true },
  {
    id: "ipad-pro-11",
    label: "iPad Pro 11",
    width: 834,
    height: 1194,
    mobile: true,
  },
  {
    id: "laptop-720p",
    label: "Laptop 720p",
    width: 1280,
    height: 720,
    mobile: false,
  },
  {
    id: "desktop-1080p",
    label: "Desktop 1080p",
    width: 1920,
    height: 1080,
    mobile: false,
  },
];

let started = false;

function log(...args) {
  console.info("ChromeDevToolsBridge:", ...args);
}

class Bridge {
  #window;
  #server;
  #sockets = new Set();
  #commands;
  #tab;
  #consoleFront;
  #consoleStarted = false;
  #consoleOnAPICall = null;
  #networkStarted = false;
  #networkResources = new Map();
  #networkOnAvailable;
  #networkOnUpdated;
  #websocketStarted = false;
  #websocketOnAvailable;
  #websocketCreatedRequests = new Set();
  #pendingWebSocketFrames = new Map();
  #storageStarted = false;
  #storageFronts = new Map();
  #storageOnAvailable;
  #indexedDBStarted = false;
  #indexedDBFront = null;
  #indexedDBOnAvailable;
  #cacheStarted = false;
  #cacheFront = null;
  #cacheOnAvailable;
  #cacheById = new Map();
  #storageBuckets = new Map();
  #serviceWorkerRootFront = null;
  #serviceWorkerOnListChanged = null;
  #serviceWorkerRegistrationFronts = new Set();
  #accessibilityFront;
  #accessibilityEnabled = false;
  #inspectorFront;
  #domWalker;
  #pageStyle;
  #domHighlighter;
  #nodeIdByActor = new Map();
  #nodeFrontById = new Map();
  #nextNodeId = 1;
  #domChildrenLoaded = new Set();
  #cssRuleBySheetId = new Map();
  #cssRuleNodeBySheetId = new Map();
  #sentStyleSheetHeaders = new Set();
  #nextStyleSheetId = 1;
  #domNodeBudget = 0;
  #threadFront;
  #debuggerEnabled = false;
  #sourceByActor = new Map();
  #sourceFrontByActor = new Map();
  #scriptParsedActors = new Set();
  #breakpointByCdpId = new Map();
  #nextBreakpointId = 1;
  #blackboxedUrls = new Set();
  #topFrameActorId = null;
  #debuggerListenersAttached = false;
  #scopeObjects = new Map();
  #targetUrl = "";
  #targetTitle = "";
  #port = 0;
  #token = "";
  #frontendFrame = null;
  #frontendSplitter = null;
  #frontendPanel = null;
  #frontendFrameObserver = null;
  #frontendCloseButton = null;
  #frontendWidth = 330;
  #frontendResizing = false;
  #deviceMode = null;
  #deviceToolbar = null;
  #deviceStyle = null;
  #deviceResizeObserver = null;
  #deviceTouch = false;
  #screencastTimer = null;
  #screencastSessionId = 0;
  #pendingInspectNode = null;
  #domReady = false;
  #pickerAttached = false;

  constructor(window) {
    this.#window = window;
  }

  async start({ open = false, panel = null } = {}) {
    const tab = this.#window.gBrowser.selectedTab;
    this.#tab = tab;
    this.#targetUrl = tab.linkedBrowser.currentURI.spec;
    this.#targetTitle = tab.label;

    this.#commands = await LocalTabCommandsFactory.createCommandsForTab(tab);
    await this.#commands.targetCommand.startListening();

    const configuredPort = Services.prefs.getIntPref(
      "chill.devtools.chrome.port",
      0
    );
    this.#server = new ServerSocket(configuredPort || -1, true, -1);
    this.#server.asyncListen({
      onSocketAccepted: (socket, transport) => {
        this.#accept(transport);
      },
      onStopListening: () => {},
    });

    this.#port = this.#server.port;
    const configuredToken = Services.prefs.getStringPref(
      "chill.devtools.chrome.token",
      ""
    );
    this.#token =
      configuredToken ||
      Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
    log(`WebSocket listening on ws://127.0.0.1:${this.#port}/`);
    log(`target ${this.#targetUrl}`);

    if (open) {
      await this.open({ panel });
    }
  }

  #frontendUrl(panel) {
    return `${FRONTEND_BASE_URL}?ws=127.0.0.1:${this.#port}/${encodeURIComponent(
      this.#token
    )}&panel=${encodeURIComponent(panel)}`;
  }

  async #openFrontend(panel) {
    const url = this.#frontendUrl(panel);
    if (this.#frontendFrame) {
      if (panel !== this.#frontendPanel) {
        log("navigating docked frontend");
        this.#frontendFrame.setAttribute("src", url);
        this.#frontendPanel = panel;
      }
      this.#tab.linkedBrowser.focus();
      return;
    }

    log("opening docked frontend");
    const { gDevToolsBrowser } = require(
      "devtools/client/framework/devtools-browser"
    );
    await gDevToolsBrowser.loadBrowserStyleSheet(this.#window);

    const doc = this.#window.document;
    const container = this.#window.gBrowser.getBrowserContainer(
      this.#tab.linkedBrowser
    );
    const splitter = doc.createXULElement("splitter");
    splitter.classList.add(
      "devtools-toolbox-splitter",
      "for-side-host",
      "docked-right"
    );
    splitter.setAttribute("resizebefore", "none");
    splitter.setAttribute("resizeafter", "none");
    splitter.setAttribute("orient", "horizontal");
    splitter.style.pointerEvents = "none";
    splitter.style.background = "transparent";

    container
      .closest(".browserSidebarContainer")
      ?.setAttribute("devtools-host-type", "right");
    doc.getElementById("tabbrowser-tabbox")?.style.setProperty(
      "--devtools-toolbox-width",
      "500px"
    );
    const frame = doc.createXULElement("browser");
    frame.setAttribute("type", "content");
    frame.setAttribute("remote", "true");
    frame.setAttribute("maybecanvas", "true");
    frame.setAttribute("manualactiveness", "true");
    frame.classList.add(
      "devtools-toolbox-iframe",
      "side-host",
      "docked-right"
    );
    this.#frontendWidth = 330;
    frame.style.width = "330px";
    frame.style.minWidth = "330px";
    frame.style.maxWidth = "330px";
    frame.style.flex = "0 0 330px";
    frame.style.border = "none";
    frame.style.backgroundColor = "#1e1e1e";

    this.#frontendFrame = frame;
    this.#frontendSplitter = splitter;
    this.#frontendPanel = panel;
    container.append(splitter, frame);
    this.#syncFrontendColumns();
    if (this.#window.getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    frame.docShellIsActive = true;
    frame.addEventListener("mouseenter", () => frame.focus(), true);
    frame.addEventListener("mousedown", () => frame.focus(), true);
    frame.addEventListener("load", () => frame.focus(), true);
    frame.setAttribute("src", url);


  }

  #frontendContainerColumns(container) {
    if (!container) {
      return;
    }
    container.style.removeProperty("grid-template-columns");
  }

  #syncFrontendColumns() {
    const frame = this.#frontendFrame;
    if (!frame) {
      return;
    }
    const container = frame.parentElement;
    if (!container) {
      return;
    }
    container.style.gridTemplateColumns = `0px 0px minmax(0, 1fr) 0px ${this.#frontendWidth}px`;
  }

  #setFrontendWidth(width) {
    const frame = this.#frontendFrame;
    if (!frame) {
      return;
    }
    const container = frame.parentElement;
    if (!container) {
      return;
    }
    const maxWidth = Math.max(200, container.clientWidth - 200);
    const next = Math.round(Math.max(200, Math.min(maxWidth, width)));
    this.#frontendWidth = next;
    frame.style.width = `${next}px`;
    frame.style.minWidth = `${next}px`;
    frame.style.maxWidth = `${next}px`;
    frame.style.flex = `0 0 ${next}px`;
    this.#syncFrontendColumns();
  }

  #startFrontendResize(event) {
    const frame = this.#frontendFrame;
    const container = frame?.parentElement;
    if (!frame || !container) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#frontendResizing = true;
    this.#frontendSplitter.style.background =
      "var(--focus-outline-color, rgba(120,170,255,0.7))";
    const startX = event.clientX;
    const startWidth = this.#frontendWidth;
    const onMove = moveEvent => {
      const available = container.clientWidth;
      const next = Math.min(
        Math.max(200, startWidth + (startX - moveEvent.clientX)),
        Math.max(200, available - 200)
      );
      this.#setFrontendWidth(next);
    };
    const onUp = () => {
      this.#frontendResizing = false;
      this.#frontendSplitter.style.background = "transparent";
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  }

  matchesTab(tab) {
    return this.#tab === tab;
  }

  matchesWindow(window) {
    return this.#window === window;
  }

  async close() {
    this.#clearDeviceMetrics();
    this.#deviceStyle?.remove();
    this.#deviceStyle = null;
    this.#stopScreencast();
    this.#frontendFrameObserver?.disconnect();
    this.#frontendFrameObserver = null;
    const container = this.#frontendFrame?.parentElement;
    this.#frontendCloseButton?.remove();
    this.#frontendCloseButton = null;
    this.#frontendSplitter?.remove();
    this.#frontendFrame?.remove();
    this.#frontendContainerColumns(container);
    this.#frontendSplitter = null;
    this.#frontendFrame = null;
    this.#frontendPanel = null;
    for (const socket of this.#sockets) {
      try {
        socket.close();
      } catch {}
    }
    this.#sockets.clear();
    try {
      this.#server?.close();
    } catch {}
    this.#server = null;
    try {
      await this.#commands?.destroy();
    } catch {}
    this.#commands = null;
  }

  async open({ panel = null, toggle = false, inspectNode = null } = {}) {
    if (inspectNode) {
      this.inspectNode(inspectNode);
    }
    const selectedPanel =
      panel ||
      Services.prefs.getStringPref(
        "chill.devtools.chrome.panel",
        "elements"
      );
    if (toggle && this.#frontendFrame) {
      this.#frontendFrameObserver?.disconnect();
      this.#frontendFrameObserver = null;
      const container = this.#frontendFrame.parentElement;
      this.#frontendCloseButton?.remove();
      this.#frontendCloseButton = null;
      this.#frontendSplitter?.remove();
      this.#frontendFrame.remove();
      this.#frontendContainerColumns(container);
      this.#frontendFrame = null;
      this.#frontendSplitter = null;
      this.#frontendPanel = null;
      return;
    }
    await this.#openFrontend(selectedPanel);
  }

  async #accept(transport) {
    let input;
    let output;
    try {
      input = transport.openInputStream(0, 0, 0);
      output = transport.openOutputStream(0, 0, 0);
      const socket = await WebSocketServer.accept(transport, input, output, {
        validate: ({ path, headers }) => {
          const origin = headers.get("origin");
          if (!origin) {
            return;
          }
          const allowedOrigins = new Set([
            "http://127.0.0.1:8080",
            `http://127.0.0.1:${this.#port}`,
            "http://localhost:8080",
            `http://localhost:${this.#port}`,
          ]);
          if (!allowedOrigins.has(origin)) {
            throw new Error(`Unexpected WebSocket origin: ${origin}`);
          }
          if (path !== `/${this.#token}`) {
            throw new Error("Unexpected WebSocket token");
          }
        },
      });
      this.#sockets.add(socket);
      log("client connected");

      socket.onmessage = event => {
        this.#onMessage(socket, event.data);
      };
      socket.onclose = () => {
        this.#sockets.delete(socket);
        log("client disconnected");
      };
    } catch (e) {
      log("WebSocket accept failed", e);
      try {
        input?.close();
        output?.close();
      } catch {}
    }
  }

  #send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    let json;
    try {
      json = JSON.stringify(message);
    } catch (e) {
      log("failed to serialize CDP message", e);
      json = JSON.stringify({
        id: message.id,
        error: { code: -32603, message: "Failed to serialize CDP response" },
      });
    }
    socket.send(json);
  }

  #sendEvent(method, params, sessionId) {
    for (const socket of this.#sockets) {
      this.#send(socket, {
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      });
    }
  }

  async #onMessage(socket, data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (e) {
      log("invalid CDP message", e);
      return;
    }
    if (!message.id) {
      return;
    }
    try {
      const result = await this.#handle(message.method, message.params || {});
      this.#send(socket, {
        id: message.id,
        result: result ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      });
    } catch (e) {
      log("CDP error", message.method, e?.message || e);
      this.#send(socket, {
        id: message.id,
        error: {
          code: -32601,
          message: e?.message || String(e),
        },
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      });
    }
  }

  async #handle(method, params) {
    switch (method) {
      case "Schema.getDomains":
        return {
          domains: [
            { name: "Schema", version: "1.3" },
            { name: "Runtime", version: "1.3" },
            { name: "Console", version: "1.1" },
            { name: "Page", version: "1.3" },
            { name: "Debugger", version: "1.3" },
            { name: "Accessibility", version: "1.3" },
            { name: "Security", version: "1.3" },
            { name: "Emulation", version: "1.3" },
            { name: "DOM", version: "1.3" },
            { name: "CSS", version: "1.3" },
            { name: "Overlay", version: "1.3" },
            { name: "Network", version: "1.3" },
            { name: "Log", version: "1.3" },
            { name: "Storage", version: "1.3" },
            { name: "IndexedDB", version: "1.3" },
            { name: "CacheStorage", version: "1.3" },
            { name: "ServiceWorker", version: "1.3" },
            { name: "ServiceWorkerCache", version: "1.3" },
            { name: "Target", version: "1.3" },
          ],
        };

      case "Target.getTargets":
        return { targetInfos: [this.#targetInfo()] };

      case "Target.getTargetInfo":
        return { targetInfo: this.#targetInfo() };

      case "Target.setDiscoverTargets":
        this.#sendEvent("Target.targetCreated", {
          targetInfo: this.#targetInfo(),
        });
        return {};

      case "Target.attachToTarget":
        return { sessionId: SESSION_ID };

      case "Target.detachFromTarget":
      case "Target.setAutoAttach":
      case "Target.activateTarget":
      case "Target.closeTarget":
        return {};

      case "Page.enable":
        this.#emitPageLifecycle();
        return {};

      case "Page.disable":
        return {};

      case "Page.getFrameTree":
        return { frameTree: this.#frameTree() };

      case "Page.getResourceTree":
        return { frameTree: { ...this.#frameTree(), resources: [] } };

      case "Page.getNavigationHistory":
        return {
          currentIndex: 0,
          entries: [
            {
              id: 1,
              url: this.#targetUrl,
              userTypedURL: this.#targetUrl,
              title: this.#targetTitle,
              transitionType: "typed",
            },
          ],
        };

      case "Emulation.setDeviceMetricsOverride":
      case "Page.setDeviceMetricsOverride":
        return this.#setDeviceMetrics(params);

      case "Emulation.clearDeviceMetricsOverride":
      case "Page.clearDeviceMetricsOverride":
        return this.#clearDeviceMetrics();

      case "Emulation.setTouchEmulationEnabled":
      case "Emulation.setEmitTouchEventsForMouse":
        return this.#setTouchEmulation(params);

      case "Emulation.setUserAgentOverride":
        return this.#setUserAgentOverride(params);

      case "Emulation.setEmulatedMedia":
        return this.#setEmulatedMedia(params);

      case "Emulation.setEmulatedVisionDeficiency":
      case "Emulation.setFocusEmulationEnabled":
      case "Emulation.setVisibleSize":
        return {};

      case "Page.startScreencast":
        return this.#startScreencast(params);

      case "Page.stopScreencast":
        this.#stopScreencast();
        return {};

      case "Page.screencastFrameAck":
        return {};

      case "Page.reload":
        this.#tab.linkedBrowser.reload();
        return {};

      case "Page.captureScreenshot":
        return this.#captureScreenshot(params);

      case "Page.getLayoutMetrics":
        return this.#getLayoutMetrics();

      case "Page.getAppManifest":
        return this.#getAppManifest();

      case "Page.getInstallabilityErrors":
        return { installabilityErrors: [] };

      case "Page.getAppId":
        return { appId: null };

      case "Page.getManifestIcons":
        return {};

      case "Page.navigate":
        this.#domReady = false;
        await this.#commands.targetCommand.navigateTo(params.url, true);
        this.#targetUrl = params.url;
        this.#targetTitle = params.url;
        this.#resetDom();
        this.#resetDebuggerSources();
        this.#resetRuntime();
        await new Promise(resolve =>
          this.#window.setTimeout(resolve, 250)
        );
        await this.#enableRuntime();
        this.#scheduleSourceRefresh();
        this.#sendEvent("Page.frameNavigated", {
          frame: this.#frameTree().frame,
        });
        this.#emitPageLifecycle();
        return { frameId: FRAME_ID, loaderId: "chill-loader-1" };

      case "Debugger.enable":
        return this.#enableDebugger();

      case "Debugger.disable":
        return this.#disableDebugger();

      case "Debugger.getScriptSource":
        return this.#getScriptSource(params);

      case "Debugger.getPossibleBreakpoints":
        return this.#getPossibleBreakpoints(params);

      case "Debugger.setBreakpointByUrl":
        return this.#setBreakpointByUrl(params);

      case "Debugger.setBreakpoint":
        return this.#setBreakpoint(params);

      case "Debugger.removeBreakpoint":
        return this.#removeBreakpoint(params);

      case "Debugger.setBreakpointsActive":
        return this.#setBreakpointsActive(params);

      case "Debugger.setBlackboxPatterns":
        return this.#setBlackboxPatterns(params);

      case "Debugger.setBlackboxExecutionContexts":
      case "Debugger.setSkipAllPauses":
        return this.#setSkipAllPauses(params);

      case "Debugger.setAsyncCallStackDepth":
      case "Debugger.setInstrumentationBreakpoint":
      case "Debugger.removeInstrumentationBreakpoint":
        return {};

      case "Debugger.setPauseOnExceptions":
        return this.#setPauseOnExceptions(params);

      case "Debugger.pause":
        return this.#pauseDebugger();

      case "Debugger.resume":
        return this.#resumeDebugger();

      case "Debugger.stepOver":
        return this.#stepDebugger("over");

      case "Debugger.stepInto":
        return this.#stepDebugger("into");

      case "Debugger.stepOut":
        return this.#stepDebugger("out");

      case "Debugger.evaluateOnCallFrame":
        return this.#evaluateOnCallFrame(params);

      case "DOM.enable":
      case "DOM.disable":
      case "CSS.enable":
      case "CSS.disable":
      case "Overlay.enable":
      case "Overlay.disable":
      case "Overlay.setShowViewportSizeOnResize":
      case "Overlay.setShowGridOverlays":
      case "Overlay.setShowFlexOverlays":
      case "Overlay.setShowScrollSnapOverlays":
      case "Overlay.setShowContainerQueryOverlays":
      case "Overlay.setShowIsolatedElements":
      case "Overlay.setShowHinge":
        return {};

      case "Overlay.setInspectMode":
        return this.#setInspectMode(params);

      case "CSS.forcePseudoState":
        return this.#forcePseudoState(params);

      case "CSS.setPropertyText":
        return this.#setPropertyText(params);

      case "CSS.setRuleSelector":
        return this.#setRuleSelector(params);

      case "DOM.getDocument": {
        const result = await this.#getDocument(params);
        this.#domReady = true;
        this.#window.setTimeout(() => this.#maybeSendInspectNode(), 0);
        return result;
      }

      case "DOM.requestChildNodes":
        return this.#requestChildNodes(params);

      case "DOM.querySelector":
        return this.#querySelector(params);

      case "DOM.querySelectorAll":
        return this.#querySelectorAll(params);

      case "DOM.getAttributes":
        return this.#getNodeAttributes(params);

      case "DOM.describeNode":
        return this.#describeNode(params);

      case "DOM.getBoxModel":
      case "DOM.getContentQuads":
        return this.#getBoxModel(params, method === "DOM.getContentQuads");

      case "DOM.setInspectedNode":
      case "DOM.focus":
      case "DOM.hideHighlight":
        return {};

      case "DOM.scrollIntoViewIfNeeded":
        return this.#scrollIntoView(params);

      case "DOM.setAttributeValue":
        return this.#setAttributeValue(params);

      case "DOM.removeAttribute":
        return this.#removeAttribute(params);

      case "DOM.setNodeValue":
        return this.#setNodeValue(params);

      case "CSS.trackComputedStyleUpdates":
        return {};

      case "DOM.pushNodesByBackendIdsToFrontend":
        return { nodeIds: params.backendNodeIds || [] };

      case "DOM.getTopLayerElements":
        return { nodeIds: [] };

      case "DOM.performSearch":
        return { searchId: "chill-search", resultCount: 0 };

      case "DOM.getSearchResults":
        return { ids: [] };

      case "CSS.takeComputedStyleUpdates":
        return { nodeIds: [] };

      case "Overlay.highlightNode":
        return this.#highlightNode(params);

      case "Overlay.hideHighlight":
        return this.#hideHighlight();

      case "CSS.getComputedStyleForNode":
        return this.#getComputedStyle(params);

      case "CSS.getLayersForNode":
        return {
          rootLayer: {
            layerId: "chill-root-layer",
            name: "",
            text: "",
            subLayers: [],
          },
        };

      case "CSS.getAnimatedStylesForNode":
        return {
          animationStyles: [],
          transitionsStyle: null,
          inherited: [],
        };

      case "CSS.getLocationForSelector":
        return {};

      case "CSS.getMatchedStylesForNode":
        return this.#getMatchedStyles(params);

      case "CSS.getInlineStylesForNode":
        return this.#getInlineStyles(params);

      case "CSS.getStyleSheetText":
        return this.#getStyleSheetText(params);

      case "CSS.setStyleSheetText":
        return this.#setStyleSheetText(params);

      case "CSS.getMediaQueries":
        return { mediaQueries: [] };

      case "CSS.getPlatformFontsForNode":
        return { fonts: [] };

      case "CSS.getEnvironmentVariables":
        return { variables: [] };

      case "Runtime.enable":
        await this.#enableRuntime();
        return {};

      case "Runtime.disable":
        return {};

      case "Runtime.evaluate":
        return this.#evaluate(params);

      case "Runtime.getProperties":
        return this.#getProperties(params);

      case "Runtime.releaseObject":
      case "Runtime.releaseObjectGroup":
      case "Runtime.runIfWaitingForDebugger":
      case "Runtime.setAsyncCallStackDepth":
      case "Runtime.discardConsoleEntries":
        return {};

      case "Runtime.getIsolateId":
        return { id: "chill-isolate" };

      case "Runtime.globalLexicalScopeNames":
        return { names: [] };

      case "Runtime.getHeapUsage":
        return { usedSize: 0, totalSize: 0 };

      case "Log.enable":
      case "Log.disable":
      case "Log.clear":
        return {};

      case "Network.enable":
        await this.#enableNetwork();
        return {};

      case "Network.disable":
        await this.#disableNetwork();
        return {};

      case "Network.setBlockedURLs":
        return this.#setBlockedURLs(params);

      case "Network.emulateNetworkConditions":
        return this.#emulateNetworkConditions(params);

      case "Network.setCacheDisabled":
        return this.#setCacheDisabled(params);

      case "Network.setAttachDebugStack":
        return {};

      case "Network.getResponseBody":
        return this.#getResponseBody(params);

      case "Network.getRequestPostData":
        return this.#getRequestPostData(params);

      case "Network.getCookies":
      case "Network.getAllCookies":
      case "Storage.getCookies":
        return this.#getCookies(params);

      case "Network.setCookie":
        return this.#setCookie(params);

      case "Network.deleteCookies":
        return this.#deleteCookie(params);

      case "DOMStorage.enable":
        await this.#enableStorage();
        return {};

      case "DOMStorage.disable":
        await this.#disableStorage();
        return {};

      case "DOMStorage.getDOMStorageItems":
        return this.#getDOMStorageItems(params);

      case "DOMStorage.setDOMStorageItem":
        return this.#setDOMStorageItem(params);

      case "DOMStorage.removeDOMStorageItem":
        return this.#removeDOMStorageItem(params);

      case "DOMStorage.clear":
        return this.#clearDOMStorage(params);

      case "Storage.getStorageKey":
        return this.#getStorageKey();

      case "Storage.enable":
      case "Storage.disable":
        return {};

      case "Storage.setStorageBucketTracking":
        return this.#setStorageBucketTracking(params);

      case "Storage.trackCacheStorageForStorageKey":
      case "Storage.untrackCacheStorageForStorageKey":
      case "Storage.trackIndexedDBForStorageKey":
      case "Storage.untrackIndexedDBForStorageKey":
      case "Storage.deleteStorageBucket":
      case "Storage.clearSharedStorageEntries":
      case "Storage.setSharedStorageTracking":
        return {};

      case "Storage.getUsageAndQuota":
        return this.#getUsageAndQuota();

      case "Storage.clearDataForOrigin":
      case "Storage.clearDataForStorageKey":
        return this.#clearStorageForOrigin(params);

      case "IndexedDB.enable":
        await this.#enableIndexedDB();
        return {};

      case "IndexedDB.disable":
        await this.#disableIndexedDB();
        return {};

      case "IndexedDB.requestDatabaseNames":
        return this.#requestDatabaseNames(params);

      case "IndexedDB.requestDatabase":
        return this.#requestDatabase(params);

      case "IndexedDB.requestData":
        return this.#requestData(params);

      case "IndexedDB.deleteDatabase":
        return this.#deleteDatabase(params);

      case "IndexedDB.clearObjectStore":
        return this.#clearObjectStore(params);

      case "IndexedDB.deleteObjectStoreEntries":
        return this.#deleteObjectStoreEntries(params);

      case "CacheStorage.requestCacheNames":
        return this.#requestCacheNames(params);

      case "CacheStorage.requestEntries":
        return this.#requestCacheEntries(params);

      case "CacheStorage.requestCachedResponse":
        return this.#requestCachedResponse(params);

      case "CacheStorage.deleteCache":
        return this.#deleteCache(params);

      case "CacheStorage.deleteEntry":
        return this.#deleteCacheEntry(params);

      case "ServiceWorker.enable":
        return this.#enableServiceWorker();

      case "ServiceWorker.disable":
        return this.#disableServiceWorker();

      case "ServiceWorker.inspectWorker":
      case "ServiceWorker.setForceUpdateOnPageLoad":
      case "ServiceWorker.stopAllWorkers":
      case "ServiceWorker.skipWaiting":
      case "ServiceWorker.startWorker":
      case "ServiceWorker.stopWorker":
        return {};

      case "ServiceWorkerCache.enable":
        await this.#enableCache();
        return {};

      case "ServiceWorkerCache.disable":
        await this.#disableCache();
        return {};

      case "Accessibility.enable":
        return this.#enableAccessibility();

      case "Accessibility.disable":
        this.#accessibilityEnabled = false;
        return {};

      case "Accessibility.getFullAXTree":
        return this.#getAXTree(params);

      case "Accessibility.getRootAXNode":
        return this.#getRootAXNode();

      case "Accessibility.getPartialAXTree":
      case "Accessibility.getAXNodeAndAncestors":
        return this.#getAXTree(params);

      case "Accessibility.getChildAXNodes":
        return { nodes: [] };

      case "Accessibility.queryAXTree":
        return { nodes: [] };

      case "Security.enable":
      case "Security.disable":
      case "Security.setIgnoreCertificateErrors":
      case "Security.handleCertificateError":
      case "Security.setOverrideCertificateErrors":
      case "Security.showCertificateViewer":
        return {};

      case "Security.getSecurityState":
        return this.#getSecurityState();

      case "Chill.getDeviceModeState":
        return { active: !!this.#deviceMode };

      case "Chill.toggleDeviceToolbar":
        return this.#toggleDeviceToolbar();

      case "Chill.getLayoutDebug":
        return this.#getLayoutDebug();

      case "Chill.closeDevTools":
        await this.open({ toggle: true });
        return {};

      case "Chill.setFrontendWidth":
        this.#setFrontendWidth(Number(params.width) || 0);
        return { width: this.#frontendWidth };

      default:
        throw new Error(`Unsupported CDP method: ${method}`);
    }
  }

  #deviceStack() {
    return this.#tab.linkedBrowser.parentElement;
  }

  #deviceContainer() {
    return this.#deviceStack().parentElement;
  }

  #ensureDeviceStyle() {
    if (this.#deviceStyle) {
      return;
    }
    const style = this.#window.document.createElementNS(XHTML_NS, "style");
    style.textContent = `
      .browserContainer.chill-device-mode > .browserStack {
        overflow: hidden;
        position: relative;
        background: #1e1e1e;
      }
      .browserContainer.chill-device-mode > .browserStack > browser {
        position: absolute;
        left: 50%;
        top: 50%;
        flex: none;
        box-sizing: border-box;
        width: var(--chill-device-width);
        min-width: var(--chill-device-width);
        max-width: var(--chill-device-width);
        height: var(--chill-device-height);
        min-height: var(--chill-device-height);
        max-height: var(--chill-device-height);
        transform: translate(-50%, -50%)
          scale(var(--chill-device-zoom, 1));
        transform-origin: center center;
        outline: 1px solid var(--border-color);
      }
      .chill-device-toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        box-sizing: border-box;
        height: 30px;
        min-height: 30px;
        padding: 0 8px;
        background: var(--zen-colors-tertiary, var(--toolbar-bgcolor));
        color: var(--toolbar-color);
        border-bottom: 1px solid var(--zen-colors-border, var(--border-color));
        color-scheme: var(--toolbar-color-scheme, dark);
        font: message-box;
        font-size: 12px;
        overflow: hidden;
      }
      .chill-device-toolbar menulist {
        min-width: 88px;
        max-width: 150px;
        height: 22px;
        margin: 0;
      }
      .chill-device-toolbar .chill-device-input {
        width: 46px;
        height: 20px;
        padding: 0 4px;
        box-sizing: border-box;
        border: 1px solid var(--zen-colors-border, var(--border-color));
        border-radius: 4px;
        background: var(
          --zen-colors-input-bg,
          var(--toolbar-field-background-color, Field)
        );
        color: inherit;
        font: inherit;
      }
      .chill-device-toolbar .chill-device-x {
        opacity: 0.7;
      }
      .chill-device-toolbar .chill-device-button {
        min-width: 22px;
        height: 22px;
        padding: 0 4px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font: inherit;
      }
      .chill-device-toolbar .chill-device-button:hover {
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
    `;
    this.#window.document.documentElement.appendChild(style);
    this.#deviceStyle = style;
  }

  #clearLegacyDeviceStyles(stack, container) {
    for (const property of [
      "width",
      "min-width",
      "max-width",
      "height",
      "min-height",
      "max-height",
      "flex",
      "margin",
      "outline",
    ]) {
      stack.style.removeProperty(property);
    }
    this.#tab.linkedBrowser.style.removeProperty("width");
    this.#tab.linkedBrowser.style.removeProperty("height");
    container.style.removeProperty("grid-template-columns");
    container.style.removeProperty("justify-content");
  }

  #fitDevice(width, height) {
    const stack = this.#deviceStack();
    const container = stack.parentElement;
    if (!stack.clientWidth || !stack.clientHeight) {
      container.style.setProperty("--chill-device-zoom", "1");
      return 1;
    }
    const availableWidth = Math.max(1, stack.clientWidth - 16);
    const availableHeight = Math.max(1, stack.clientHeight - 8);
    const zoom = Math.max(
      0.1,
      Math.min(1, availableWidth / width, availableHeight / height)
    );
    container.style.setProperty("--chill-device-zoom", String(zoom));
    return zoom;
  }

  #setDeviceMetrics(params) {
    const width = Number(params.width) || 0;
    const height = Number(params.height) || 0;
    if (width <= 0 || height <= 0) {
      return this.#clearDeviceMetrics();
    }
    this.#ensureDeviceStyle();
    const stack = this.#deviceStack();
    const container = stack.parentElement;
    this.#clearLegacyDeviceStyles(stack, container);
    container.classList.add("chill-device-mode");
    container.style.setProperty(
      "--chill-device-width",
      `${Math.round(width)}px`
    );
    container.style.setProperty(
      "--chill-device-height",
      `${Math.round(height)}px`
    );
    if (this.#deviceMode) {
      this.#deviceMode.width = Math.round(width);
      this.#deviceMode.height = Math.round(height);
      this.#deviceMode.preset = "responsive";
      this.#syncDeviceToolbar();
    }
    this.#fitDevice(width, height);
    log("device metrics", width, height);
    return {};
  }

  #clearDeviceMetrics() {
    const stack = this.#deviceStack();
    const container = stack.parentElement;
    const wasActive = !!this.#deviceMode || !!this.#deviceToolbar;
    this.#deviceResizeObserver?.disconnect();
    this.#deviceResizeObserver = null;
    this.#deviceToolbar?.element.remove();
    this.#deviceToolbar = null;
    this.#deviceMode = null;
    container.classList.remove("chill-device-mode");
    for (const property of [
      "--chill-device-width",
      "--chill-device-height",
      "--chill-device-zoom",
      "--rdm-toolbar-height",
    ]) {
      container.style.removeProperty(property);
    }
    this.#clearLegacyDeviceStyles(stack, container);
    this.#syncDeviceTouch();
    if (wasActive) {
      this.#broadcastDeviceMode();
    }
    return {};
  }

  #applyDeviceLayout() {
    if (!this.#deviceMode) {
      return;
    }
    const container = this.#deviceContainer();
    container.style.setProperty(
      "--chill-device-width",
      `${this.#deviceMode.width}px`
    );
    container.style.setProperty(
      "--chill-device-height",
      `${this.#deviceMode.height}px`
    );
    this.#fitDevice(this.#deviceMode.width, this.#deviceMode.height);
    this.#syncDeviceTouch();
  }

  #setDeviceModeSize(width, height, { mobile, preset } = {}) {
    if (!this.#deviceMode) {
      return;
    }
    this.#deviceMode.width = Math.max(1, Math.min(10000, Math.round(width)));
    this.#deviceMode.height = Math.max(1, Math.min(10000, Math.round(height)));
    if (typeof mobile === "boolean") {
      this.#deviceMode.mobile = mobile;
    }
    if (preset) {
      this.#deviceMode.preset = preset;
    }
    this.#applyDeviceLayout();
    this.#syncDeviceToolbar();
  }

  #createDeviceInput() {
    const input = this.#window.document.createElementNS(XHTML_NS, "input");
    input.type = "number";
    input.min = "1";
    input.max = "10000";
    input.step = "1";
    input.inputMode = "numeric";
    input.className = "chill-device-input";
    return input;
  }

  #createDeviceButton(label, title) {
    const button = this.#window.document.createElementNS(XHTML_NS, "button");
    button.type = "button";
    button.className = "chill-device-button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    return button;
  }

  #createDeviceToolbar() {
    const doc = this.#window.document;
    const element = doc.createXULElement("hbox");
    element.className = "chill-device-toolbar";
    element.style.gridArea = "rdm-toolbar";

    const select = doc.createXULElement("menulist");
    const popup = doc.createXULElement("menupopup");
    for (const preset of DEVICE_PRESETS) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", preset.label);
      item.setAttribute("value", preset.id);
      popup.appendChild(item);
    }
    select.appendChild(popup);
    select.value = "responsive";
    select.addEventListener("command", () => {
      const preset = DEVICE_PRESETS.find(p => p.id === select.value);
      if (!preset) {
        return;
      }
      const width = preset.width || this.#deviceMode?.width || 390;
      const height = preset.height || this.#deviceMode?.height || 844;
      this.#setDeviceModeSize(width, height, {
        mobile: preset.mobile,
        preset: preset.id,
      });
    });

    const widthInput = this.#createDeviceInput();
    const heightInput = this.#createDeviceInput();
    const times = doc.createXULElement("label");
    times.className = "chill-device-x";
    times.textContent = "×";
    const applyInputs = () => {
      const width = Number(widthInput.value);
      const height = Number(heightInput.value);
      if (!width || !height) {
        this.#syncDeviceToolbar();
        return;
      }
      this.#setDeviceModeSize(width, height, { preset: "responsive" });
    };
    for (const input of [widthInput, heightInput]) {
      input.addEventListener("change", applyInputs);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          applyInputs();
          input.blur();
        }
      });
    }

    const rotate = this.#createDeviceButton("⟳", "Rotate");
    rotate.addEventListener("click", () => {
      if (!this.#deviceMode) {
        return;
      }
      this.#setDeviceModeSize(this.#deviceMode.height, this.#deviceMode.width);
    });
    const close = this.#createDeviceButton("✕", "Close device mode");
    close.addEventListener("click", () => this.#exitDeviceMode());

    element.append(select, widthInput, times, heightInput, rotate, close);
    return { element, select, widthInput, heightInput };
  }

  #syncDeviceToolbar() {
    if (!this.#deviceMode || !this.#deviceToolbar) {
      return;
    }
    const { select, widthInput, heightInput } = this.#deviceToolbar;
    const width = String(this.#deviceMode.width);
    const height = String(this.#deviceMode.height);
    if (widthInput.value !== width) {
      widthInput.value = width;
    }
    if (heightInput.value !== height) {
      heightInput.value = height;
    }
    const preset = this.#deviceMode.preset || "responsive";
    if (select.value !== preset) {
      select.value = preset;
    }
  }

  #syncDeviceTouch() {
    const enabled = !!this.#deviceMode?.mobile;
    if (enabled === this.#deviceTouch) {
      return;
    }
    this.#deviceTouch = enabled;
    this.#setTouchEmulation({ enabled }).catch(() => {});
  }

  #enterDeviceMode() {
    if (this.#deviceMode) {
      return;
    }
    const stack = this.#deviceStack();
    const container = stack.parentElement;
    const browser = this.#tab.linkedBrowser;
    const existingWidth =
      Number.parseFloat(
        container.style.getPropertyValue("--chill-device-width")
      ) || 0;
    const existingHeight =
      Number.parseFloat(
        container.style.getPropertyValue("--chill-device-height")
      ) || 0;
    const width = Math.max(
      1,
      Math.round(
        existingWidth || browser.clientWidth || stack.clientWidth || 390
      )
    );
    const height = Math.max(
      1,
      Math.round(
        existingHeight || browser.clientHeight || stack.clientHeight || 844
      )
    );

    this.#ensureDeviceStyle();
    this.#clearLegacyDeviceStyles(stack, container);
    this.#deviceMode = { width, height, mobile: false, preset: "responsive" };
    this.#deviceToolbar = this.#createDeviceToolbar();
    container.classList.add("chill-device-mode");
    container.style.setProperty("--rdm-toolbar-height", "30px");
    container.appendChild(this.#deviceToolbar.element);
    this.#deviceResizeObserver = new this.#window.ResizeObserver(() => {
      if (!this.#deviceMode) {
        return;
      }
      this.#fitDevice(this.#deviceMode.width, this.#deviceMode.height);
    });
    this.#deviceResizeObserver.observe(stack);
    this.#syncDeviceToolbar();
    this.#applyDeviceLayout();
    this.#window.requestAnimationFrame(() => {
      if (!this.#deviceMode) {
        return;
      }
      this.#applyDeviceLayout();
      this.#syncDeviceToolbar();
    });
    this.#broadcastDeviceMode();
    log("device mode enabled", width, height);
  }

  #exitDeviceMode() {
    if (!this.#deviceMode && !this.#deviceToolbar) {
      return;
    }
    this.#clearDeviceMetrics();
    log("device mode disabled");
  }

  #toggleDeviceToolbar() {
    if (this.#deviceMode || this.#deviceToolbar) {
      this.#exitDeviceMode();
    } else {
      this.#enterDeviceMode();
    }
    return { active: !!this.#deviceMode };
  }

  #broadcastDeviceMode() {
    for (const socket of this.#sockets) {
      this.#send(socket, {
        method: "Chill.deviceModeChanged",
        params: { active: !!this.#deviceMode },
      });
    }
  }

  async #startScreencast(params) {
    this.#stopScreencast();
    const sessionId = ++this.#screencastSessionId;
    const capture = async () => {
      if (sessionId !== this.#screencastSessionId) {
        return;
      }
      try {
        const { captureScreenshot } = require(
          "devtools/client/shared/screenshot"
        );
        const response = await captureScreenshot(
          this.#commands.targetCommand.targetFront,
          {
            disableFlash: true,
            ignoreDprForFileScale: true,
            dpr: 1,
            fullpage: false,
          }
        );
        if (!response?.data) {
          return;
        }
        const data = response.data.replace(/^data:image\/[^;]+;base64,/, "");
        const rect = this.#tab.linkedBrowser.getBoundingClientRect();
        const metadata = {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: Math.round(rect.width),
          deviceHeight: Math.round(rect.height),
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: Date.now() / 1000,
        };
        this.#sendEvent("Page.screencastFrame", {
          data,
          sessionId,
          metadata,
        });
      } catch (e) {
        log("screencast capture failed", e?.message || e);
      }
    };
    await capture();
    this.#screencastTimer = this.#window.setInterval(capture, 1000);
    log("screencast started", sessionId);
    return {};
  }

  #stopScreencast() {
    if (this.#screencastTimer) {
      this.#window.clearInterval(this.#screencastTimer);
      this.#screencastTimer = null;
    }
    this.#screencastSessionId++;
  }

  #emitPageLifecycle() {
    const timestamp = Date.now() / 1000;
    this.#sendEvent("Page.domContentEventFired", { timestamp });
    this.#sendEvent("Page.loadEventFired", { timestamp });
    for (const name of ["init", "DOMContentLoaded", "load"]) {
      this.#sendEvent("Page.lifecycleEvent", {
        frameId: FRAME_ID,
        loaderId: "chill-loader-1",
        name,
        timestamp,
      });
    }
  }

  #targetInfo() {
    return {
      targetId: TARGET_ID,
      type: "page",
      title: this.#targetTitle,
      url: this.#targetUrl,
      attached: true,
      canAccessOpener: false,
      capabilities: 1048575,
    };
  }

  #frameTree() {
    return {
      frame: {
        id: FRAME_ID,
        loaderId: "chill-loader-1",
        url: this.#targetUrl,
        domainAndRegistry: "",
        securityOrigin: "",
        mimeType: "text/html",
      },
    };
  }

  async #enableNetwork() {
    if (this.#networkStarted) {
      return;
    }
    this.#networkStarted = true;
    this.#networkOnAvailable = resources => {
      for (const resource of resources) {
        this.#onNetworkResource(resource);
      }
    };
    this.#networkOnUpdated = updates => {
      this.#onNetworkUpdate(updates);
    };
    await this.#commands.resourceCommand.watchResources(
      [ResourceCommand.TYPES.NETWORK_EVENT],
      {
        onAvailable: this.#networkOnAvailable,
        onUpdated: this.#networkOnUpdated,
      }
    );
    this.#websocketStarted = true;
    this.#websocketOnAvailable = resources => {
      for (const resource of resources) {
        this.#onWebSocketResource(resource);
      }
    };
    await this.#commands.resourceCommand.watchResources(
      [ResourceCommand.TYPES.WEBSOCKET],
      { onAvailable: this.#websocketOnAvailable }
    );
    const url = this.#tab?.linkedBrowser?.currentURI?.spec;
    if (url && url !== this.#targetUrl) {
      this.#targetUrl = url;
      this.#targetTitle = this.#tab.label;
      this.#sendEvent("Target.targetInfoChanged", {
        targetInfo: this.#targetInfo(),
      });
      this.#sendEvent("Page.frameNavigated", {
        frame: this.#frameTree().frame,
      });
    }
  }

  async #disableNetwork() {
    if (!this.#networkStarted) {
      return;
    }
    this.#networkStarted = false;
    if (this.#networkOnAvailable) {
      await this.#commands.resourceCommand.unwatchResources(
        [ResourceCommand.TYPES.NETWORK_EVENT],
        { onAvailable: this.#networkOnAvailable }
      );
    }
    if (this.#websocketStarted && this.#websocketOnAvailable) {
      await this.#commands.resourceCommand.unwatchResources(
        [ResourceCommand.TYPES.WEBSOCKET],
        { onAvailable: this.#websocketOnAvailable }
      );
    }
    this.#websocketStarted = false;
    this.#networkResources.clear();
  }

  async #onWebSocketResource(resource) {
    const requestId = String(resource.httpChannelId || "");
    if (!requestId) {
      return;
    }
    switch (resource.wsMessageType) {
      case "webSocketOpened":
        this.#websocketCreatedRequests.add(requestId);
        this.#sendEvent("Network.webSocketCreated", {
          requestId,
          url: resource.effectiveURI || "",
        });
        {
          const pending = this.#pendingWebSocketFrames.get(requestId) || [];
          this.#pendingWebSocketFrames.delete(requestId);
          for (const frame of pending) {
            this.#sendEvent(frame.method, frame.params);
          }
        }
        this.#sendEvent("Network.webSocketWillSendHandshakeRequest", {
          requestId,
          timestamp: Date.now() / 1000,
          wallTime: Date.now() / 1000,
          request: {
            headers: {},
          },
        });
        this.#sendEvent("Network.webSocketHandshakeResponseReceived", {
          requestId,
          timestamp: Date.now() / 1000,
          response: {
            status: 101,
            statusText: "Switching Protocols",
            headers: {},
          },
        });
        break;
      case "webSocketClosed":
        this.#sendEvent("Network.webSocketClosed", {
          requestId,
          timestamp: Date.now() / 1000,
        });
        this.#websocketCreatedRequests.delete(requestId);
        this.#pendingWebSocketFrames.delete(requestId);
        break;
      case "frameSent":
      case "frameReceived": {
        const direction =
          resource.wsMessageType === "frameSent" ? "sent" : "received";
        let payloadData = "";
        try {
          payloadData = await this.#longStringValue(
            resource.data?.payload
          );
        } catch {}
        const method =
          direction === "sent"
            ? "Network.webSocketFrameSent"
            : "Network.webSocketFrameReceived";
        const params = {
          requestId,
          timestamp: Number(resource.data?.timeStamp) / 1000,
          response: {
            opcode: Number(resource.data?.opCode) || 1,
            mask: !!resource.data?.mask,
            payloadData,
          },
        };
        if (!this.#websocketCreatedRequests.has(requestId)) {
          const pending = this.#pendingWebSocketFrames.get(requestId) || [];
          pending.push({ method, params });
          this.#pendingWebSocketFrames.set(requestId, pending);
          break;
        }
        this.#sendEvent(method, params);
        break;
      }
    }
  }

  #onNetworkResource(resource) {
    if (!resource?.resourceId) {
      return;
    }
    const state = this.#networkResources.get(resource.resourceId) || {};
    Object.assign(state, resource);
    this.#networkResources.set(resource.resourceId, state);
    if (state.isNavigationRequest && state.url && state.url !== this.#targetUrl) {
      this.#targetUrl = state.url;
      this.#targetTitle = state.url;
      this.#domReady = false;
      this.#resetDom();
      this.#resetDebuggerSources();
      this.#resetRuntime();
      this.#window.setTimeout(() => {
        this.#enableRuntime().catch(e =>
          log("failed to re-enable runtime", e?.message || e)
        );
      }, 250);
      this.#scheduleSourceRefresh();
      this.#sendEvent("Target.targetInfoChanged", {
        targetInfo: this.#targetInfo(),
      });
      this.#sendEvent("Page.frameNavigated", {
        frame: this.#frameTree().frame,
      });
    }
    this.#emitNetworkState(state);
  }

  #onNetworkUpdate(updates) {
    for (const entry of updates) {
      const resource = entry.resource || entry;
      const resourceUpdates =
        entry.update?.resourceUpdates || entry.resourceUpdates || entry;
      const resourceId = resource.resourceId || entry.resourceId;
      if (!resourceId) {
        continue;
      }
      if (
        resource.resourceType &&
        resource.resourceType !== ResourceCommand.TYPES.NETWORK_EVENT
      ) {
        continue;
      }
      const state = this.#networkResources.get(resourceId) || { resourceId };
      Object.assign(state, resource);
      Object.assign(state, resourceUpdates);
      this.#networkResources.set(resourceId, state);
      this.#emitNetworkState(state);
    }
  }

  #emitNetworkState(state) {
    if (!state._requestSent) {
      state._requestSent = true;
      this.#sendRequestWillBeSent(state);
    }
    if (state.blockedReason && !state._failedSent) {
      state._failedSent = true;
      this.#sendLoadingFailed(state);
      return;
    }
    if (
      (state.responseStartAvailable ||
        state.status !== undefined ||
        state.responseHeadersAvailable) &&
      !state._responseSent
    ) {
      state._responseSent = true;
      this.#sendResponseReceived(state);
    }
    if (
      (state.responseEndAvailable || state.responseContentAvailable) &&
      !state._finishedSent
    ) {
      state._finishedSent = true;
      this.#sendLoadingFinished(state);
    }
  }

  #sendRequestWillBeSent(state) {
    const startedMs = state.startedMs || Date.now();
    const postData = state.requestPostData?.postData?.text;
    this.#sendEvent("Network.requestWillBeSent", {
      requestId: state.resourceId,
      loaderId: "chill-loader-1",
      documentURL: this.#targetUrl,
      request: {
        url: state.url || "",
        method: state.method || "GET",
        headers: this.#headersToObject(state.requestHeaders),
        ...(postData ? { postData, hasPostData: true } : {}),
        mixedContentType: "none",
        initialPriority: "High",
        referrerPolicy: "no-referrer",
      },
      timestamp: startedMs / 1000,
      wallTime: startedMs / 1000,
      initiator: { type: "other" },
      type: this.#networkType(state),
      frameId: FRAME_ID,
      hasUserGesture: false,
    });
  }

  #sendResponseReceived(state) {
    this.#sendEvent("Network.responseReceived", {
      requestId: state.resourceId,
      loaderId: "chill-loader-1",
      timestamp: (state.startedMs || Date.now()) / 1000,
      type: this.#networkType(state),
      response: {
        url: state.url || "",
        status: Number(state.status) || 0,
        statusText: state.statusText || "",
        headers: this.#headersToObject(state.responseHeaders),
        mimeType: state.mimeType || "",
        connectionReused: false,
        connectionId: 0,
        remoteIPAddress: state.remoteAddress || "",
        remotePort: state.remotePort || 0,
        fromDiskCache: !!state.fromCache,
        fromServiceWorker: !!state.fromServiceWorker,
        fromPrefetchCache: false,
        encodedDataLength: state.transferredSize || 0,
        timing: this.#networkTiming(state),
      },
      hasExtraInfo: false,
      frameId: FRAME_ID,
    });
  }

  #sendLoadingFinished(state) {
    this.#sendEvent("Network.loadingFinished", {
      requestId: state.resourceId,
      timestamp: Date.now() / 1000,
      encodedDataLength: state.transferredSize || 0,
      shouldReportCorbBlocking: false,
    });
  }

  #sendLoadingFailed(state) {
    this.#sendEvent("Network.loadingFailed", {
      requestId: state.resourceId,
      timestamp: Date.now() / 1000,
      type: this.#networkType(state),
      errorText: `Blocked request (${state.blockedReason})`,
      canceled: false,
      blockedReason: state.blockedReason === 4000 ? "csp" : "other",
    });
  }

  async #setCacheDisabled(params) {
    await this.#commands.targetConfigurationCommand.updateConfiguration({
      cacheDisabled: !!params.cacheDisabled,
    });
    return {};
  }

  async #setUserAgentOverride(params) {
    await this.#commands.targetConfigurationCommand.updateConfiguration({
      customUserAgent: params.userAgent || null,
    });
    return {};
  }

  async #setEmulatedMedia(params) {
    const features = new Map(
      (params.features || []).map(feature => [feature.name, feature.value])
    );
    const configuration = {};
    if (features.has("prefers-color-scheme")) {
      configuration.colorSchemeSimulation =
        features.get("prefers-color-scheme") || null;
    }
    if (features.has("prefers-reduced-motion")) {
      configuration.reducedMotionEmulation =
        features.get("prefers-reduced-motion") || null;
    }
    if (configuration.colorSchemeSimulation === null) {
      delete configuration.colorSchemeSimulation;
    }
    if (configuration.reducedMotionEmulation === null) {
      delete configuration.reducedMotionEmulation;
    }
    if (Object.keys(configuration).length) {
      await this.#commands.targetConfigurationCommand.updateConfiguration(
        configuration
      );
    }
    return {};
  }

  async #setTouchEmulation(params) {
    await this.#commands.targetConfigurationCommand.updateConfiguration({
      touchEventsOverride: params.enabled ? "enabled" : null,
    });
    return {};
  }

  async #setBlockedURLs(params) {
    const watcherFront = this.#commands.targetCommand.watcherFront;
    const networkParent = await watcherFront.getNetworkParentActor();
    await networkParent.setBlockedUrls(params.urls || []);
    return {};
  }

  async #emulateNetworkConditions(params) {
    const watcherFront = this.#commands.targetCommand.watcherFront;
    const networkParent = await watcherFront.getNetworkParentActor();
    await this.#commands.targetConfigurationCommand.updateConfiguration({
      setTabOffline: !!params.offline,
    });
    if (params.offline) {
      return {};
    }
    if (
      params.downloadThroughput !== undefined ||
      params.uploadThroughput !== undefined ||
      params.latency !== undefined
    ) {
      await networkParent.setNetworkThrottling({
        latency: Number(params.latency) || 0,
        downloadThroughput: Number(params.downloadThroughput) || 0,
        uploadThroughput: Number(params.uploadThroughput) || 0,
      });
    } else {
      await networkParent.clearNetworkThrottling();
    }
    return {};
  }

  async #getResponseBody(params) {
    const state = this.#networkResources.get(params.requestId);
    if (!state?.actor) {
      return { body: "", base64Encoded: false };
    }
    const response = await this.#commands.client.request({
      to: state.actor,
      type: "getResponseContent",
    });
    let text = response.content?.text;
    if (text && typeof text === "object" && text.actor) {
      const substring = await this.#commands.client.request({
        to: text.actor,
        type: "substring",
        start: 0,
        end: text.length,
      });
      text = substring.substring;
    }
    return {
      body: typeof text === "string" ? text : "",
      base64Encoded: false,
    };
  }

  #getRequestPostData(params) {
    const state = this.#networkResources.get(params.requestId);
    const postData = state?.requestPostData?.postData?.text || "";
    return { postData };
  }

  async #enableStorage() {
    if (this.#storageStarted) {
      return;
    }
    this.#storageStarted = true;
    this.#storageOnAvailable = resources => {
      for (const resource of resources) {
        if (resource.resourceKey) {
          this.#storageFronts.set(resource.resourceKey, resource);
        }
      }
    };
    await this.#commands.resourceCommand.watchResources(
      [
        ResourceCommand.TYPES.LOCAL_STORAGE,
        ResourceCommand.TYPES.SESSION_STORAGE,
      ],
      { onAvailable: this.#storageOnAvailable }
    );
  }

  async #disableStorage() {
    if (!this.#storageStarted) {
      return;
    }
    this.#storageStarted = false;
    if (this.#storageOnAvailable) {
      await this.#commands.resourceCommand.unwatchResources(
        [
          ResourceCommand.TYPES.LOCAL_STORAGE,
          ResourceCommand.TYPES.SESSION_STORAGE,
        ],
        { onAvailable: this.#storageOnAvailable }
      );
    }
    this.#storageFronts.clear();
  }

  async #getStorageFront(isLocalStorage) {
    if (!this.#storageStarted) {
      await this.#enableStorage();
    }
    return this.#storageFronts.get(
      isLocalStorage ? "localStorage" : "sessionStorage"
    );
  }

  #storageOrigin(storageId) {
    const raw =
      storageId?.securityOrigin ||
      storageId?.storageKey ||
      storageId?.storageBucket?.storageKey ||
      storageId?.origin ||
      this.#targetUrl ||
      "";
    try {
      return new URL(raw.split("^")[0]).origin;
    } catch {
      return raw.split("^")[0].replace(/\/$/, "");
    }
  }

  #setStorageBucketTracking(params) {
    const origin = this.#storageOrigin(params);
    if (!origin || origin === "null") {
      return {};
    }
    const id = `chill-bucket-${origin}`;
    if (params.enable === false) {
      if (this.#storageBuckets.delete(id)) {
        this.#window.setTimeout(() => {
          this.#sendEvent("Storage.storageBucketDeleted", { bucketId: id });
        }, 0);
      }
      return {};
    }
    const bucketInfo = {
      bucket: { storageKey: origin },
      id,
      expiration: 0,
      quota: 0,
      persistent: false,
      durability: "strict",
    };
    this.#storageBuckets.set(id, bucketInfo);
    this.#window.setTimeout(() => {
      this.#sendEvent("Storage.storageBucketCreatedOrUpdated", {
        bucketInfo,
      });
    }, 0);
    return {};
  }

  async #getDOMStorageItems(params) {
    const storageId = params.storageId || {};
    const front = await this.#getStorageFront(!!storageId.isLocalStorage);
    if (!front) {
      return { entries: [] };
    }
    const result = await front.getStoreObjects(
      this.#storageOrigin(storageId),
      null,
      { offset: 0, size: 1000, sortOn: "name", sessionString: "" }
    );
    const entries = (result?.data || []).map(item => [
      item.name,
      typeof item.value === "object" && item.value !== null
        ? item.value.initial ?? item.value.actor ?? ""
        : String(item.value ?? ""),
    ]);
    return { entries };
  }

  async #setDOMStorageItem(params) {
    const storageId = params.storageId || {};
    const front = await this.#getStorageFront(!!storageId.isLocalStorage);
    if (!front) {
      return {};
    }
    await front.editItem({
      host: this.#storageOrigin(storageId),
      field: "value",
      oldValue: params.key,
      items: { name: params.key, value: params.value },
    });
    return {};
  }

  async #removeDOMStorageItem(params) {
    const storageId = params.storageId || {};
    const front = await this.#getStorageFront(!!storageId.isLocalStorage);
    if (!front) {
      return {};
    }
    await front.removeItem(this.#storageOrigin(storageId), params.key);
    return {};
  }

  async #clearDOMStorage(params) {
    const storageId = params.storageId || {};
    const front = await this.#getStorageFront(!!storageId.isLocalStorage);
    if (!front) {
      return {};
    }
    await front.removeAll(this.#storageOrigin(storageId));
    return {};
  }

  #getCookies(params) {
    const urls = params.urls || (this.#targetUrl ? [this.#targetUrl] : []);
    const seen = new Set();
    const cookies = [];
    for (const url of urls) {
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      for (const cookie of Services.cookies.getCookiesFromHost(host, {})) {
        const key = `${cookie.name}|${cookie.host}|${cookie.path}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        cookies.push(this.#cookieToCdp(cookie, url));
      }
    }
    return { cookies };
  }

  #cookieToCdp(cookie, url) {
    const sameSite =
      cookie.sameSite === Ci.nsICookie.SAMESITE_STRICT
        ? "Strict"
        : cookie.sameSite === Ci.nsICookie.SAMESITE_NONE
          ? "None"
          : "Lax";
    let sourceScheme = "NonSecure";
    try {
      sourceScheme = new URL(url).protocol === "https:" ? "Secure" : "NonSecure";
    } catch {}
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.host,
      path: cookie.path,
      expires: cookie.isSession ? -1 : cookie.expiry,
      size: (cookie.name?.length || 0) + (cookie.value?.length || 0),
      httpOnly: cookie.isHttpOnly,
      secure: cookie.isSecure,
      session: cookie.isSession,
      sameSite,
      priority: "Medium",
      sourceScheme,
      sourcePort: -1,
    };
  }

  #setCookie(params) {
    let host;
    let path = params.path || "/";
    try {
      const url = new URL(params.url || this.#targetUrl);
      host = params.domain || url.hostname;
    } catch {
      return { success: false };
    }
    const sameSite =
      params.sameSite === "Strict"
        ? Ci.nsICookie.SAMESITE_STRICT
        : params.sameSite === "None"
          ? Ci.nsICookie.SAMESITE_NONE
          : Ci.nsICookie.SAMESITE_LAX;
    const isSession = params.expires === undefined || params.expires <= 0;
    const expiry = isSession ? Number.MAX_SAFE_INTEGER : params.expires;
    const scheme = params.secure
      ? Ci.nsICookie.SCHEME_HTTPS
      : Ci.nsICookie.SCHEME_HTTP;
    try {
      Services.cookies.add(
        host,
        path,
        params.name,
        params.value,
        !!params.secure,
        !!params.httpOnly,
        isSession,
        expiry,
        {},
        sameSite,
        sameSite,
        scheme
      );
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  #deleteCookie(params) {
    let host;
    try {
      host =
        params.domain || new URL(params.url || this.#targetUrl).hostname;
    } catch {
      return {};
    }
    Services.cookies.remove(host, params.name, params.path || "/", {});
    return {};
  }

  async #getLayoutMetrics() {
    try {
      const response = await this.#commands.scriptCommand.execute(
        "JSON.stringify({w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight})",
        {
          selectedTargetFront: this.#commands.targetCommand.targetFront,
        }
      );
      const raw = response.result?.value ?? response.result;
      const size = JSON.parse(raw);
      const viewport = {
        pageX: 0,
        pageY: 0,
        clientWidth: Number(size.w) || 0,
        clientHeight: Number(size.h) || 0,
      };
      const content = {
        x: 0,
        y: 0,
        width: Number(size.sw) || 0,
        height: Number(size.sh) || 0,
      };
      const visual = {
        offsetX: 0,
        offsetY: 0,
        pageX: 0,
        pageY: 0,
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
        scale: 1,
        zoom: 1,
      };
      return {
        layoutViewport: viewport,
        visualViewport: visual,
        contentSize: content,
        cssLayoutViewport: viewport,
        cssVisualViewport: visual,
        cssContentSize: content,
      };
    } catch {
      return {
        layoutViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 0,
          clientHeight: 0,
        },
        contentSize: { x: 0, y: 0, width: 0, height: 0 },
      };
    }
  }

  async #getAppManifest() {
    try {
      const front =
        await this.#commands.targetCommand.targetFront.getFront("manifest");
      const response = await front.fetchCanonicalManifest();
      if (response?.manifest) {
        return {
          url: response.manifest.url || this.#targetUrl,
          errors: [],
          data: JSON.stringify(response.manifest),
        };
      }
      return {
        url: this.#targetUrl,
        errors: [
          {
            message: response?.errorMessage || "No manifest detected",
            critical: 0,
            line: 0,
            column: 0,
          },
        ],
        data: "",
      };
    } catch (e) {
      return {
        url: this.#targetUrl,
        errors: [
          {
            message: e?.message || "No manifest detected",
            critical: 0,
            line: 0,
            column: 0,
          },
        ],
        data: "",
      };
    }
  }

  async #captureScreenshot(params) {
    const { captureScreenshot } = require("devtools/client/shared/screenshot");
    const response = await captureScreenshot(
      this.#commands.targetCommand.targetFront,
      {
        disableFlash: true,
        ignoreDprForFileScale: true,
        dpr: params.deviceScaleFactor || 1,
        fullpage: false,
      }
    );
    return {
      data: (response?.data || "").replace(/^data:image\/[^;]+;base64,/, ""),
    };
  }

  async #clearStorageForOrigin(params) {
    await this.#enableStorage();
    const origin = this.#storageOrigin({
      storageKey: params.origin || params.storageKey || this.#targetUrl,
    });
    const requested = new Set(
      String(params.storageTypes || "all")
        .split(",")
        .map(type => type.trim())
        .filter(Boolean)
    );
    const clearAll = requested.has("all");
    for (const front of this.#storageFronts.values()) {
      try {
        await front.removeAll(origin);
      } catch (e) {
        log("failed to clear storage", e?.message || e);
      }
    }
    if (clearAll || requested.has("indexeddb")) {
      try {
        const front = await this.#getIndexedDBFront();
        const response = await this.#idbStoreObjects(origin, null);
        for (const database of response?.data || []) {
          await front?.removeDatabase?.(
            origin,
            database.uniqueKey || database.db || database.name
          );
        }
      } catch (e) {
        log("failed to clear indexedDB", e?.message || e);
      }
    }
    if (clearAll || requested.has("cache_storage")) {
      try {
        await this.#enableCache();
        for (const cacheName of await this.#cacheNames(origin)) {
          await this.#cacheRemoveItem(origin, [cacheName]);
        }
      } catch (e) {
        log("failed to clear cache storage", e?.message || e);
      }
    }
    try {
      const host = new URL(origin).hostname;
      for (const cookie of Services.cookies.getCookiesFromHost(host, {})) {
        Services.cookies.remove(cookie.host, cookie.name, cookie.path, {});
      }
    } catch (e) {
      log("failed to clear cookies", e?.message || e);
    }
    return {};
  }

  async #getUsageAndQuota() {
    try {
      const principal = this.#tab.linkedBrowser.contentPrincipal;
      const result = await new Promise(resolve => {
        Services.qms.getUsageForPrincipal(principal, request => {
          resolve(request.result || {});
        });
      });
      return {
        usage: Number(result.usage) || 0,
        quota: Number(result.quota) || 0,
        overrideActive: false,
        usageBreakdown: [],
      };
    } catch {
      return {
        usage: 0,
        quota: 0,
        overrideActive: false,
        usageBreakdown: [],
      };
    }
  }

  #getStorageKey() {
    try {
      return { storageKey: new URL(this.#targetUrl).origin };
    } catch {
      return { storageKey: "" };
    }
  }

  async #enableIndexedDB() {
    if (this.#indexedDBStarted) {
      return;
    }
    this.#indexedDBStarted = true;
    this.#indexedDBOnAvailable = resources => {
      for (const resource of resources) {
        if (resource?.resourceKey === "indexedDB") {
          this.#indexedDBFront = resource;
        }
      }
    };
    await this.#commands.resourceCommand.watchResources(
      [ResourceCommand.TYPES.INDEXED_DB],
      { onAvailable: this.#indexedDBOnAvailable }
    );
  }

  async #disableIndexedDB() {
    if (!this.#indexedDBStarted) {
      return;
    }
    this.#indexedDBStarted = false;
    if (this.#indexedDBOnAvailable) {
      await this.#commands.resourceCommand.unwatchResources(
        [ResourceCommand.TYPES.INDEXED_DB],
        { onAvailable: this.#indexedDBOnAvailable }
      );
    }
    this.#indexedDBFront = null;
  }

  async #getIndexedDBFront() {
    if (this.#indexedDBFront) {
      return this.#indexedDBFront;
    }
    try {
      this.#indexedDBFront =
        await this.#commands.targetCommand.targetFront.getFront("indexedDB");
    } catch {
      this.#indexedDBFront = null;
    }
    return this.#indexedDBFront;
  }

  async #idbStoreObjects(origin, names, options = {}) {
    const front = await this.#getIndexedDBFront();
    if (!front?.getStoreObjects) {
      return { data: [], total: 0 };
    }
    return front.getStoreObjects(origin, names, {
      offset: 0,
      size: 1000,
      sortOn: "name",
      sessionString: "",
      ...options,
    });
  }

  async #requestDatabaseNames(params) {
    const origin = this.#storageOrigin(params);
    const response = await this.#idbStoreObjects(origin, null);
    const databaseNames = (response?.data || [])
      .map(item => item.db || item.name)
      .filter(Boolean);
    return { databaseNames };
  }

  #cdpKeyPath(keyPath) {
    if (Array.isArray(keyPath)) {
      return { type: "array", array: keyPath.map(String) };
    }
    return { type: "string", string: String(keyPath ?? "") };
  }

  async #requestDatabase(params) {
    const origin = this.#storageOrigin(params);
    const databaseName = params.databaseName || "";
    const databases = await this.#idbStoreObjects(origin, null);
    const database = (databases?.data || []).find(
      item => (item.db || item.name) === databaseName
    );
    const uniqueKey = database?.uniqueKey || databaseName;
    const response = await this.#idbStoreObjects(origin, [
      JSON.stringify([uniqueKey]),
    ]);
    const objectStores = (response?.data || []).map(item => {
      let indexes = [];
      try {
        indexes = JSON.parse(item.indexes || "[]");
      } catch {}
      return {
        name: item.objectStore || item.name || "",
        keyPath: this.#cdpKeyPath(item.keyPath),
        autoIncrement: !!item.autoIncrement,
        indexes: indexes.map(index => ({
          name: index.name || "",
          keyPath: this.#cdpKeyPath(index.keyPath),
          unique: !!index.unique,
          multiEntry: !!index.multiEntry,
        })),
      };
    });
    return {
      databaseWithObjectStores: {
        name: databaseName,
        version: Number(database?.version || 1),
        objectStores,
      },
    };
  }

  async #longStringValue(value) {
    if (typeof value === "string") {
      return value;
    }
    if (!value || typeof value !== "object") {
      return String(value ?? "");
    }
    if (typeof value.initial === "string") {
      return value.initial;
    }
    if (!value.actor) {
      return String(value);
    }
    const response = await this.#commands.client.request({
      to: value.actor,
      type: "substring",
      start: 0,
      end: value.length || 1000000,
    });
    return response?.substring ?? "";
  }

  #cdpValue(value) {
    if (value === null) {
      return { type: "object", subtype: "null", value: null };
    }
    switch (typeof value) {
      case "string":
        return { type: "string", value };
      case "number":
        return { type: "number", value, description: String(value) };
      case "boolean":
        return {
          type: "boolean",
          value,
          description: value ? "true" : "false",
        };
      default:
        return {
          type: "string",
          value: JSON.stringify(value),
          description: JSON.stringify(value),
        };
    }
  }

  async #requestData(params) {
    const origin = this.#storageOrigin(params);
    const databaseName = params.databaseName || "";
    const objectStoreName = params.objectStoreName || "";
    const skipCount = Number(params.skipCount) || 0;
    const pageSize = Number(params.pageSize) || 50;
    const databases = await this.#idbStoreObjects(origin, null);
    const database = (databases?.data || []).find(
      item => (item.db || item.name) === databaseName
    );
    const uniqueKey = database?.uniqueKey || databaseName;
    const response = await this.#idbStoreObjects(
      origin,
      [JSON.stringify([uniqueKey, objectStoreName])],
      {
        offset: skipCount,
        size: pageSize,
        index: params.indexName || undefined,
      }
    );
    const objectStoreDataEntries = [];
    for (const item of response?.data || []) {
      let parsed;
      const raw = await this.#longStringValue(item.value);
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      let key = item.name;
      try {
        key = JSON.parse(item.name);
      } catch {}
      objectStoreDataEntries.push({
        key: this.#cdpValue(key),
        primaryKey: this.#cdpValue(key),
        value: this.#cdpValue(parsed ?? raw),
      });
    }
    return {
      objectStoreDataEntries,
      hasMore:
        objectStoreDataEntries.length >= pageSize ||
        Number(response?.total || 0) > skipCount + objectStoreDataEntries.length,
    };
  }

  async #deleteDatabase(params) {
    const origin = this.#storageOrigin(params);
    const front = await this.#getIndexedDBFront();
    if (front?.removeDatabase) {
      await front.removeDatabase(origin, params.databaseName || "");
    }
    return {};
  }

  async #clearObjectStore(params) {
    const origin = this.#storageOrigin(params);
    const front = await this.#getIndexedDBFront();
    if (front?.removeAll) {
      const databases = await this.#idbStoreObjects(origin, null);
      const database = (databases?.data || []).find(
        item => (item.db || item.name) === params.databaseName
      );
      await front.removeAll(
        origin,
        JSON.stringify([
          database?.uniqueKey || params.databaseName || "",
          params.objectStoreName || "",
        ])
      );
    }
    return {};
  }

  async #deleteObjectStoreEntries(params) {
    const origin = this.#storageOrigin(params);
    const front = await this.#getIndexedDBFront();
    const range = params.keyRange || {};
    if (front?.removeItem && typeof range.lower === "string") {
      await front.removeItem(
        origin,
        JSON.stringify([
          params.databaseName || "",
          params.objectStoreName || "",
          range.lower,
        ])
      );
    }
    return {};
  }

  async #disableServiceWorker() {
    const rootFront = this.#serviceWorkerRootFront;
    if (rootFront && this.#serviceWorkerOnListChanged) {
      rootFront.off?.(
        "serviceWorkerRegistrationListChanged",
        this.#serviceWorkerOnListChanged
      );
    }
    this.#serviceWorkerRegistrationFronts.clear();
    this.#serviceWorkerRootFront = null;
    this.#serviceWorkerOnListChanged = null;
    return {};
  }

  async #refreshServiceWorkerState() {
    const rootFront = this.#commands.targetCommand.rootFront;
    this.#serviceWorkerRootFront = rootFront;
    const response = await rootFront.listServiceWorkerRegistrations();
    const registrations = [];
    const versions = [];
    const activeFronts = new Set();
    for (const registration of response?.registrations || []) {
      const scopeURL = registration.scope || registration.url || "";
      const registrationId = scopeURL;
      activeFronts.add(registration);
      registrations.push({
        registrationId,
        scopeURL,
        isDeleted: false,
      });
      for (const [versionId, worker] of [
        ["installing", registration.installingWorker],
        ["waiting", registration.waitingWorker],
        ["active", registration.activeWorker],
      ]) {
        if (!worker) {
          continue;
        }
        versions.push({
          versionId: `${registrationId}#${versionId}`,
          registrationId,
          scriptURL: worker.url || registration.url || "",
          runningStatus: "running",
          status:
            versionId === "active"
              ? "activated"
              : versionId === "waiting"
                ? "installed"
                : "installing",
          scriptLastModified: 0,
          scriptResponseTime: 0,
          controlledClients: [],
        });
      }
    }
    for (const previous of this.#serviceWorkerRegistrationFronts) {
      if (activeFronts.has(previous)) {
        continue;
      }
      const scopeURL = previous.scope || previous.url || "";
      registrations.push({
        registrationId: scopeURL,
        scopeURL,
        isDeleted: true,
      });
    }
    this.#serviceWorkerRegistrationFronts = activeFronts;
    this.#sendEvent("ServiceWorker.workerRegistrationUpdated", {
      registrations,
    });
    if (versions.length) {
      this.#sendEvent("ServiceWorker.workerVersionUpdated", { versions });
    }
  }

  async #enableServiceWorker() {
    try {
      const rootFront = this.#commands.targetCommand.rootFront;
      if (this.#serviceWorkerOnListChanged) {
        rootFront.off?.(
          "serviceWorkerRegistrationListChanged",
          this.#serviceWorkerOnListChanged
        );
      }
      this.#serviceWorkerOnListChanged = () => {
        this.#refreshServiceWorkerState().catch(e =>
          log("service worker refresh failed", e?.message || e)
        );
      };
      rootFront.on(
        "serviceWorkerRegistrationListChanged",
        this.#serviceWorkerOnListChanged
      );
      await this.#refreshServiceWorkerState();
    } catch (e) {
      log("service worker listing failed", e?.message || e);
    }
    return {};
  }

  async #enableCache() {
    if (this.#cacheStarted) {
      return;
    }
    this.#cacheStarted = true;
    this.#cacheOnAvailable = resources => {
      for (const resource of resources) {
        if (resource?.resourceKey === "Cache") {
          this.#cacheFront = resource;
        }
      }
    };
    await this.#commands.resourceCommand.watchResources(
      [ResourceCommand.TYPES.CACHE_STORAGE],
      { onAvailable: this.#cacheOnAvailable }
    );
  }

  async #disableCache() {
    if (!this.#cacheStarted) {
      return;
    }
    this.#cacheStarted = false;
    if (this.#cacheOnAvailable) {
      await this.#commands.resourceCommand.unwatchResources(
        [ResourceCommand.TYPES.CACHE_STORAGE],
        { onAvailable: this.#cacheOnAvailable }
      );
    }
    this.#cacheFront = null;
    this.#cacheById.clear();
  }

  async #getCacheFront() {
    if (this.#cacheFront) {
      return this.#cacheFront;
    }
    try {
      this.#cacheFront =
        await this.#commands.targetCommand.targetFront.getFront("Cache");
    } catch {
      this.#cacheFront = null;
    }
    return this.#cacheFront;
  }

  async #cacheHost(origin) {
    const front = await this.#getCacheFront();
    const hosts = front?.hosts || {};
    if (Array.isArray(hosts)) {
      return origin;
    }
    return (
      Object.keys(hosts).find(
        host => this.#storageOrigin({ storageKey: host }) === origin
      ) || origin
    );
  }

  async #cacheNames(origin) {
    const front = await this.#getCacheFront();
    const host = await this.#cacheHost(origin);
    if (front?.getStoreObjects) {
      try {
        await front.getStoreObjects(host, null, {
          offset: 0,
          size: 1000,
          sessionString: "",
        });
      } catch {}
    }
    const hosts = front?.hosts || {};
    const names = Array.isArray(hosts) ? hosts : hosts[host] || [];
    return (names || [])
      .map(name => {
        try {
          return JSON.parse(name)[0];
        } catch {
          return name;
        }
      })
      .filter(Boolean);
  }

  #cacheKey(origin, name) {
    return `${origin}|${name}`;
  }

  async #requestCacheNames(params) {
    const origin = this.#storageOrigin(params);
    const names = await this.#cacheNames(origin);
    const caches = [];
    for (const cacheName of names) {
      const cacheId = this.#cacheKey(origin, cacheName);
      this.#cacheById.set(cacheId, { origin, cacheName });
      caches.push({
        cacheId,
        cacheName,
        storageKey: origin,
        storageBucket: { storageKey: origin },
      });
    }
    return { caches };
  }

  #cacheInfo(cacheId) {
    return this.#cacheById.get(cacheId) || null;
  }

  async #requestCacheEntries(params) {
    const info = this.#cacheInfo(params.cacheId);
    if (!info) {
      return { cacheDataEntries: [], returnCount: 0 };
    }
    const front = await this.#getCacheFront();
    if (!front?.getStoreObjects) {
      return { cacheDataEntries: [], returnCount: 0 };
    }
    const host = await this.#cacheHost(info.origin);
    const response = await front.getStoreObjects(
      host,
      [JSON.stringify([info.cacheName])],
      {
        offset: Number(params.skipCount) || 0,
        size: Number(params.pageSize) || 1000,
      }
    );
    const cacheDataEntries = (response?.data || []).map(entry => ({
      requestURL: entry.url || "",
      requestMethod: "GET",
      requestHeaders: [],
      responseStatus: Number(entry.status) || 200,
      responseStatusText: entry.status || "",
      responseHeaders: [],
      responseTime: 0,
      responseType: "basic",
    }));
    return {
      cacheDataEntries,
      returnCount: cacheDataEntries.length,
    };
  }

  async #requestCachedResponse(params) {
    const info = this.#cacheInfo(params.cacheId);
    if (!info) {
      return { response: null };
    }
    return {
      response: {
        body: "",
        base64Encoded: false,
        headers: [],
      },
    };
  }

  async #cacheRemoveItem(origin, name) {
    const [cacheName, requestURL] = name;
    const expression = requestURL
      ? `caches.open(${JSON.stringify(cacheName)}).then(cache => cache.delete(${JSON.stringify(requestURL)}))`
      : `caches.delete(${JSON.stringify(cacheName)})`;
    try {
      await this.#commands.scriptCommand.execute(expression, {
        selectedTargetFront: this.#commands.targetCommand.targetFront,
      });
      await new Promise(resolve => this.#window.setTimeout(resolve, 100));
    } catch (e) {
      log("cache remove failed", e?.message || e);
    }
  }

  async #deleteCache(params) {
    const info = this.#cacheInfo(params.cacheId);
    if (info) {
      await this.#cacheRemoveItem(info.origin, [info.cacheName]);
      this.#cacheById.delete(params.cacheId);
      await this.#cacheNames(info.origin);
    }
    return {};
  }

  async #deleteCacheEntry(params) {
    const info = this.#cacheInfo(params.cacheId);
    if (info) {
      await this.#cacheRemoveItem(info.origin, [
        info.cacheName,
        params.requestURL,
      ]);
    }
    return {};
  }

  async #enableAccessibility() {
    if (this.#accessibilityEnabled) {
      return {};
    }
    const targetFront = this.#commands.targetCommand.targetFront;
    const accessibilityFront = await targetFront.getFront("accessibility");
    await accessibilityFront.initialize();
    this.#accessibilityFront = accessibilityFront;
    if (!accessibilityFront.enabled) {
      const rootFront = this.#commands.targetCommand.rootFront;
      const parentFront = await rootFront.getFront("parentaccessibility");
      await parentFront.initialize();
      const enabled = accessibilityFront.once("init");
      await parentFront.enable();
      await enabled;
    }
    this.#accessibilityEnabled = true;
    return {};
  }

  async #getAXTree() {
    if (!this.#accessibilityEnabled) {
      await this.#enableAccessibility();
    }
    const walker = this.#accessibilityFront?.accessibleWalkerFront;
    if (!walker) {
      return { nodes: [] };
    }
    const targetFront = this.#commands.targetCommand.targetFront;
    const inspectorFront = await targetFront.getFront("inspector");
    const rootNode = await inspectorFront.walker.getRootNode();
    const documentAccessible = await walker.getAccessibleFor(rootNode);
    if (!documentAccessible) {
      return { nodes: [] };
    }
    const snapshot = await documentAccessible.snapshot();
    const nodes = [];
    let nextId = 1;

    const build = (item, parentId) => {
      const nodeId = String(nextId++);
      const properties = [];
      for (const state of item.states || []) {
        properties.push({
          name: state,
          value: { type: "booleanOrUndefined", value: true },
        });
      }
      for (const [name, value] of Object.entries(item.attributes || {})) {
        properties.push({
          name,
          value: { type: "string", value: String(value) },
        });
      }
      const node = {
        nodeId,
        ignored: false,
        role: { type: "role", value: item.role || "generic" },
        name: { type: "computedString", value: item.name || "" },
        description: {
          type: "computedString",
          value: item.description || "",
        },
        value: {
          type: "computedString",
          value: item.value == null ? "" : String(item.value),
        },
        properties,
        childIds: [],
      };
      if (parentId) {
        node.parentId = parentId;
      }
      const childIds = [];
      for (const child of item.children || []) {
        childIds.push(build(child, nodeId));
      }
      node.childIds = childIds;
      nodes.push(node);
      return nodeId;
    };

    build(snapshot, null);
    return { nodes };
  }

  async #getRootAXNode() {
    const { nodes } = await this.#getAXTree();
    return { node: nodes[0] || null };
  }

  #getSecurityState() {
    let state = "neutral";
    try {
      const url = new URL(this.#targetUrl);
      if (url.protocol === "https:") {
        state = "secure";
      } else if (url.protocol === "http:") {
        state = "insecure";
      }
    } catch {}
    return { securityState: state, explanations: [] };
  }

  #headersToObject(headers) {
    const result = {};
    for (const header of headers || []) {
      if (header?.name) {
        result[header.name] = header.value ?? "";
      }
    }
    return result;
  }

  #networkType(state) {
    if (state.isNavigationRequest) {
      return "Document";
    }
    switch (state.cause?.type) {
      case "xhr":
        return "XHR";
      case "fetch":
        return "Fetch";
      case "img":
        return "Image";
      case "script":
        return "Script";
      case "stylesheet":
        return "Stylesheet";
      case "subdocument":
        return "Document";
      default:
        return "Other";
    }
  }

  #networkTiming(state) {
    const timings = state.eventTimings || {};
    const send = timings.send || 0;
    const wait = timings.wait || 0;
    const receive = timings.receive || 0;
    return {
      requestTime: 0,
      proxyStart: -1,
      proxyEnd: -1,
      dnsStart: -1,
      dnsEnd: -1,
      connectStart: -1,
      connectEnd: -1,
      sslStart: -1,
      sslEnd: -1,
      workerStart: -1,
      workerReady: -1,
      workerFetchStart: -1,
      workerRespondWithSettled: -1,
      sendStart: 0,
      sendEnd: send,
      pushStart: 0,
      pushEnd: 0,
      receiveHeadersStart: send + wait,
      receiveHeadersEnd: send + wait + receive,
    };
  }

  async #ensureThread() {
    const targetFront = this.#commands.targetCommand.targetFront;
    if (
      this.#threadFront &&
      this.#threadFront.targetFront === targetFront &&
      !this.#threadFront.isDestroyed()
    ) {
      return this.#threadFront;
    }
    if (this.#threadFront) {
      this.#debuggerListenersAttached = false;
      this.#threadFront = null;
    }
    let threadFront = targetFront.threadFront;
    if (!threadFront || threadFront.isDestroyed()) {
      threadFront = await targetFront.getFront("thread");
    }
    this.#threadFront = threadFront;
    if (!this.#debuggerListenersAttached) {
      threadFront.on("paused", packet => this.#onThreadPaused(packet));
      threadFront.on("resumed", () => this.#onThreadResumed());
      threadFront.on("newSource", packet => this.#onThreadNewSource(packet));
      this.#debuggerListenersAttached = true;
    }
    return threadFront;
  }

  #registerSource(form) {
    if (!form?.actor) {
      return;
    }
    this.#sourceByActor.set(form.actor, form.url || "");
    if (!this.#sourceFrontByActor.has(form.actor)) {
      try {
        this.#sourceFrontByActor.set(
          form.actor,
          this.#threadFront.source(form)
        );
      } catch (e) {
        log("failed to create source front", e);
      }
    }
  }

  #scriptParsedParams(form) {
    const startLine = Math.max(0, (form.sourceStartLine || 1) - 1);
    return {
      scriptId: form.actor,
      url: form.url || "",
      startLine,
      startColumn: form.sourceStartColumn || 0,
      endLine: startLine,
      endColumn: 0,
      executionContextId: EXECUTION_CONTEXT_ID,
      hash: String(form.sourceLength || 0),
      sourceMapURL: form.sourceMapURL || "",
      hasSourceURL: !!form.url,
      isModule: false,
      length: form.sourceLength || 0,
    };
  }

  #emitScriptParsed(form) {
    if (!this.#debuggerEnabled || this.#scriptParsedActors.has(form.actor)) {
      return;
    }
    this.#scriptParsedActors.add(form.actor);
    this.#sendEvent("Debugger.scriptParsed", this.#scriptParsedParams(form));
  }

  async #refreshSources() {
    const threadFront = await this.#ensureThread();
    const response = await threadFront.getSources();
    const sources = response?.sources || [];
    for (const form of sources) {
      this.#registerSource(form);
      this.#emitScriptParsed(form);
    }
    return sources;
  }

  async #enableDebugger() {
    const threadFront = await this.#ensureThread();
    try {
      await threadFront.attach({});
    } catch (e) {
      if (e?.error !== "wrongState" && e?.error !== "exited") {
        log("thread attach skipped", e?.error || e?.message || e);
      }
    }
    this.#debuggerEnabled = true;
    this.#scriptParsedActors.clear();
    await this.#refreshSources();
    return { debuggerId: "chill-debugger-1" };
  }

  #disableDebugger() {
    this.#debuggerEnabled = false;
    return {};
  }

  async #getScriptSource(params) {
    await this.#ensureThread();
    let sourceFront = this.#sourceFrontByActor.get(params.scriptId);
    if (!sourceFront) {
      sourceFront = this.#threadFront.source({ actor: params.scriptId });
      this.#sourceFrontByActor.set(params.scriptId, sourceFront);
    }
    const response = await sourceFront.source();
    let source = response?.source;
    if (typeof source !== "string") {
      if (source?.binary) {
        source = atob(source.binary);
      } else {
        source = String(source ?? "");
      }
    }
    return { scriptSource: source };
  }

  async #getPossibleBreakpoints(params) {
    await this.#ensureThread();
    const sourceFront = this.#sourceFrontByActor.get(params.start.scriptId);
    if (!sourceFront) {
      return { locations: [] };
    }
    const query = {
      start: {
        line: params.start.lineNumber + 1,
        column: params.start.columnNumber || 0,
      },
    };
    if (params.end) {
      query.end = {
        line: params.end.lineNumber + 1,
        column: params.end.columnNumber || 0,
      };
    }
    const response =
      await sourceFront.getBreakpointPositionsCompressed(query);
    const positions = response?.positions || response || {};
    const locations = [];
    for (const [line, columns] of Object.entries(positions)) {
      for (const column of columns) {
        locations.push({
          scriptId: params.start.scriptId,
          lineNumber: Number(line) - 1,
          columnNumber: column,
        });
      }
    }
    return { locations };
  }

  #findSourceByUrl(url) {
    for (const [actor, sourceUrl] of this.#sourceByActor) {
      if (sourceUrl === url) {
        return this.#sourceFrontByActor.get(actor);
      }
    }
    return null;
  }

  async #resolveBreakpointColumn(sourceFront, lineNumber, columnNumber) {
    try {
      const response =
        await sourceFront.getBreakpointPositionsCompressed({
          start: { line: lineNumber + 1, column: columnNumber },
          end: { line: lineNumber + 1 },
        });
      const positions = response?.positions || response || {};
      const columns = positions[lineNumber + 1] || [];
      return columns.find(column => column >= columnNumber) ?? columns[0] ?? columnNumber;
    } catch {
      return columnNumber;
    }
  }

  async #setBreakpointByUrl(params) {
    await this.#ensureThread();
    if (!params.url) {
      return { breakpointId: "", locations: [] };
    }
    const columnNumber = params.columnNumber || 0;
    const sourceFront = this.#findSourceByUrl(params.url);
    const resolvedColumn = sourceFront
      ? await this.#resolveBreakpointColumn(
          sourceFront,
          params.lineNumber,
          columnNumber
        )
      : columnNumber;
    const location = {
      sourceUrl: params.url,
      line: params.lineNumber + 1,
      column: resolvedColumn,
    };
    const breakpointId = `chill-bp-${this.#nextBreakpointId++}`;
    this.#breakpointByCdpId.set(breakpointId, location);
    await this.#threadFront.setBreakpoint(location, {
      condition: params.condition || null,
      logValue: null,
      showStacktrace: false,
    });

    const locations = [];
    if (sourceFront) {
      locations.push({
        scriptId: sourceFront.actor,
        lineNumber: params.lineNumber,
        columnNumber: resolvedColumn,
      });
    }
    return { breakpointId, locations };
  }

  async #setBreakpoint(params) {
    await this.#ensureThread();
    const requested = params.location || {};
    const sourceFront = this.#sourceFrontByActor.get(requested.scriptId);
    const requestedColumn = requested.columnNumber || 0;
    const resolvedColumn = sourceFront
      ? await this.#resolveBreakpointColumn(
          sourceFront,
          requested.lineNumber,
          requestedColumn
        )
      : requestedColumn;
    const location = {
      sourceId: requested.scriptId,
      line: requested.lineNumber + 1,
      column: resolvedColumn,
    };
    const breakpointId = `chill-bp-${this.#nextBreakpointId++}`;
    this.#breakpointByCdpId.set(breakpointId, location);
    await this.#threadFront.setBreakpoint(location, {
      condition: params.condition || null,
      logValue: null,
      showStacktrace: false,
    });
    return {
      breakpointId,
      actualLocation: {
        scriptId: requested.scriptId,
        lineNumber: requested.lineNumber,
        columnNumber: resolvedColumn,
      },
    };
  }

  async #removeBreakpoint(params) {
    await this.#ensureThread();
    const location = this.#breakpointByCdpId.get(params.breakpointId);
    if (location) {
      await this.#threadFront.removeBreakpoint(location);
      this.#breakpointByCdpId.delete(params.breakpointId);
    }
    return {};
  }

  async #setSkipAllPauses(params) {
    await this.#commands.threadConfigurationCommand.updateConfiguration({
      skipBreakpoints: !!params.skip,
    });
    return {};
  }

  async #setBreakpointsActive(params) {
    await this.#commands.threadConfigurationCommand.updateConfiguration({
      skipBreakpoints: params.active === false,
    });
    return {};
  }

  async #setBlackboxPatterns(params) {
    await this.#ensureThread();
    const patterns = (params.patterns || [])
      .map(pattern => {
        try {
          return new RegExp(pattern);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const watcherFront = this.#commands.targetCommand.watcherFront;
    let blackboxingFront = null;
    try {
      blackboxingFront = await watcherFront.getBlackboxingActor();
    } catch {}
    const matched = new Set();
    for (const url of this.#sourceByActor.values()) {
      if (!url || !patterns.some(pattern => pattern.test(url))) {
        continue;
      }
      matched.add(url);
      if (!this.#blackboxedUrls.has(url)) {
        try {
          await blackboxingFront?.blackbox(url, []);
          this.#blackboxedUrls.add(url);
        } catch (e) {
          log("blackbox failed", e?.message || e);
        }
      }
    }
    for (const url of this.#blackboxedUrls) {
      if (matched.has(url)) {
        continue;
      }
      try {
        await blackboxingFront?.unblackbox(url, []);
      } catch (e) {
        log("unblackbox failed", e?.message || e);
      }
      this.#blackboxedUrls.delete(url);
    }
    return {};
  }

  async #setPauseOnExceptions(params) {
    await this.#ensureThread();
    const state = params.state || "none";
    await this.#commands.threadConfigurationCommand.updateConfiguration({
      pauseOnExceptions: state !== "none",
      ignoreCaughtExceptions: state === "uncaught",
    });
    return {};
  }

  async #pauseDebugger() {
    await this.#ensureThread();
    await this.#threadFront.interrupt();
    return {};
  }

  async #resumeDebugger() {
    await this.#ensureThread();
    this.#topFrameActorId = null;
    await this.#threadFront.resume();
    return {};
  }

  async #stepDebugger(kind) {
    await this.#ensureThread();
    const frameActorId = this.#topFrameActorId || undefined;
    if (kind === "over") {
      await this.#threadFront.stepOver(frameActorId);
    } else if (kind === "into") {
      await this.#threadFront.stepIn(frameActorId);
    } else {
      await this.#threadFront.stepOut(frameActorId);
    }
    return {};
  }

  async #evaluateOnCallFrame(params) {
    const response = await this.#commands.scriptCommand.execute(
      params.expression || "",
      {
        frameActor: params.callFrameId,
        selectedTargetFront: this.#commands.targetCommand.targetFront,
        disableBreaks: true,
      }
    );
    if (response.exception) {
      const exception = this.#remoteObject(response.exception);
      return {
        result: exception,
        exceptionDetails: {
          text: response.exceptionMessage || "Evaluation exception",
          exception,
        },
      };
    }
    return { result: this.#remoteObject(response.result) };
  }

  #pauseReason(why) {
    switch (why?.type) {
      case "breakpoint":
      case "eventBreakpoint":
        return "breakpoint";
      case "exception":
      case "promiseRejection":
        return "exception";
      case "interrupted":
      case "alreadyPaused":
        return "debugCommand";
      default:
        return "other";
    }
  }

  #callFrame(frame) {
    if (!frame?.where?.actor) {
      return null;
    }
    const location = {
      scriptId: frame.where.actor,
      lineNumber: Math.max(0, (frame.where.line || 1) - 1),
      columnNumber: frame.where.column || 0,
    };
    return {
      callFrameId: frame.actorID || frame.actor,
      functionName: frame.displayName || "",
      functionLocation: location,
      location,
      url: this.#sourceByActor.get(frame.where.actor) || "",
      scopeChain: [],
      this: this.#remoteObject(frame.this),
    };
  }

  async #onThreadPaused(packet) {
    if (!this.#debuggerEnabled) {
      return;
    }
    let frames = [];
    try {
      const response = await this.#threadFront.getFrames(0, 100);
      frames = response?.frames || [];
    } catch (e) {
      log("failed to read paused frames", e);
    }
    if (!frames.length && packet?.frame) {
      frames = [packet.frame];
    }
    const callFrames = frames.map(frame => this.#callFrame(frame)).filter(Boolean);
    this.#topFrameActorId = callFrames[0]?.callFrameId || null;
    this.#scopeObjects.clear();
    for (let i = 0; i < frames.length && i < callFrames.length; i++) {
      try {
        const environment = await frames[i].getEnvironment();
        callFrames[i].scopeChain = this.#buildScopeChain(
          environment,
          i === 0 ? frames[i].this : undefined
        );
      } catch (e) {
        log("failed to read frame environment", e?.message || e);
        callFrames[i].scopeChain = [];
      }
    }
    this.#sendEvent("Debugger.paused", {
      callFrames,
      reason: this.#pauseReason(packet?.why),
    });
  }

  #equivalentNode(node) {
    const actor = node.actorID || node.actor;
    const nodeId = this.#nodeIdByActor.get(actor);
    return nodeId ? this.#nodeFrontById.get(nodeId) || null : null;
  }

  #buildScopeChain(environment, thisValue) {
    const scopes = [];
    let current = environment;
    let isFirst = true;
    while (current) {
      const objectId = `chill-scope-${current.actor}`;
      const scopeData = { ...current };
      if (isFirst && thisValue !== undefined) {
        scopeData.thisValue = thisValue;
      }
      this.#scopeObjects.set(objectId, scopeData);
      const type =
        current.type === "function"
          ? "local"
          : current.type === "block"
            ? "block"
            : current.type === "object" || current.type === "with"
              ? "with"
              : current.type === "global"
                ? "global"
                : "closure";
      scopes.push({
        type,
        object: {
          type: "object",
          className: "Object",
          description: "Object",
          objectId,
        },
        ...(isFirst && thisValue !== undefined
          ? { name: "this" }
          : {}),
      });
      isFirst = false;
      current = current.parent;
    }
    return scopes;
  }

  #scopeProperties(scope) {
    const result = [];
    const add = (name, descriptor) => {
      if (!descriptor) {
        return;
      }
      const property = {
        name,
        configurable: !!descriptor.configurable,
        enumerable: !!descriptor.enumerable,
        isOwn: true,
      };
      if (descriptor.value !== undefined) {
        property.value = this.#remoteObject(descriptor.value);
        property.writable = !!descriptor.writable;
      }
      if (descriptor.get) {
        property.get = this.#remoteObject(descriptor.get);
      }
      if (descriptor.set) {
        property.set = this.#remoteObject(descriptor.set);
      }
      result.push(property);
    };
    for (const argument of scope.bindings?.arguments || []) {
      for (const [name, descriptor] of Object.entries(argument)) {
        add(name, descriptor);
      }
    }
    for (const [name, descriptor] of Object.entries(
      scope.bindings?.variables || {}
    )) {
      add(name, descriptor);
    }
    if (scope.thisValue !== undefined) {
      result.push({
        name: "this",
        configurable: false,
        enumerable: false,
        isOwn: true,
        value: this.#remoteObject(scope.thisValue),
      });
    }
    return { result, internalProperties: [] };
  }

  #onThreadResumed() {
    if (!this.#debuggerEnabled) {
      return;
    }
    this.#topFrameActorId = null;
    this.#scopeObjects.clear();
    this.#sendEvent("Debugger.resumed");
  }

  #onThreadNewSource(packet) {
    const form = packet?.source;
    if (!form?.actor) {
      return;
    }
    this.#registerSource(form);
    this.#emitScriptParsed(form);
  }

  #scheduleSourceRefresh() {
    if (!this.#debuggerEnabled) {
      return;
    }
    this.#window.setTimeout(() => {
      this.#refreshSources().catch(e =>
        log("failed to refresh debugger sources", e)
      );
    }, 1000);
  }

  #resetDebuggerSources() {
    this.#sourceByActor.clear();
    this.#sourceFrontByActor.clear();
    this.#scriptParsedActors.clear();
    this.#blackboxedUrls.clear();
    this.#topFrameActorId = null;
  }

  #resetDom() {
    this.#inspectorFront = null;
    this.#domWalker = null;
    this.#pageStyle = null;
    this.#domHighlighter = null;
    this.#nodeIdByActor.clear();
    this.#nodeFrontById.clear();
    this.#domChildrenLoaded.clear();
    this.#nextNodeId = 1;
  }

  async #ensureInspector() {
    if (this.#inspectorFront) {
      return;
    }
    const targetFront = this.#commands.targetCommand.targetFront;
    const inspectorFront = await targetFront.getFront("inspector");
    await inspectorFront.initialize();
    this.#inspectorFront = inspectorFront;
    this.#domWalker = inspectorFront.walker;
    this.#pageStyle = inspectorFront.pageStyle;
  }

  #getNodeId(nodeFront) {
    const actor = nodeFront.actorID || nodeFront.actor;
    let nodeId = this.#nodeIdByActor.get(actor);
    if (nodeId) {
      return nodeId;
    }
    nodeId = this.#nextNodeId++;
    this.#nodeIdByActor.set(actor, nodeId);
    this.#nodeFrontById.set(nodeId, nodeFront);
    return nodeId;
  }

  #getNodeFront(nodeId) {
    const node = this.#nodeFrontById.get(nodeId);
    if (!node) {
      throw new Error(`Unknown nodeId: ${nodeId}`);
    }
    return node;
  }

  #attributesArray(nodeFront) {
    const attributes = [];
    for (const attribute of nodeFront.attributes || []) {
      attributes.push(attribute.name, attribute.value);
    }
    return attributes;
  }

  #localName(nodeFront) {
    const name = nodeFront._form?.localName || nodeFront.nodeName || "";
    return name.startsWith("#") ? "" : name.toLowerCase();
  }

  async #nodeValue(nodeFront) {
    try {
      const value = await nodeFront.getNodeValue();
      return await value.string();
    } catch {
      return "";
    }
  }

  async #buildNode(nodeFront, parentId, depth, maxDepth, budget) {
    if (budget.remaining <= 0) {
      return null;
    }
    budget.remaining--;
    const nodeId = this.#getNodeId(nodeFront);
    const node = {
      nodeId,
      backendNodeId: nodeId,
      nodeType: nodeFront.nodeType,
      nodeName: nodeFront.nodeName,
      localName: this.#localName(nodeFront),
      nodeValue: "",
      childNodeCount: nodeFront.numChildren || 0,
    };
    if (parentId != null) {
      node.parentId = parentId;
    }
    if (nodeFront.nodeType === 9) {
      node.documentURL = this.#targetUrl;
      node.baseURL = this.#targetUrl;
    } else if (nodeFront.nodeType === 1) {
      node.attributes = this.#attributesArray(nodeFront);
    } else if ([3, 4, 8].includes(nodeFront.nodeType)) {
      node.nodeValue = await this.#nodeValue(nodeFront);
    } else if (nodeFront.nodeType === 10) {
      node.publicId = nodeFront.publicId || "";
      node.systemId = nodeFront.systemId || "";
    }

    if (
      nodeFront.numChildren > 0 &&
      depth < maxDepth &&
      budget.remaining > 0
    ) {
      const { nodes } = await this.#domWalker.children(nodeFront, {
        maxNodes: 500,
      });
      node.children = [];
      for (const child of nodes) {
        const childNode = await this.#buildNode(
          child,
          nodeId,
          depth + 1,
          maxDepth,
          budget
        );
        if (!childNode) {
          break;
        }
        node.children.push(childNode);
      }
      node.childNodeCount = nodes.length;
      this.#domChildrenLoaded.add(nodeId);
    }
    return node;
  }

  async #setInspectMode(params) {
    await this.#ensureInspector();
    if (params.mode === "none") {
      this.#domWalker.cancelPick();
      return {};
    }
    if (!this.#pickerAttached) {
      this.#pickerAttached = true;
      this.#domWalker.on("picker-node-hovered", ({ node }) => {
        const equivalent = this.#equivalentNode(node) || node;
        this.#showNodeHighlight(equivalent).catch(e =>
          log("picker highlight failed", e?.message || e)
        );
        this.#sendEvent("Overlay.nodeHighlightRequested", {
          nodeId: this.#getNodeId(equivalent),
        });
      });
      this.#domWalker.on("picker-node-picked", ({ node }) => {
        const equivalent = this.#equivalentNode(node) || node;
        this.#hideNodeHighlight().catch(() => {});
        this.#sendEvent("Overlay.inspectNodeRequested", {
          backendNodeId: this.#getNodeId(equivalent),
        });
      });
      this.#domWalker.on("picker-node-canceled", () => {
        this.#hideNodeHighlight().catch(() => {});
        this.#sendEvent("Overlay.inspectModeCanceled");
      });
    }
    this.#domWalker.pick(false, true);
    return {};
  }

  inspectNode(contentDomReference) {
    this.#pendingInspectNode = contentDomReference;
    this.#maybeSendInspectNode();
  }

  async #maybeSendInspectNode() {
    if (!this.#pendingInspectNode || !this.#domReady) {
      return;
    }
    const contentDomReference = this.#pendingInspectNode;
    this.#pendingInspectNode = null;
    try {
      await this.#ensureInspector();
      const nodeFront =
        await this.#inspectorFront.getNodeActorFromContentDomReference(
          contentDomReference
        );
      if (!nodeFront) {
        return;
      }
      const nodeId = this.#getNodeId(nodeFront);
      this.#sendEvent("Overlay.inspectNodeRequested", {
        backendNodeId: nodeId,
      });
    } catch (e) {
      log("failed to select inspected node", e?.message || e);
    }
  }

  async #getDocument(params) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#ensureInspector();
        const root = await this.#domWalker.getRootNode();
        const depth = Number.isFinite(params.depth) ? params.depth : -1;
        const maxDepth = depth < 0 ? 100 : depth;
        const budget = { remaining: 3000 };
        return {
          root: await this.#buildNode(root, null, 0, maxDepth, budget),
        };
      } catch (e) {
        lastError = e;
        log("DOM.getDocument retry", attempt + 1, e?.message || e);
        this.#resetDom();
        await new Promise(resolve =>
          this.#window.setTimeout(resolve, 200)
        );
      }
    }
    throw lastError;
  }

  async #requestChildNodes(params) {
    await this.#ensureInspector();
    if (this.#domChildrenLoaded.has(params.nodeId)) {
      return {};
    }
    const parent = this.#getNodeFront(params.nodeId);
    const depth = Number.isFinite(params.depth) ? params.depth : 0;
    const maxDepth = depth < 0 ? 100 : depth;
    const budget = { remaining: 3000 };
    const { nodes } = await this.#domWalker.children(parent, {
      maxNodes: 500,
    });
    const children = [];
    for (const node of nodes) {
      const childNode = await this.#buildNode(
        node,
        params.nodeId,
        0,
        maxDepth,
        budget
      );
      if (!childNode) {
        break;
      }
      children.push(childNode);
    }
    this.#domChildrenLoaded.add(params.nodeId);
    this.#sendEvent("DOM.setChildNodes", {
      parentId: params.nodeId,
      nodes: children,
    });
    return {};
  }

  async #querySelector(params) {
    await this.#ensureInspector();
    const parent = this.#getNodeFront(params.nodeId);
    const node = await this.#domWalker.querySelector(
      parent,
      params.selector
    );
    return { nodeId: node ? this.#getNodeId(node) : 0 };
  }

  async #querySelectorAll(params) {
    await this.#ensureInspector();
    const parent = this.#getNodeFront(params.nodeId);
    const result = await this.#domWalker.querySelectorAll(
      parent,
      params.selector
    );
    const nodes = result?.list || result || [];
    return { nodeIds: nodes.map(node => this.#getNodeId(node)) };
  }

  async #scrollIntoView(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    await node?.scrollIntoView?.();
    return {};
  }

  async #setAttributeValue(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    if (!node) {
      return {};
    }
    await node.modifyAttributes([
      {
        attributeName: params.name,
        attributeNamespace: params.nameSpace || undefined,
        newValue: params.value,
      },
    ]);
    const attributes = node.attributes || [];
    const attribute = attributes.find(
      item => item.name === params.name && item.namespace === params.nameSpace
    );
    if (attribute) {
      attribute.value = params.value;
    } else {
      attributes.push({
        name: params.name,
        namespace: params.nameSpace || undefined,
        value: params.value,
      });
    }
    this.#sendEvent("DOM.attributeModified", {
      nodeId: params.nodeId,
      name: params.name,
      value: params.value,
    });
    return {};
  }

  async #removeAttribute(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    if (!node) {
      return {};
    }
    await node.modifyAttributes([
      {
        attributeName: params.name,
        attributeNamespace: params.nameSpace || undefined,
        newValue: null,
      },
    ]);
    const attributes = node.attributes || [];
    const index = attributes.findIndex(
      item => item.name === params.name && item.namespace === params.nameSpace
    );
    if (index >= 0) {
      attributes.splice(index, 1);
    }
    this.#sendEvent("DOM.attributeRemoved", {
      nodeId: params.nodeId,
      name: params.name,
    });
    return {};
  }

  async #setNodeValue(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    await node?.setNodeValue?.(params.value);
    return {};
  }

  async #getNodeAttributes(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    return { attributes: this.#attributesArray(node) };
  }

  async #describeNode(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    return {
      node: await this.#buildNode(node, null, 0, 0, { remaining: 1 }),
    };
  }

  async #getBoxModel(params, contentQuadsOnly = false) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    const layout = await this.#pageStyle.getLayout(node, {
      autoMargins: true,
    });
    const width = parseFloat(layout.width) || 0;
    const height = parseFloat(layout.height) || 0;
    const marginTop = parseFloat(layout["margin-top"]) || 0;
    const marginLeft = parseFloat(layout["margin-left"]) || 0;
    const borderTop = parseFloat(layout["border-top-width"]) || 0;
    const borderLeft = parseFloat(layout["border-left-width"]) || 0;
    const paddingTop = parseFloat(layout["padding-top"]) || 0;
    const paddingLeft = parseFloat(layout["padding-left"]) || 0;
    const x = (parseFloat(layout.left) || 0) + marginLeft + borderLeft + paddingLeft;
    const y = (parseFloat(layout.top) || 0) + marginTop + borderTop + paddingTop;
    const content = [x, y, x + width, y, x + width, y + height, x, y + height];
    if (contentQuadsOnly) {
      return { quads: [content] };
    }
    return {
      model: {
        content,
        padding: content,
        border: content,
        margin: content,
        width: Math.round(width),
        height: Math.round(height),
      },
    };
  }

  async #showNodeHighlight(node) {
    await this.#ensureInspector();
    if (!this.#domHighlighter) {
      this.#domHighlighter =
        await this.#inspectorFront.getOrCreateHighlighterByType(
          "BoxModelHighlighter"
        );
    }
    await this.#domHighlighter.show(node);
  }

  async #hideNodeHighlight() {
    if (this.#domHighlighter) {
      await this.#domHighlighter.hide();
    }
  }

  async #highlightNode(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    await this.#showNodeHighlight(node);
    return {};
  }

  async #hideHighlight() {
    await this.#hideNodeHighlight();
    return {};
  }

  #cssStyle(rule) {
    const declarations = rule.declarations || [];
    return {
      cssProperties: declarations.map(declaration => ({
        name: declaration.name,
        value: declaration.value,
        important: declaration.priority === "important",
        implicit: false,
        text: `${declaration.name}: ${declaration.value};`,
        parsedOk: declaration.isValid !== false,
        disabled: false,
      })),
      shorthandEntries: [],
      cssText: rule.cssText || rule.authoredText || "",
    };
  }

  #cssRule(rule, node = null) {
    const selectors = rule.selectors || [];
    const styleSheetId =
      rule.actorID || `chill-rule-${this.#nextStyleSheetId++}`;
    this.#cssRuleBySheetId.set(styleSheetId, rule);
    this.#cssRuleNodeBySheetId.set(styleSheetId, node);
    this.#maybeSendStyleSheetHeader(rule, styleSheetId);
    return {
      styleSheetId,
      selectorList: {
        selectors: selectors.map(text => ({ text })),
        text: selectors.join(", "),
      },
      origin: "regular",
      style: this.#cssStyle(rule),
    };
  }

  #maybeSendStyleSheetHeader(rule, styleSheetId) {
    if (this.#sentStyleSheetHeaders.has(styleSheetId)) {
      return;
    }
    this.#sentStyleSheetHeaders.add(styleSheetId);
    const href = rule.href || rule.parentStyleSheet?.href || "";
    this.#sendEvent("CSS.styleSheetAdded", {
      header: {
        styleSheetId,
        frameId: FRAME_ID,
        sourceURL: href,
        origin: "regular",
        title: href,
        disabled: false,
        isInline: !href || !!rule.parentStyleSheet?.isInline,
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
        sourceMapURL: "",
        length: 0,
        ownerNode: 0,
      },
    });
  }

  async #setPropertyText(params) {
    const rule = this.#cssRuleBySheetId.get(params.styleSheetId);
    if (!rule?.modifyProperties) {
      return {};
    }
    const text = String(params.text || "").trim().replace(/;$/, "");
    const colon = text.indexOf(":");
    if (colon < 0) {
      return {};
    }
    const name = text.slice(0, colon).trim();
    let value = text.slice(colon + 1).trim();
    let priority = "";
    if (/\s*!important\s*$/i.test(value)) {
      value = value.replace(/\s*!important\s*$/i, "").trim();
      priority = "important";
    }
    const index = (rule.declarations || []).findIndex(
      declaration => declaration.name === name
    );
    await rule.modifyProperties([
      { type: "set", index, name, value, priority },
    ]);
    return {};
  }

  async #setRuleSelector(params) {
    const rule = this.#cssRuleBySheetId.get(params.styleSheetId);
    if (!rule?.modifySelector) {
      return {};
    }
    let node = this.#cssRuleNodeBySheetId.get(params.styleSheetId);
    if (!node) {
      node = rule.element;
    }
    if (!node && rule._form?.element) {
      node = this.#commands.client.getFrontByID(rule._form.element);
    }
    if (!node) {
      return {};
    }
    try {
      await rule.modifySelector(node, params.selector || "");
    } catch (e) {
      log("modifySelector failed", e?.message || e);
    }
    return {};
  }

  async #forcePseudoState(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    if (!node) {
      return {};
    }
    await this.#domWalker.clearPseudoClassLocks(node);
    for (const pseudoClass of params.forcedPseudoClasses || []) {
      await this.#domWalker.addPseudoClassLock(node, `:${pseudoClass}`, {
        parents: true,
      });
    }
    return {};
  }

  async #getMatchedStyles(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    const entries = await this.#pageStyle.getApplied(node, {
      inherited: true,
      matchedSelectors: true,
    });
    const matchedCSSRules = [];
    const inherited = [];
    let inlineStyle = null;
    for (const entry of entries) {
      const rule = entry.rule;
      if (entry.inherited) {
        const inheritedEntry = {
          matchedCSSRules: [],
          inlineStyle: null,
          pseudoElements: [],
        };
        if (rule.type === 100) {
          inheritedEntry.inlineStyle = this.#cssStyle(rule);
        } else {
          inheritedEntry.matchedCSSRules.push({
            rule: this.#cssRule(rule, node),
            matchingSelectors: entry.matchedSelectorIndexes || [],
          });
        }
        inherited.push(inheritedEntry);
        continue;
      }
      if (rule.type === 100) {
        inlineStyle = this.#cssStyle(rule);
        continue;
      }
      matchedCSSRules.push({
        rule: this.#cssRule(rule, node),
        matchingSelectors: entry.matchedSelectorIndexes || [],
      });
    }
    return {
      matchedCSSRules,
      inherited,
      inlineStyle,
      attributesStyle: null,
      pseudoElements: [],
    };
  }

  async #getInlineStyles(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    const entries = await this.#pageStyle.getApplied(node, {
      inherited: false,
      matchedSelectors: true,
    });
    const inline = entries.find(entry => entry.rule.type === 100);
    return {
      inlineStyle: inline ? this.#cssStyle(inline.rule) : null,
      attributesStyle: null,
    };
  }

  #styleSheetResourceId(rule) {
    return rule?.parentStyleSheet?.resourceId || rule?._form?.parentStyleSheet;
  }

  async #getStyleSheetText(params) {
    const rule = this.#cssRuleBySheetId.get(params.styleSheetId);
    const resourceId = this.#styleSheetResourceId(rule);
    if (!resourceId) {
      return { text: "" };
    }
    const styleSheetsFront =
      await this.#commands.targetCommand.targetFront.getFront("stylesheets");
    const source = await styleSheetsFront.getText(resourceId);
    const text =
      typeof source?.string === "function"
        ? await source.string()
        : String(source ?? "");
    return { text };
  }

  async #setStyleSheetText(params) {
    const rule = this.#cssRuleBySheetId.get(params.styleSheetId);
    const resourceId = this.#styleSheetResourceId(rule);
    if (!resourceId) {
      return {};
    }
    const styleSheetsFront =
      await this.#commands.targetCommand.targetFront.getFront("stylesheets");
    await styleSheetsFront.update(
      resourceId,
      params.text || "",
      false,
      "chill-devtools"
    );
    return {};
  }

  #getLayoutDebug() {
    const stack = this.#deviceStack();
    const container = stack.parentElement;
    const rect = element => {
      if (!element) {
        return null;
      }
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    };
    const style = this.#window.getComputedStyle(container);
    return {
      deviceMode: !!this.#deviceMode,
      modeClass: container.classList.contains("chill-device-mode"),
      container: rect(container),
      stack: rect(stack),
      browser: rect(this.#tab.linkedBrowser),
      frame: rect(this.#frontendFrame),
      splitter: rect(this.#frontendSplitter),
      display: style.display,
      gridColumns: style.gridTemplateColumns,
      gridRows: style.gridTemplateRows,
      stackWidth: this.#window.getComputedStyle(stack).width,
      stackMinWidth: this.#window.getComputedStyle(stack).minWidth,
    };
  }

  async #getComputedStyle(params) {
    await this.#ensureInspector();
    const node = this.#getNodeFront(params.nodeId);
    const computed = await this.#pageStyle.getComputed(node, {
      markMatched: false,
      onlyMatched: false,
    });
    const computedStyle = Object.entries(computed || {}).map(
      ([name, entry]) => ({
        name,
        value: entry?.value ?? entry,
      })
    );
    return { computedStyle };
  }

  #resetRuntime() {
    if (this.#consoleFront && this.#consoleOnAPICall) {
      this.#consoleFront.off?.("consoleAPICall", this.#consoleOnAPICall);
    }
    this.#consoleStarted = false;
    this.#consoleFront = null;
    this.#consoleOnAPICall = null;
    this.#accessibilityFront = null;
    this.#accessibilityEnabled = false;
  }

  async #enableRuntime() {
    const targetFront = this.#commands.targetCommand.targetFront;
    const consoleFront = await targetFront.getFront("console");
    await consoleFront.startListeners(["ConsoleAPI", "PageError"]);
    if (this.#consoleFront && this.#consoleOnAPICall) {
      this.#consoleFront.off?.("consoleAPICall", this.#consoleOnAPICall);
    }
    this.#consoleOnAPICall = ({ message }) => {
      this.#sendEvent("Runtime.consoleAPICalled", {
        type: this.#consoleType(message.level),
        args: (message.arguments || []).map(arg => this.#remoteObject(arg)),
        executionContextId: EXECUTION_CONTEXT_ID,
        timestamp: Date.now(),
        stackTrace: { callFrames: [] },
      });
    };
    consoleFront.on("consoleAPICall", this.#consoleOnAPICall);
    this.#consoleFront = consoleFront;
    this.#consoleStarted = true;

    this.#sendEvent("Runtime.executionContextCreated", {
      context: {
        id: EXECUTION_CONTEXT_ID,
        origin: this.#targetUrl,
        name: "Chill Browser",
        auxData: {
          isDefault: true,
          type: "default",
          frameId: FRAME_ID,
        },
      },
    });
  }

  async #getProperties(params) {
    const objectId = params.objectId;
    if (!objectId) {
      return { result: [] };
    }
    const scope = this.#scopeObjects.get(objectId);
    if (scope) {
      return this.#scopeProperties(scope);
    }
    const front = this.#commands.client.getFrontByID(objectId);
    if (!front) {
      throw new Error(`Unknown objectId: ${objectId}`);
    }
    const { ownProperties = {}, safeGetterValues = {}, prototype } =
      await front.getPrototypeAndProperties();
    const result = [];
    const addProperty = (name, descriptor, isOwn) => {
      if (!descriptor) {
        return;
      }
      const property = {
        name,
        configurable: !!descriptor.configurable,
        enumerable: !!descriptor.enumerable,
        isOwn,
      };
      if (descriptor.value !== undefined) {
        property.value = this.#remoteObject(descriptor.value);
        property.writable = !!descriptor.writable;
      }
      if (descriptor.get) {
        property.get = this.#remoteObject(descriptor.get);
      }
      if (descriptor.set) {
        property.set = this.#remoteObject(descriptor.set);
      }
      if (descriptor.getterValue !== undefined) {
        property.value = this.#remoteObject(descriptor.getterValue);
      }
      result.push(property);
    };
    for (const [name, descriptor] of Object.entries(ownProperties)) {
      addProperty(name, descriptor, true);
    }
    for (const [name, descriptor] of Object.entries(safeGetterValues)) {
      addProperty(name, descriptor, false);
    }
    const internalProperties = [];
    if (prototype) {
      internalProperties.push({
        name: "[[Prototype]]",
        value: this.#remoteObject(prototype),
      });
    }
    return { result, internalProperties };
  }

  async #evaluate(params) {
    const expression = params.expression || "";
    const response = await this.#commands.scriptCommand.execute(expression, {});
    if (response.exception) {
      const exception = this.#remoteObject(response.exception);
      return {
        result: exception,
        exceptionDetails: {
          text: response.exceptionMessage || "Evaluation exception",
          exception,
        },
      };
    }
    return { result: this.#remoteObject(response.result) };
  }

  #remoteObject(value) {
    if (value === undefined) {
      return { type: "undefined" };
    }
    if (value === null) {
      return { type: "object", subtype: "null", value: null };
    }
    if (typeof value !== "object") {
      return {
        type: typeof value,
        value,
        description: String(value),
      };
    }
    if (typeof value.getGrip === "function") {
      return this.#remoteObject(value.getGrip());
    }
    if (value.actorID) {
      return {
        type: "object",
        className: value.class || "Object",
        description: value.class || "Object",
        objectId: value.actorID,
      };
    }
    if (value.type === "undefined") {
      return { type: "undefined" };
    }
    if (value.type === "null") {
      return { type: "object", subtype: "null", value: null };
    }
    if (value.type === "longString") {
      return {
        type: "string",
        value: value.initial,
        description: value.initial,
      };
    }
    if (value.type === "object") {
      return {
        type: "object",
        className: value.class || "Object",
        description: value.class || "Object",
        objectId: value.actor,
      };
    }
    return {
      type: typeof value,
      value,
      description: String(value),
    };
  }

  #consoleType(level) {
    switch (level) {
      case "warn":
      case "warning":
        return "warning";
      case "error":
        return "error";
      case "debug":
        return "debug";
      case "info":
        return "info";
      case "dir":
        return "dir";
      case "table":
        return "table";
      case "trace":
        return "trace";
      default:
        return "log";
    }
  }
}

let bridgeInstance = null;

export const ChromeDevToolsBridge = {
  async maybeStart(window) {
    const enabled = Services.prefs.getBoolPref(
      "chill.devtools.chrome.enabled",
      true
    );
    const autostart = Services.prefs.getBoolPref(
      "chill.devtools.chrome.autostart",
      false
    );
    if (started) {
      return;
    }
    if (
      Services.appinfo.processType !== Services.appinfo.PROCESS_TYPE_DEFAULT
    ) {
      return;
    }
    if (!enabled || !autostart) {
      return;
    }
    started = true;
    try {
      bridgeInstance = new Bridge(window);
      await bridgeInstance.start({
        open: Services.prefs.getBoolPref(
          "chill.devtools.chrome.auto-open",
          false
        ),
        panel: Services.prefs.getStringPref(
          "chill.devtools.chrome.panel",
          "elements"
        ),
      });
    } catch (e) {
      started = false;
      bridgeInstance = null;
      console.error("ChromeDevToolsBridge: failed to start", e);
    }
  },

  async open(window, { panel = null, toggle = false, inspectNode = null } = {}) {
    const enabled = Services.prefs.getBoolPref(
      "chill.devtools.chrome.enabled",
      true
    );
    if (
      !enabled ||
      Services.appinfo.processType !== Services.appinfo.PROCESS_TYPE_DEFAULT
    ) {
      return false;
    }
    if (
      started &&
      bridgeInstance &&
      (!bridgeInstance.matchesWindow(window) ||
        !bridgeInstance.matchesTab(window.gBrowser.selectedTab))
    ) {
      await bridgeInstance.close();
      bridgeInstance = null;
      started = false;
    }

    if (!started) {
      started = true;
      try {
        bridgeInstance = new Bridge(window);
        await bridgeInstance.start({ open: false });
      } catch (e) {
        started = false;
        bridgeInstance = null;
        console.error("ChromeDevToolsBridge: failed to start", e);
        return false;
      }
    }
    await bridgeInstance.open({ panel, toggle, inspectNode });
    return true;
  },
};
