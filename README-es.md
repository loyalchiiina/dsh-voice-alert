# Voice Alert

> Speak task milestones, errors and completions out loud so you can step away from the screen.

> Full documentation: [English README](./README.md)

## Novedades v0.4.17 · What's new

* 🆓 **Voces gratuitas integradas (sin clave API)**: tercera ruta de voz `free` = texto-a-voz de Microsoft edge-tts. 7 voces de audición, encabezadas por una voz femenina dulce con acento de Taiwán (晓陈 / 晓陈·嗲 / 晓宇 / 晓宇·嗲 / 晓伊 / 晓晓 / 粤语晓曼). «设为当前» (fijar como actual) aplica al instante; «▶ 试听» (audición) sintetiza en el momento. **Requisitos**: Python instalado en la máquina y `pip install edge-tts` ejecutado (en China: añade `-i https://mirrors.aliyun.com/pypi/simple/`); la primera síntesis necesita red — el mp3 resultante queda en caché y después se reproduce sin conexión. Si falta algo, la interfaz lo dice explícitamente (`edge-python-missing` / `edge-tts-not-installed` / `edge-offline`) en lugar de romperse. Las voces gratuitas son un catálogo virtual del lado del servidor: no se escriben en `voices` de `config.json`, no se mezclan en la lista de `/voices`, no entran en `DEFAULT_VOICES` — tus propias voces con clave quedan intactas. (Ver [§4.3](./README.md#43-免费内置音色v0417-edge-tts零-key))
* 🔎 **Interfaz compacta**: tipografía y espaciado más densos — relleno de tarjeta 16/18 → 11/13px, separación externa 12 → 8px, título de tarjeta 17 → 15px, texto/descripción → 11.5px, títulos de sección/campos/botones secundarios → 12.5px, botón principal 15 → 13px, botones de acción en fila y filas de efectos → 11.5px; además se eliminó la fila redundante ⬇descargar / ⬆importar de la tarjeta «🔔 播报开关» (cada aviso ya tiene su propio par en «✍️ 播报内容») y se acortaron 5 textos largos. Todo cabe en una pantalla. Los textos explicativos pasaron a glifos flotantes (ⓘ / 🔈 al pasar el ratón, sin ocupar espacio); las filas de la biblioteca de voces ya caben en una sola línea (sin salto, columnas de texto comprimibles, botones que no se encogen), así que en paneles estrechos los botones ya no se salen de la tarjeta.
* ✅ Auto-pruebas: **472 aserciones**; con `--no-sound` medido en vivo: **472 pasan / 0 fallan**, más 6 omitidas (todas reproducirían audio real y no se ejecutan con `--no-sound`). Composición: 360 de §1–§16 (0.4.16 y anteriores)   **41** de la nueva sección §17 «voces gratuitas»   **21** de la sección §18 «regresión de los defectos de la revisión extremo a extremo»   **8** de la sección §19 «regresión de la tercera ronda»   **42** de la sección §20 «consistencia estática de la interfaz cliente» = 472. §18 cubre los 6 defectos (D1~D6) de la segunda ronda; §19 cubre los 2 de la tercera ronda (D7: `/generate` sin filtro para ids `free:` malformados; D8: sin límite de longitud del nombre free), todos corregidos.

## 功能总览 · At a glance（中英对照 / Bilingual）

> 📖 [Leer esta sección en el README principal](./README.md#功能总览-at-a-glance中英对照-bilingual)

## 1. 它做什么

> 📖 [Leer esta sección en el README principal](./README.md#1-它做什么)

## 2. 事件依据（官方源码实证，非猜测）

> 📖 [Leer esta sección en el README principal](./README.md#2-事件依据官方源码实证非猜测)

## 3. 去重与错误优先（实现要点）

> 📖 [Leer esta sección en el README principal](./README.md#3-去重与错误优先实现要点)

## 4. 响度（"声音太小"的根因与解法）

> 📖 [Leer esta sección en el README principal](./README.md#4-响度声音太小的根因与解法)

## 4.1 音色库（需求 A · v0.3.0）

> 📖 [Leer esta sección en el README principal](./README.md#41-音色库需求-a-v030)

## 4.2 音效提醒（需求 B · v0.3.3）

> 📖 [Leer esta sección en el README principal](./README.md#42-音效提醒需求-b-v033)

## 4.3 免费内置音色（v0.4.17 · edge-tts，零 Key）

> 📖 [Leer esta sección en el README principal](./README.md#43-免费内置音色v0417-edge-tts零-key)

Tercera ruta de voz `free`: sin HTTP propio — sintetiza vía subproceso local `edge-tts` (`lib/edgevoice.js`), sin ninguna clave. Enrutamientos relacionados: `GET /dsh-voice-alert/free/runtime` (comprueba Python   `edge_tts` en la máquina; **solo GET**, caché con dos niveles — 30 s si pasa, apenas 5 s si falla, para que «pip install» surta efecto al recargar; sin probar la red) y `POST /dsh-voice-alert/free/audition` (audición; el mp3 se cachea en `<data>\edge-cache` y no se resintetiza). `/voices/probe` y `/generate` derivan automáticamente los ids `free:` a la síntesis edge; el control deslizante «velocidad» se traduce al `--rate` de edge. **Única compuerta** `isVoicesLibraryId()` — la consultan tanto `normalizeVoices` como `mergeVoiceImport` (antes cada ruta tenía su propio criterio y se contradecían), así que ni los 7 ids del catálogo ni un `free:xxx` escrito a mano llegan nunca a `voices` de `config.json`, y pegar una fila gratuita en el importador ya no produce un «falta ark-key» rojo. `/voices/save` además valida `selectedVoiceId` (id de biblioteca / id `free:` válido / cadena vacía; cualquier otro valor se registra y se ignora conservando la selección previa). Los caracteres ilegales del id (incluidos los dos puntos) se sustituyen por `_` antes de formar el nombre de archivo: en NTFS los dos puntos son separador de flujos de datos alternativos y sin limpiar se filtraba un archivo de 0 bytes por síntesis.

## 5. 配置

> 📖 [Leer esta sección en el README principal](./README.md#5-配置)

## 5.1 蓝牙耳机注意事项（实测 2026-09-16）

> 📖 [Leer esta sección en el README principal](./README.md#51-蓝牙耳机注意事项实测-2026-09-16)

## 6. 播放链路（为什么这样启动）

> 📖 [Leer esta sección en el README principal](./README.md#6-播放链路为什么这样启动)

## 7. 部署（desktop   web）

> 📖 [Leer esta sección en el README principal](./README.md#7-部署desktop-web)

## 8. 自检（可独立运行，不经 DSH）

> 📖 [Leer esta sección en el README principal](./README.md#8-自检可独立运行不经-dsh)

## 9. 诊断接口与免凭据控制通道

> 📖 [Leer esta sección en el README principal](./README.md#9-诊断接口与免凭据控制通道)

## 10. 卸载

> 📖 [Leer esta sección en el README principal](./README.md#10-卸载)

## License

> 📖 [Leer esta sección en el README principal](./README.md#license)
