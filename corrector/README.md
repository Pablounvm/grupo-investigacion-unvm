# Corrector de grillas

App web instalable (PWA) que corrige hojas de respuestas de opción múltiple y V/F a partir de una foto del celular.
Las marcas pueden ser **cruces (X), círculos, tildes o casilleros rellenos** hechos a mano con birome.

## Seguridad y privacidad

- **Todo se procesa en el dispositivo.** No hay servidor, ni cuentas, ni envío de fotos o datos.
- Sin librerías externas ni CDNs: todo el código está en esta carpeta (≈ 1000 líneas, auditable).
- Política de seguridad de contenido (CSP) que bloquea cualquier conexión a otros sitios.
- La **clave nunca se imprime ni se sube al repositorio**: se carga en el teléfono y queda sólo ahí (`localStorage`).
- Las fotos no se guardan; sólo se conservan nombre, legajo, respuestas leídas y puntaje.

## Instalación en el celular

1. Publicar esta carpeta por HTTPS (p. ej. GitHub Pages: *Settings → Pages → Deploy from branch*).
   La URL queda `https://<usuario>.github.io/<repositorio>/corrector/`.
2. Abrir esa URL en el celular:
   - **Android (Chrome):** menú ⋮ → *Instalar app* / *Agregar a la pantalla principal*.
   - **iPhone (Safari):** botón Compartir → *Agregar a inicio*.
3. Queda como una app más y funciona **sin conexión**.

## Uso

1. **Examen:** escribir la clave, una línea por ítem: `etiqueta opciones respuesta puntos`.
   ```
   1     abcde  b   1
   2     abcd   a   1
   12.1  abcde  ac  1    ← dos respuestas correctas
   15a   VF     V   1
   ```
2. **Hoja:** imprimir la hoja de respuestas generada (A4). Tiene 4 cuadrados negros en las esquinas
   y uno chico de orientación: no taparlos ni recortarlos.
3. **Corregir:** sacar la foto. La app muestra la hoja enderezada con las marcas coloreadas
   (verde correcta, rojo incorrecta, naranja *a revisar*, recuadro azul = clave).
   Tocar un casillero corrige la lectura. Guardar y pasar a la siguiente.
4. **Notas:** tabla de resultados y exportación a CSV (separador `;`, coma decimal, abre directo en Excel).

## Cómo decide

Para cada casillero se mide la tinta manuscrita **excluyendo el borde impreso** y se compara contra la opción
más limpia del mismo ítem. Cada opción queda *marcada*, *vacía* o *dudosa*. Un ítem va a **revisión**
(nunca se decide en silencio) cuando hay una opción dudosa, más marcas que respuestas esperadas,
o tinta sobre el borde del casillero (p. ej. un círculo dibujado justo encima).
Antes de leer, la app verifica que la geometría sea coherente y que los bordes impresos estén donde
indica la grilla configurada; si no, **rechaza la foto** en lugar de leer mal la hoja.

## Banco de pruebas

```
node tests/synthetic.test.js 100 31337
```

Simula hojas completadas (cruces, círculos, tildes, rellenos, marcas tenues, dobles marcas, deslices),
fotografiadas con perspectiva, giro, sombra, desenfoque y ruido, y mide la tasa de error.
Es un banco sintético: **la tasa real debe validarse con hojas reales del curso.**
