# Estado atual — handoff

Data: 2026-10-23

## Pronto e validado

- G0–G5 concluídos.
- G6 parcial:
  - Network com corpos (`Network.getResponseBody`, `getRequestPostData`);
  - Cookies (`getCookies`, `setCookie`, `deleteCookies`);
  - DOMStorage/Storage localStorage/sessionStorage;
  - Accessibility (`getFullAXTree`, `getRootAXNode`, `getPartialAXTree`);
  - Security (`getSecurityState`);
  - Application exposto com localStorage/sessionStorage, IndexedDB,
    CacheStorage e cookies;
  - Page `reload`/`captureScreenshot`/`getAppManifest` e ciclo de vida;
  - Debugger `sourceMapURL`, pause-on-exceptions, breakpoints ativos e
    blackboxing.
- Testes verdes na última execução:
  - `scripts/test_chrome_devtools_network.mjs`
  - `scripts/test_chrome_devtools_dom.mjs`
  - `scripts/test_chrome_devtools_debugger.mjs`
  - `scripts/test_chrome_devtools_storage.mjs`
  - `scripts/test_chrome_devtools_cookies.mjs`
  - `scripts/test_chrome_devtools_accessibility.mjs`
  - `scripts/test_chrome_devtools_application.mjs`
  - `scripts/test_chrome_devtools_page.mjs`
  - `scripts/test_chrome_devtools_sourcemap.mjs`
  - `scripts/test_chrome_devtools_emulation.mjs`
  - `scripts/test_chrome_devtools_exceptions.mjs`
  - `scripts/test_chrome_devtools_serviceworker.mjs`
  - `scripts/test_chrome_devtools_css_edit.mjs`
  - `scripts/test_chrome_devtools_websocket.mjs`
  - `scripts/test_chrome_devtools_network_block.mjs`
  - `scripts/test_chrome_devtools_emulation_media.mjs`
  - `scripts/test_chrome_devtools_dom_navigation.mjs`
  - `scripts/test_chrome_devtools_dom_edit.mjs`
- Textos/fontes do chrome corrigidos:
  - `python3 ./scripts/update_en_US_packs.py`
  - `npm run build` completo
  - packs em `engine/obj-.../dist/bin/browser/localization/en-US/browser/`.

## Docked frontend — concluído

- O frontend agora abre dockado no `browserContainer` da aba, com
  splitter e `<browser type="content" remote="true">`, ao lado da página.
- Não abre mais aba separada para o DevTools.
- Carregamento resolvido com `remote="true"` + `docShellIsActive` +
  `src` após anexar o frame.
- `Page.startScreencast`/`stopScreencast` implementados com
  `captureScreenshot`.
- `Page.reload`, `Page.captureScreenshot`, `Page.getAppManifest` e
  eventos `DOMContentLoaded`/`load` implementados.
- Application aberto pelo painel oficial `resources`; IndexedDB lista
  bancos/object stores/índices; CacheStorage lista entradas, mas a
  remoção de cache ainda é assíncrona/instável.
- `Emulation.setDeviceMetricsOverride`/`clearDeviceMetricsOverride`
  implementados: o Device Toolbar redimensiona a própria página
  (375×667 no teste), sem barra de navegação.
- O harness agora serve o entrypoint oficial `devtools_app`
  (`entrypoints/devtools_app/devtools_app.js`) em vez de `inspector.js`;
  isso usa o app DevTools normal, sem o ScreencastApp de inspeção
  remota e sem UI inventada.
- Device Mode redimensiona a página (375×667 no teste) sem barra de
  navegação.
- O toggle F12 fecha/abre o dock.
- `DOM.getDocument` agora usa profundidade `-1` por padrão, pré-carregando
  a árvore; isso evita o duplo clique para expandir tags.
- Observação: a barra de endereço que aparece no "Toggle screencast" é
  parte da UI de screencast do próprio Chrome DevTools, não uma nova aba
  do navegador.

## Validação

- Screenshot: dock com página à esquerda e Elements à direita.
- `Page.startScreencast` testado via CDP: frame JPEG recebido
  (12.5 KB) com metadata.
- `DOM.getDocument` sem `depth` retornou `#target` aninhado.
- Testes anteriores de Network/DOM/Debugger/Storage/Cookies/
  Accessibility continuam aplicáveis.

## Patches/engine

- `src/devtools/client/framework/devtools-browser-js.patch` — guarda
  `toggleMenuItem` quando o item não existe (necessário porque o menu
  Chrome oculta itens).
- `src/devtools/client/framework/browser-menus-js.patch` — menu Chrome.
- `src/devtools/startup/DevToolsStartup-sys-mjs.patch` — atalhos F12.
- `src/browser/base/content/nsContextMenu-sys-mjs.patch` — inspect.
- O engine está com os patches aplicados manualmente e o build completo
  já foi feito. Se resetar o engine, rodar `npm run import` e
  `npm run build` de novo.

## Comandos

Build/UI e execução:

```bash
cd /home/lipe/Projects/lipecode/chill-browser/desktop
npm run build:ui
cd engine
python3 ./mach run --temp-profile \
  --new-tab http://127.0.0.1:8081/dom.html \
  --setpref chill.devtools.chrome.enabled=true \
  --setpref chill.devtools.chrome.autostart=true \
  --setpref chill.devtools.chrome.port=9230
```

Para abrir docked automaticamente, adicionar
`--setpref chill.devtools.chrome.auto-open=true`; use
`--setpref chill.devtools.chrome.panel=resources` para Application.

## Observações

- Nada foi commitado.
- O navegador de teste pode ficar rodando; fechar antes de desligar o
  notebook.
- O problema de textos some após `import`; sempre rodar
  `scripts/update_en_US_packs.py` + build completo.
