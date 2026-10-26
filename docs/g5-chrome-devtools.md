# G5 — Substituição do entry point do DevTools

Data: 2026-10-23

## Objetivo

Fazer o Chrome DevTools ser o único entry point visível do navegador,
mantendo o backend do Firefox apenas como implementação interna da
bridge.

## Entry points

### F12 e atalhos

`devtools/startup/DevToolsStartup.sys.mjs` foi ajustado para desviar os
atalhos para `ChromeDevToolsBridge.open()` quando
`chill.devtools.firefox.enabled` é `false`:

| Atalho | Painel |
|---|---|
| F12 / Ctrl+Shift+I | Elements (toggle) |
| Ctrl+Shift+C | Elements |
| Ctrl+Shift+K | Console |
| Ctrl+Shift+S | Sources |
| Ctrl+Shift+E | Network |

Atalhos sem painel equivalente (Responsive Design Mode, Style Editor,
Performance, Storage, DOM, Accessibility) não abrem mais o DevTools do
Firefox.

### Menu

`devtools/client/framework/browser-menus.js`:

- "Ferramentas do desenvolvedor" abre/fecha o frontend do Chrome;
- itens de Inspector, Console, Debugger e Network apontam para os painéis
  Chrome equivalentes;
- itens sem equivalente (Browser Toolbox, Browser Console, Responsive
  Design Mode, Eyedropper, Performance, Storage, DOM, Accessibility,
  Style Editor) não são exibidos no modo Chrome.

### "Inspecionar elemento"

`browser/base/content/nsContextMenu.sys.mjs` desvia `inspectNode()` e
`inspectA11Y()` para o painel Elements; o item de acessibilidade é
ocultado no modo Chrome.

## Preferências

| Pref | Default | Uso |
|---|---|---|
| `chill.devtools.chrome.enabled` | `true` | Liga a bridge e os entry points |
| `chill.devtools.firefox.enabled` | `false` | Restaura o DevTools do Firefox |
| `chill.devtools.chrome.autostart` | `false` | Inicia a bridge no startup (testes/automação) |
| `chill.devtools.chrome.auto-open` | `false` | Abre o frontend no startup (testes visuais) |
| `chill.devtools.chrome.panel` | `elements` | Painel inicial |
| `chill.devtools.chrome.port` | `0` | Porta fixa opcional; `0` escolhe uma livre |

A bridge agora é lazy por padrão: ela só inicia no primeiro F12/menu e
vincula o target à aba selecionada naquele momento. Se o usuário trocar
de aba, o próximo entry point recria a bridge para a nova aba.

## Verificação

- F12 abriu o frontend oficial com o painel Elements na aba
  `http://127.0.0.1:8081/debug.html`.
- Log da bridge confirmou `target http://127.0.0.1:8081/debug.html` e
  `opening frontend ...&panel=elements`.
- O teste de Debugger executou breakpoint, pause e `evaluateOnCallFrame`
  na bridge aberta por F12.
- Evidência visual: `docs/assets/g5-f12.png`.

## Limitações

- "Inspecionar elemento" abre o painel Elements, mas ainda não
  pré-seleciona o nó clicado (`DOM.getNodeForLocation` não implementado).
- O frontend é docked no `browserContainer` da aba, ao lado da página.
- O servidor local continua ativo após fechar o dock; a próxima abertura
  reutiliza a mesma sessão.
- Menus e atalhos de painéis sem equivalente ficam ocultos/desativados,
  não simulados.
- A verificação automatizada cobre F12 e o protocolo CDP; menu e context
  menu foram alterados no mesmo fluxo, mas ainda exigem validação manual
  de UI.

Próximo gate: **G6 — paridade restante** (`docs/cdp-compatibility.md`).
