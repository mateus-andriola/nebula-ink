# Especificação e Guia de Exportação para PDF Vetorial

## 1. Princípios da Exportação PDF

A exportação para PDF do **Digital Notebook** nunca utiliza capturas de tela (*screenshots*) ou bitmaps rasterizados da área de visualização. Todo arquivo `.pdf` é construído diretamente a partir dos **dados vetoriais persistidos no SQLite** (`pages` e `strokes`).

### Características Garantidas
1. **Correspondência 1:1 de Páginas**: Cada página selecionada do caderno gera exatamente uma página vetorial independente no documento PDF.
2. **Preservação das Dimensões Lógicas**:
   - A página lógica (`1000.0 x 1414.2135`) é mapeada proporcionalmente para o padrão tipográfico ISO A4 em pontos PostScript (`595.28 x 841.89 pt`), preservando a razão de aspecto exata ($1:\sqrt{2}$).
   - A conversão da coordenada lógica $(x, y)$ (com origem no canto superior esquerdo) para o sistema de coordenadas PDF $(X_{\text{pdf}}, Y_{\text{pdf}})$ (com origem no canto inferior esquerdo) é:
     $$X_{\text{pdf}} = x \cdot \frac{W_{\text{pdf}}}{W_{\text{lógico}}}, \quad Y_{\text{pdf}} = H_{\text{pdf}} - y \cdot \frac{H_{\text{pdf}}}{H_{\text{lógico}}}$$
3. **Traços Sensíveis à Pressão Vetoriais**:
   - Cada segmento de traço preserva a espessura modulada pela pressão capturada da S Pen:
     $$w_i = \text{baseWidth} \cdot (0.35 + 0.90 \cdot p_i)$$
   - Os traços são emitidos como primitivas vetoriais PDF (`m`, `l`, `S` com `1 J` *round line cap* e `1 j` *round line join*) agrupadas por faixas contínuas de espessura e cor RGB exata (`RG` / `rg`), permitindo zoom infinito em qualquer leitor de PDF (Adobe Acrobat, Chrome, Edge, SumatraPDF) sem serrilhamento (*pixelation*).
4. **Grade Pontilhada Opcional**:
   - O usuário pode escolher no momento da exportação se deseja **incluir** ou **excluir** a grade pontilhada.
   - Quando incluída, a grade é gerada com círculos vetoriais PDF nas coordenadas exatas do `gridSpacing`, respeitando a cor e a opacidade configuradas na página.

---

## 2. Como Exportar no Aplicativo Desktop

1. Na barra superior do aplicativo Desktop, clique em **"Exportar PDF"**.
2. Escolha o escopo:
   - **Página Atual**: Exporta apenas a página visível no momento.
   - **Caderno Inteiro**: Exporta todas as páginas do caderno ativo em ordem sequencial.
3. Marque ou desmarque a opção **"Incluir grade pontilhada no PDF"**.
4. Clique em **"Salvar PDF"** e selecione o diretório de destino no diálogo do sistema (ou baixe diretamente).
5. Caso ocorra qualquer erro de permissão de escrita em disco, o aplicativo exibe uma mensagem de erro amigável sem alterar ou perder nenhum dado do caderno original.
