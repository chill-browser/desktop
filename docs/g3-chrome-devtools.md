# G3 — DOM/Elements com Chrome DevTools

Data: 2026-10-23

## Objetivo

Provar que o painel **Elements** do frontend oficial do Chrome DevTools
consegue ler a árvore DOM real da aba inspecionada, selecionar nós,
mostrar atributos, estilos e box model, e acionar o highlight do Firefox.

## Implementação

`ChromeDevToolsBridge.mjs` agora cria um `inspector` front por target e
usa `inspector.walker`/`inspector.pageStyle`:

- `DOM.enable` / `DOM.disable`;
- `DOM.getDocument` com profundidade (default `1`, `-1` para subárvore
  completa) e `DOM.requestChildNodes` → `DOM.setChildNodes`;
- `DOM.querySelector`, `DOM.querySelectorAll`, `DOM.getAttributes` e
  `DOM.describeNode`;
- `DOM.getBoxModel` a partir de `pageStyle.getLayout()`;
- `DOM.pushNodesByBackendIdsToFrontend` e `DOM.getTopLayerElements`
  (mantidos compatíveis com o painel);
- `CSS.enable`, `CSS.getComputedStyleForNode`,
  `CSS.getMatchedStylesForNode` e `CSS.getInlineStylesForNode`;
- `Overlay.enable`, `Overlay.highlightNode` e `Overlay.hideHighlight`
  usando `BoxModelHighlighter`.

Os IDs CDP são estáveis por `actorID` do NodeFront, e o mapa é limpo em
navegações (`Page.navigate` e requests de navegação da Network).

## Teste

`desktop/scripts/test_chrome_devtools_dom.mjs` valida o protocolo:

```json
{
  "rootNodeId": 1,
  "targetNodeId": 12,
  "nodeName": "DIV",
  "localName": "div",
  "attributes": ["id", "target", "class", "box", "data-test", "yes"],
  "color": "rgb(255, 0, 0)",
  "matchedRules": 1,
  "boxModel": { "width": 1050, "height": 35 }
}
```

O teste confirma:

- árvore com `<html>`, `<head>`, `<body>` e o elemento `#target`;
- atributos reais (`id`, `class`, `data-test`);
- estilo computado (`color: rgb(255, 0, 0)`);
- regra CSS combinada (`#target`);
- box model com dimensões positivas;
- `Overlay.highlightNode`/`hideHighlight` sem erro.

## Evidência visual

`docs/assets/g3-elements.png` mostra o painel Elements com:

- árvore DOM real expandida;
- seleção de `div#target.box`;
- breadcrumb `html > body > main > div#target.box`;
- aba Styles com `element.style {}` e a regra `#target`;
- box model com margem, borda, padding e conteúdo.

## Limitações

- Sem eventos de mutação ao vivo (`DOM.childNodeInserted` etc.); a árvore é
  carregada sob demanda e não acompanha mudanças após a carga.
- `DOM.getNodeForLocation`/inspect mode do Elements ainda não está
  implementado.
- `CSS.getMediaQueries` retorna lista vazia; sem edição de estilos.
- `DOM.getBoxModel` usa o layout do Firefox e devolve os quatro boxes com o
  mesmo retângulo de conteúdo; o painel exibe margem/borda/padding a partir
  dos estilos computados.
- O highlight é acionado no protocolo, mas a evidência visual capturada é
  da árvore/estilos, não do overlay na página.

Próximo gate: **G4 — Sources/Debugger**.
