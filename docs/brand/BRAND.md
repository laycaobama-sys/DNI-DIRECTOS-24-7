# DNI Directos 24/7 — Pack de marca

## Esencia
**Tu canal no se apaga. Nunca.**
Plataforma de emisión en directo 24/7 desde la nube. La marca transmite fiabilidad técnica (una sala de control que
nunca duerme) con la energía de una señal «en el aire».

- **Promesa:** directos 24/7 en YouTube y cualquier RTMP sin encender el ordenador.
- **Personalidad:** experta, directa, honesta, cálida. Nunca exagera: no promete monetización ni audiencias.
- **Tono:** tuteo, frases cortas, verbos de acción («Sube», «Conecta», «Emite»). Español de España por defecto.

## Logotipo
| Archivo | Uso |
|---|---|
| `logo-symbol.svg/.png` | Símbolo sobre cuadro oscuro. Icono de app, avatar de redes, favicon. |
| `logo-symbol-transparent.svg/.png` | Símbolo sin fondo, sobre fondos oscuros. |
| `logo-symbol-mono-white.svg/.png` · `-mono-black` | Una tinta: grabados, sellos, fondos fotográficos. |
| `logo-horizontal-dark.svg/.png` | Logotipo completo sobre fondo oscuro (preferente). |
| `logo-horizontal-light.svg/.png` | Logotipo completo sobre fondo claro. |
| `social-card.svg/.png` | Imagen para compartir en redes (1200 × 630). |

El símbolo es un punto «en directo» con dos ondas de señal: emisión que se propaga.
**Área de respeto:** la mitad de la altura del símbolo alrededor. **Tamaño mínimo:** 24 px el símbolo, 120 px el horizontal.
No deformar, no cambiar los colores del degradado, no añadir sombras ni contornos.

Regenerar todos los archivos: `node scripts/brand-assets.mjs`.

## Color
| Token | Hex | Uso |
|---|---|---|
| Señal (primario) | `#FF4F2E` | Botones principales, «en directo», acentos. |
| Señal medio | `#FF8A3D` | Degradados. |
| Ámbar | `#FFB020` | Final del degradado, destacados. |
| Violeta | `#7C5CFF` | Acento secundario, profundidad en fondos. |
| Tinta 950 | `#07080C` | Fondo principal (modo oscuro). |
| Tinta 900 | `#0E1017` | Superficies. |
| Tinta 400 | `#868EA0` | Texto secundario. |
| Éxito | `#19B47A` | Estados correctos. |
| Aviso | `#E09B14` | Estados degradados. |

**Degradado de marca:** `linear-gradient(110deg, #FF4F2E, #FF7A3D 45%, #FF9F1C)`.
Contraste: texto blanco sobre Señal cumple AA para texto grande y botones; para texto pequeño usar blanco sobre Tinta.

## Tipografía
**Inter** (Google Fonts, licencia OFL) en todos los pesos 400–800.
- Titulares: ExtraBold 800, interletraje −2 %.
- Texto: Regular 400 / Medium 500, interlineado 1,6.
- Cifras técnicas (bitrate, tiempos): monoespaciada del sistema con cifras tabulares.

## Movimiento
- Curva de marca: `cubic-bezier(0.16, 1, 0.3, 1)` (salida exponencial), 450–900 ms.
- Elementos: aurora de luz que deriva despacio, pulso «en directo», ecualizador, líneas de señal que fluyen.
- Siempre respetar «reducir movimiento» del sistema.

## Mensajes clave
1. Directos 24/7 en YouTube sin encender el ordenador.
2. Sube, ordena, conecta y emite: en cinco minutos.
3. Si un destino falla, los demás siguen en directo.
4. Gratis y sin límite de horas.

## Palabras clave (SEO)
directo 24/7 · streaming 24/7 · live 24/7 YouTube · directo en bucle · emitir vídeos pregrabados en directo ·
transmisión en vivo pregrabada · multistream · restream · radio 24/7 YouTube · lofi 24/7 · emitir sin OBS · RTMP en la nube.
