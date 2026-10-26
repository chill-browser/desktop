# Matriz de compatibilidade CDP

Atualizado em 2026-10-23. Status reflete os gates G1–G5.

Legenda: ✅ implementado/testado; ◐ parcial; ❌ não suportado (UI oculta
ou método retorna erro explícito).

| Domínio | Métodos/eventos | Status | Observação |
|---|---|---|---|
| Schema | `getDomains` | ✅ | Lista Runtime, Console, Page, Debugger, DOM, CSS, Overlay, Network, Log, Target |
| Runtime | `enable`, `evaluate`, `getProperties`, `releaseObject`, `releaseObjectGroup`, `consoleAPICalled`, `executionContextCreated` | ✅ | Objetos remotos e exceções básicas |
| Runtime | `addBinding`, `runIfWaitingForDebugger` | ❌ | Sem bindings/contextos avançados |
| Console | `enable`, `disable`, `clearMessages` | ◐ | Console real via Runtime/WebConsole |
| Page | `enable`, `getFrameTree`, `getResourceTree`, `getNavigationHistory`, `navigate` | ✅ | Navegação real |
| Page | `reload`, `captureScreenshot`, `getAppManifest`, `getLayoutMetrics`, screencast, lifecycle events | ✅ | Reload, captura, manifesto, métricas e eventos |
| Network | `enable`, `disable`, `requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed`, `getResponseBody`, `getRequestPostData`, `getCookies`, `setCookie`, `deleteCookies` | ✅ | Corpos, POST e cookies |
| Network | WebSocket (`webSocketCreated`, handshake, frames, closed) | ✅ | Eventos reais do `nsIWebSocketEventService` |
| Network | `setBlockedURLs`, throttling | ◐ | Bloqueio real via network parent; offline aproximado |
| Network | cache avançado | ❌ | Sem cache desabilitado real |
| DOM | `enable`, `getDocument`, `requestChildNodes`, `querySelector`, `querySelectorAll`, `getAttributes`, `describeNode`, `getBoxModel`, `getContentQuads` | ✅ | Árvore sob demanda |
| DOM | `setAttributeValue`, `removeAttribute`, `setNodeValue` | ✅ | Edição real de atributos/valor |
| DOM | mutações ao vivo | ❌ | Sem eventos incrementais |
| DOM | `getNodeForLocation`, `resolveNode` | ❌ | Sem inspect por coordenada/resolveNode |
| CSS | `enable`, `getComputedStyleForNode`, `getMatchedStylesForNode`, `getInlineStylesForNode` | ✅ | Estilos reais |
| CSS | edição de propriedades (`setPropertyText`), `getMediaQueries`, fontes, variáveis | ◐ | Propriedades editáveis; seletor/live edit pendentes |
| Overlay | `enable`, `highlightNode`, `hideHighlight` | ✅ | BoxModelHighlighter |
| Overlay | inspect mode | ✅ | NodePicker nativo |
| Overlay | grid/flex/scroll overlays | ❌ | Sem overlays persistentes |
| Debugger | `enable`, `scriptParsed`, `getScriptSource`, `getPossibleBreakpoints`, `setBreakpointByUrl`, `setBreakpoint`, `removeBreakpoint`, `pause`, `resume`, `step*`, `evaluateOnCallFrame`, `paused`, `resumed` | ✅ | Breakpoints simples |
| Debugger | scopeChain/locals | ✅ | Escopos reais via `FrameFront.getEnvironment` |
| Debugger | source maps, blackboxing, pause on exceptions | ✅ | `scriptParsed.sourceMapURL`, blackbox e pausa reais |
| Debugger | pretty print, live edit, setVariableValue | ❌ | Sem edição de código |
| Target | `getTargets`, `getTargetInfo`, `setDiscoverTargets`, `attach/detach`, `activateTarget` | ◐ | Target único da aba |
| Log | `enable`, `disable`, `clear` | ◐ | Sem violações CSP completas |
| DOMStorage | `enable`, `disable`, `getDOMStorageItems`, `setDOMStorageItem`, `removeDOMStorageItem`, `clear` | ✅ | localStorage/sessionStorage reais; `storageKey` e `securityOrigin` |
| Storage | `getStorageKey`, `setStorageBucketTracking`, `getUsageAndQuota`, `clearDataForOrigin`, `clearDataForStorageKey` | ◐ | Uso real via QuotaManager; quota 0; limpa storage/cookies/IDB |
| IndexedDB | `enable`, `requestDatabaseNames`, `requestDatabase`, `requestData`, `clearObjectStore`, `deleteDatabase` | ✅ | Ator IndexedDB real |
| CacheStorage | `requestCacheNames`, `requestEntries`, `deleteCache`, `deleteEntry`, `requestCachedResponse` | ◐ | Listagem/entradas reais; corpo do cache vazio |
| ServiceWorker | `enable`, listagem e remoção | ◐ | Atualização de versões/estado parcial |
| ServiceWorkerCache | `enable`/`disable` | ✅ | Cache storage pelo frontend |
| Accessibility | `enable`, `disable`, `getFullAXTree`, `getRootAXNode`, `getPartialAXTree`, `getAXNodeAndAncestors` | ◐ | Árvore real; sem relations/checks/backendDOMNodeId |
| Security | `enable`, `disable`, `getSecurityState` | ◐ | Estado por esquema (https/secure, http/insecure); sem certificado detalhado |
| Performance/Memory/Security/Accessibility/Coverage | — | ❌ | Entradas ocultas; sem equivalente completo |

## Painéis do frontend

| Painel Chrome | Estado |
|---|---|
| Console | ✅ |
| Network | ✅ |
| Elements | ✅ |
| Sources | ✅ |
| Performance | ❌ oculto |
| Memory | ❌ oculto |
| Application | ◐ exposto; DOMStorage, IndexedDB, CacheStorage, cookies |
| Security | ❌ oculto (backend parcial) |
| Accessibility | ❌ oculto (backend parcial) |
| Coverage | ❌ oculto |

## Testes associados

- `scripts/test_chrome_devtools_cdp.mjs` — Runtime/Console.
- `scripts/test_chrome_devtools_network.mjs` — Network.
- `scripts/test_chrome_devtools_dom.mjs` — DOM/CSS/Overlay.
- `scripts/test_chrome_devtools_debugger.mjs` — Debugger.
- `scripts/test_chrome_devtools_application.mjs` — IndexedDB/CacheStorage.
- `scripts/test_chrome_devtools_page.mjs` — manifesto/screenshot/reload.
- `scripts/test_chrome_devtools_sourcemap.mjs` — source maps.
- `scripts/test_chrome_devtools_emulation.mjs` — device metrics.
- `scripts/test_chrome_devtools_exceptions.mjs` — pause on exceptions.
- `scripts/test_chrome_devtools_serviceworker.mjs` — Service Worker.
- `scripts/test_chrome_devtools_websocket.mjs` — WebSocket.
- `scripts/test_chrome_devtools_network_block.mjs` — bloqueio de URLs.
- `scripts/test_chrome_devtools_emulation_media.mjs` — UA/media/touch.
- `scripts/test_chrome_devtools_dom_navigation.mjs` — estabilidade pós-navegação.
- `scripts/test_chrome_devtools_css_edit.mjs` — edição de CSS.
- `scripts/test_chrome_devtools_dom_edit.mjs` — edição de atributos DOM.
- Evidências visuais em `docs/assets/g0`–`g6`.
