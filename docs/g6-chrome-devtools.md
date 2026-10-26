# G6 — Paridade restante (em andamento)

Data: 2026-10-23

## Objetivo

Aproximar os painéis restantes do Chrome DevTools sem simular dados.
Painéis sem equivalente continuam ocultos; a matriz
`docs/cdp-compatibility.md` é a fonte de verdade.

## Entregue neste incremento

### Network response bodies

`Network.getResponseBody` agora lê o corpo real via
`NetworkEventActor.getResponseContent()` e resolve `LongString` com
`substring`. `Network.getRequestPostData` devolve o corpo POST quando o
Firefox o expõe.

Teste `scripts/test_chrome_devtools_network.mjs`:

```json
{
  "url": "http://127.0.0.1:8081/data.json?after=1",
  "status": 200,
  "body": "{\"ok\":true}\n"
}
```

### Device/Media emulation

- `Emulation.setUserAgentOverride`, `setEmulatedMedia` (color scheme) e
  `setTouchEmulationEnabled` usam `TargetConfigurationCommand`.
- Teste `scripts/test_chrome_devtools_emulation_media.mjs`.

### Network blocking

- `Network.setBlockedURLs` usa o `networkParent` real; requests bloqueados
  aparecem como `loadingFailed`.
- `Network.emulateNetworkConditions` aplica throttling/offline aproximado.
- Teste `scripts/test_chrome_devtools_network_block.mjs`.

### WebSocket

- `Network.webSocketCreated`, handshake, `webSocketFrameSent/Received`
  e `webSocketClosed` vêm do watcher real de WebSocket.
- Teste `scripts/test_chrome_devtools_websocket.mjs` sobe um servidor
  local, envia e recebe frames reais.

### Cookies

- `Network.getCookies`/`Storage.getCookies` leem cookies reais do host.
- `Network.setCookie` e `Network.deleteCookies` criam/removem cookies.
- Teste `scripts/test_chrome_devtools_cookies.mjs` valida o ciclo
  completo com `chill-cookie` e `extra-cookie`.

### DOMStorage/Storage (backend)

- `DOMStorage.enable` observa recursos `local-storage` e
  `session-storage`.
- `DOMStorage.getDOMStorageItems` lê as entradas reais via
  `getStoreObjects()`.
- `DOMStorage.setDOMStorageItem`, `removeDOMStorageItem` e `clear`
  editam localStorage/sessionStorage.
- `Storage.getStorageKey` devolve a origem atual; `getUsageAndQuota`
  consulta o QuotaManager real (quota ainda 0).
- `Storage.setStorageBucketTracking` publica o bucket padrão, necessário
  para os modelos modernos do Application.
- `Storage.clearDataForOrigin`/`clearDataForStorageKey` limpam
  localStorage, sessionStorage, cookies e IndexedDB; a remoção de
  CacheStorage usa a API da página e ainda é assíncrona/instável.
- O frontend envia `storageId.storageKey`; a bridge aceita tanto
  `storageKey` quanto o antigo `securityOrigin`.
- `IndexedDB.enable`, `requestDatabaseNames`, `requestDatabase`,
  `requestData`, `clearObjectStore` e `deleteDatabase` usam o ator
  IndexedDB real; o painel lista banco, object stores, índices e linhas.
- `CacheStorage.requestCacheNames`/`requestEntries` usam o ator Cache.
- `ServiceWorker.enable` lista registros via root front.
- O painel Application agora abre pelo menu Chrome (`storage` mapeia
  para o painel oficial `resources`), não para `application`.
- `ServiceWorker.enable` publica registros/versões e escuta
  `serviceWorkerRegistrationListChanged`; o teste também valida a
  remoção/`isDeleted`.
- Testes: `scripts/test_chrome_devtools_storage.mjs`,
  `scripts/test_chrome_devtools_application.mjs` e
  `scripts/test_chrome_devtools_serviceworker.mjs`.
- Evidências: `docs/assets/g6-application-local-storage.png`,
  `g6-application-indexeddb.png` e `g6-application-manifest.png`.
- Limitação de UI: o sidebar de CacheStorage do frontend oficial só é
  inicializado quando o `ApplicationPanelSidebar.initialize()` roda;
  o backend já responde `CacheStorage.*` e há teste CDP.

### Follow-up: Elements vazio

- `DOM.getDocument` agora tenta novamente após navegação/fechamento do
  walker, recriando inspector e árvore; evita painel Elements vazio.
- Teste `scripts/test_chrome_devtools_dom_navigation.mjs` navega 6 vezes
  e exige árvore não vazia.
- Hover do picker usa `BoxModelHighlighter` direto no backend.
- `DOM.requestChildNodes` não reenvia `DOM.setChildNodes` para nós já
  carregados; evita a árvore reabrir sozinha ao colapsar.
- O servidor do frontend aumenta a largura clicável da setinha legada de
  12px para 20px (altura e ícone continuam 12px), facilitando expandir/colapsar.
- O dock agora tem um botão `×` ao lado do menu de três pontos para fechar
  o DevTools sem fechar a aba; evidência em `docs/assets/g6-close-button.png`.

### DOM editing

- `DOM.setAttributeValue`, `DOM.removeAttribute` e `DOM.setNodeValue`
  editam o DOM real e publicam `DOM.attributeModified/Removed`.
- Teste `scripts/test_chrome_devtools_dom_edit.mjs`.

### CSS editing

- `CSS.setPropertyText` altera propriedades reais via
  `StyleRuleFront.modifyProperties`; teste
  `scripts/test_chrome_devtools_css_edit.mjs` valida a cor computada.
- `CSS.setRuleSelector` ainda não altera o seletor na prática.

### Accessibility

- `Accessibility.enable` inicializa o serviço de acessibilidade pelo
  `parentaccessibility` e aguarda o evento `init`.
- `Accessibility.getFullAXTree`/`getRootAXNode` usam o snapshot real do
  `AccessibleWalker` a partir do nó raiz do DOM.
- Papéis, nomes, descrições, valores, estados e atributos são mapeados
  para `AXNode`.
- Teste `scripts/test_chrome_devtools_accessibility.mjs` encontrou
  `button`/`Chill button`, `heading`/`Accessibility` e 7 nós.

### Security

- `Security.getSecurityState` devolve `secure` para https, `insecure`
  para http e `neutral` para outros esquemas.
- Sem certificado detalhado, HSTS, mixed content ou explicações.

### Element picker

- `Overlay.setInspectMode` arma o `NodePicker` nativo do Firefox via
  `walker.pick()`, com eventos de hover/pick/cancel.
- `Overlay.inspectNodeRequested` é enviado com o nó equivalente da árvore
  DOM (mapeamento por tag/atributos), fazendo o Elements selecionar o
  elemento clicado.
- O item "Inspecionar" do menu de contexto passa o `ContentDOMReference`
  do nó para a bridge.
- O hover do picker agora aciona o `BoxModelHighlighter` diretamente no
  backend, garantindo o overlay visual na página.
- Teste manual: o picker selecionou `p` e o Elements atualizou a
  seleção/breadcrumb; hover em `docs/assets/g6-element-hover.png`.

### Debugger scopes

- `Debugger.paused` agora inclui `scopeChain` real a partir de
  `FrameFront.getEnvironment()`.
- `Runtime.getProperties` resolve os escopos sintéticos e devolve
  variáveis/argumentos/`this`.
- Teste de Debugger encontrou `x === 5` no escopo local e `scopeCount: 4`.
- `Debugger.setPauseOnExceptions`, `setBreakpointsActive`,
  `setSkipAllPauses` e `setBlackboxPatterns` agora alteram o estado real
  do thread actor.
- `Debugger.scriptParsed` publica `sourceMapURL`; o teste
  `scripts/test_chrome_devtools_sourcemap.mjs` valida mapa e
  `sourcesContent`.

### Device Mode / screencast

- `Emulation.setDeviceMetricsOverride` e
  `Emulation.clearDeviceMetricsOverride` redimensionam a página no
  `browserStack`; `innerWidth/innerHeight` passam a refletir o device
  (teste 375×667).
- `Page.reload`, `Page.captureScreenshot`, `Page.getAppManifest`,
  `Page.getLayoutMetrics` e eventos de ciclo de vida
  (`DOMContentLoaded`/`load`) estão ativos.
- `Page.startScreencast`/`stopScreencast` geram frames JPEG via
  `captureScreenshot`.
- O harness serve o entrypoint oficial `devtools_app`
  (`entrypoints/devtools_app/devtools_app.js`) em vez de `inspector.js`;
  esse é o app DevTools normal do Chrome, sem o ScreencastApp de
  inspeção remota e sem UI inventada.
- O Device Toolbar redimensiona a própria página; evidência em
  `docs/assets/g6-device-mode.png`.
- `Page.getAppManifest` usa o ator `manifest` do Firefox e devolve
  `name`, `start_url` e demais campos reais.
- O uso do `devtools_app` no harness precisa ser replicado no build
  empacotado do frontend (ou aplicado ao `inspector.html` vendorizado).

## Correção de textos/localização

Após `surfer import`/reset, os packs `zen-*.ftl` não são copiados
automaticamente para o engine; o chrome fica com textos vazios. Para
corrigir:

```bash
python3 ./scripts/update_en_US_packs.py
npm run build
```

O build completo copia os packs para
`engine/obj-.../dist/bin/browser/localization/en-US/browser/` e o chrome
volta a exibir os textos.

### Segurança local (token/Origin)

- A bridge gera um token UUID por sessão (ou usa
  `chill.devtools.chrome.token` para automação).
- O frontend usa `ws=127.0.0.1:<porta>/<token>`.
- Handshakes com `Origin` de navegador precisam de token e origem
  `127.0.0.1:8080`/`localhost:8080`; clientes locais sem Origin
  (testes Node) continuam aceitos.
- O patch do WebSocket server expõe `validate` no handshake sem alterar
  o comportamento padrão.

## Ainda fora de escopo

- Performance/Profiler e Memory/HeapProfiler: o backend do Firefox usa
  o profiler e o heap profiler, sem mapeamento CDP completo.
- Service Workers: listagem e remoção em tempo real; atualização de
  versão/estado ainda parcial.
- CacheStorage: backend de listagem/entradas/limpeza; corpo do
  `requestCachedResponse` ainda vazio e sidebar pode exigir inicialização
  explícita.
- Security: estado de segurança/certificado no painel Security.
- Accessibility: árvore AX e auditorias.
- Coverage, Layers, Animations, Audits e Performance/Memory.
- Pretty print/live edit e mutações DOM ao vivo.
- `DOM.getNodeForLocation`, mutações DOM ao vivo e edição de seletor.

## Estado dos painéis

| Painel | Estado |
|---|---|
| Console | ✅ |
| Network | ✅ com corpos |
| Elements | ✅ |
| Sources | ✅ |
| Application | ◐ exposto; DOMStorage, IndexedDB e CacheStorage |
| Performance | ❌ oculto |
| Memory | ❌ oculto |
| Security | ❌ oculto (backend parcial) |
| Accessibility | ❌ oculto (backend parcial) |
| Coverage | ❌ oculto |

## Próximos incrementos sugeridos

1. Application: eventos de Service Worker, corpo de CacheStorage e
   `Storage.getUsageAndQuota` detalhado.
2. Accessibility/Security: expor os painéis oficiais quando os modelos
   estiverem completos.
3. Performance/Memory: avaliar gates próprios antes de expor os painéis.
4. Cobertura final: rodar todos os testes e validar build empacotado.
