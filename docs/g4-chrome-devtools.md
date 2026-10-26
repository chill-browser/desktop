# G4 — Sources/Debugger com Chrome DevTools

Data: 2026-10-23

## Objetivo

Provar que o painel **Sources** do frontend oficial do Chrome DevTools
lista scripts reais, pausa em breakpoints do Firefox, mostra a call stack
e permite avaliar expressões no frame pausado.

## Implementação

O domínio `Debugger` foi adicionado ao `Schema.getDomains` e usa o
`ThreadFront` do target atual:

- `Debugger.enable` anexa o thread, lê `getSources()` e emite
  `Debugger.scriptParsed` para cada script;
- `Debugger.getScriptSource` lê o texto via `SourceFront.source()`;
- `Debugger.getPossibleBreakpoints` usa
  `getBreakpointPositionsCompressed()`;
- `Debugger.setBreakpointByUrl` resolve a primeira coluna válida da linha
  e registra o breakpoint no `ThreadFront`;
- `Debugger.setBreakpoint`, `removeBreakpoint` e
  `setBreakpointsActive` (no-op compatível);
- `Debugger.pause`, `resume`, `stepOver`, `stepInto` e `stepOut`;
- `Debugger.evaluateOnCallFrame` usa `scriptCommand.execute()` com o
  `frameActor` do frame pausado;
- eventos `paused`, `resumed` e `scriptParsed` são encaminhados para o
  frontend;
- após navegação, o bridge reanexa o novo `ThreadFront` e reenvia os
  scripts.

## Teste

`desktop/scripts/test_chrome_devtools_debugger.mjs` executa o fluxo
completo:

```json
{
  "scriptUrl": "http://127.0.0.1:8081/debug.js",
  "scriptId": "server0.conn0.watcher2.process5//source36",
  "breakpointLocation": {
    "scriptId": "server0.conn0.watcher2.process5//source36",
    "lineNumber": 1,
    "columnNumber": 18
  },
  "pausedFunction": "chillTest",
  "frameValue": 5,
  "evaluationResult": 11
}
```

O teste confirma:

- `Debugger.scriptParsed` para `debug.js`;
- leitura do código-fonte com `function chillTest`;
- breakpoint por URL resolvido para a coluna 18 da linha 2;
- pausa com `reason: "breakpoint"` e frame `chillTest`;
- `Debugger.evaluateOnCallFrame` retornando `x === 5`;
- `resume` e conclusão de `chillTest(5) === 11`.

## Evidência visual

`docs/assets/g4-sources.png` mostra o painel Sources com:

- árvore `top > 127.0.0.1:8081 > debug.html/debug.js`;
- banner **Debugger paused**;
- call stack `chillTest` em `debug.js:2` e `(global)`.

## Limitações

- `scopeChain` ainda não é preenchida; o painel Scope não lista
  variáveis locais.
- Sem source maps, pretty print, blackboxing ou live edit.
- Sem breakpoints condicionais avançados, XHR/DOM/event breakpoints ou
  pausa em exceções.
- `setBreakpointByUrl` aceita URL exata, não `urlRegex`.
- A lista de scripts é renovada em `enable`/navegação; scripts criados
  dinamicamente sem `newSource` podem não aparecer imediatamente.

Próximo gate: **G5 — integração final (F12/menu, desligar DevTools do
Firefox, painéis restantes)**.
