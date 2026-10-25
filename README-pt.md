# Voice Alert

> Speak task milestones, errors and completions out loud so you can step away from the screen.

> Full documentation: [English README](./README.md)

## Novidades da v0.4.18 · What's new

* 🩹 **A biblioteca de vozes não desaparece mais ao recarregar**: o painel de configurações é um slot do React e a biblioteca é desenhada de forma imperativa, então um re-render do host recriava o contêiner vazio. Agora há três camadas anti-apagamento (MutationObserver do contêiner + trava de renderização + vigia de nascimento do slot).
* 🗑 **O botão "Excluir" finalmente aparece em "Minha biblioteca de vozes"**: a coluna direita era criada mas nunca anexada à linha com `appendChild`. Agora **qualquer linha pode ser excluída** e a mudança é gravada na hora; se você excluir a voz em uso, o host muda `selectedVoiceId` para a primeira voz disponível.
* 💬 **Os balões de dica nunca saem do painel**: eram `position:absolute` e o CSS não conhece o recorte `overflow` dos ancestrais nem a própria largura. Agora, ao aparecer, o JS mede o retângulo real e reposiciona dentro da área visível (com inversão para cima), recalculando em scroll e resize.
* 🖼 **Capturas atualizadas**: duas capturas reais desidentificadas (modo voz / modo efeitos) substituem as anteriores.

## Novidades da v0.4.17 · What's new

* 🆓 **Vozes gratuitas embutidas (sem chave de API)**: terceira rota de voz `free` = texto-para-voz da Microsoft via edge-tts. 7 vozes de audição, lideradas por uma voz feminina doce com sotaque de Taiwan (晓陈 / 晓陈·嗲 / 晓宇 / 晓宇·嗲 / 晓伊 / 晓晓 / 粤语晓曼). «设为当前» (definir como atual) aplica na hora; «▶ 试听» (ouvir) sintetiza na hora. **Pré-requisitos**: Python instalado na máquina e `pip install edge-tts` executado (na China, acrescente `-i https://mirrors.aliyun.com/pypi/simple/`); a primeira síntese precisa de rede; o mp3 gerado fica em cache e depois reproduz offline. Se algo faltar, a interface diz exatamente o que falta (`edge-python-missing` / `edge-tts-not-installed` / `edge-offline`) em vez de quebrar. As vozes gratuitas são um catálogo virtual do servidor: não são gravadas em `voices` do `config.json`, não se misturam à lista de `/voices`, não entram em `DEFAULT_VOICES` — as suas vozes com chave ficam intactas. (Ver [§4.3](./README.md#43-免费内置音色v0417-edge-tts零-key))
* 🔎 **Interface compacta**: tipografia e espaçamento mais densos — padding do cartão 16/18 → 11/13px, gap externo 12 → 8px, título do cartão 17 → 15px, corpo/descrição → 11.5px, títulos de seção/campos/botões secundários → 12.5px, botão principal 15 → 13px, botões de ação em linha e linhas de efeitos → 11.5px; além disso sumiu a fileira redundante ⬇baixar / ⬆importar do cartão «🔔 播报开关» (cada aviso já carrega o próprio par em «✍️ 播报内容») e 5 textos longos foram encurtados. Cabe tudo numa tela. Os textos explicativos viraram glifos flutuantes (ⓘ / 🔈 ao passar o mouse, sem ocupar espaço); as linhas da biblioteca de vozes agora ficam numa só linha (sem quebra, colunas de texto encolhíveis, botões que não encolhem), então em painéis estreitos os botões não saem mais do cartão.
* ✅ Autoteste: **472 asserções**; medido ao vivo com `--no-sound`: **472 passam / 0 falham**, mais 6 ignoradas (todas reproduziriam áudio de verdade e não rodam com `--no-sound`). Composição: 360 de §1–§16 (0.4.16 e anteriores)   **41** da nova seção §17 «vozes gratuitas»   **21** da seção §18 «regressão dos defeitos da revisão ponta a ponta»   **8** da seção §19 «regressão da terceira rodada»   **42** da seção §20 «consistência estática da interface do cliente» = 472. §18 cobre os 6 defeitos (D1~D6) da segunda rodada; §19 cobre os 2 da terceira rodada (D7: `/generate` sem filtro para ids `free:` malformados; D8: sem limite de comprimento do nome free), todos corrigidos.

## 功能总览 · At a glance（中英对照 / Bilingual）

> 📖 [Ler esta seção no README principal](./README.md#功能总览-at-a-glance中英对照-bilingual)

## 1. 它做什么

> 📖 [Ler esta seção no README principal](./README.md#1-它做什么)

## 2. 事件依据（官方源码实证，非猜测）

> 📖 [Ler esta seção no README principal](./README.md#2-事件依据官方源码实证非猜测)

## 3. 去重与错误优先（实现要点）

> 📖 [Ler esta seção no README principal](./README.md#3-去重与错误优先实现要点)

## 4. 响度（"声音太小"的根因与解法）

> 📖 [Ler esta seção no README principal](./README.md#4-响度声音太小的根因与解法)

## 4.1 音色库（需求 A · v0.3.0）

> 📖 [Ler esta seção no README principal](./README.md#41-音色库需求-a-v030)

## 4.2 音效提醒（需求 B · v0.3.3）

> 📖 [Ler esta seção no README principal](./README.md#42-音效提醒需求-b-v033)

## 4.3 免费内置音色（v0.4.17 · edge-tts，零 Key）

> 📖 [Ler esta seção no README principal](./README.md#43-免费内置音色v0417-edge-tts零-key)

Terceira rota de voz `free`: sem endpoint HTTP próprio — sintetiza pelo subprocesso local `edge-tts` (`lib/edgevoice.js`), sem nenhuma chave. Rotas relacionadas: `GET /dsh-voice-alert/free/runtime` (checa Python   `edge_tts` na máquina; **somente GET**, cache em dois níveis — 30 s quando passa, só 5 s quando falha, para que um `pip install` recém-feito já apareça ao recarregar; **não testa a rede**) e `POST /dsh-voice-alert/free/audition` (audição; o mp3 fica em `<data>\edge-cache` e não é resintetizado quando o carimbo bate). `/voices/probe` e `/generate` desviam automaticamente ids `free:` para a síntese edge; o slider «velocidade» é convertido no `--rate` do edge. **Porta única** `isVoicesLibraryId()` — consultada por `normalizeVoices` **e** `mergeVoiceImport` (antes cada caminho tinha seu próprio critério e eles brigavam): nem os 7 ids do catálogo nem um `free:xxx` escrito à mão chegam ao `voices` do `config.json`, e colar uma linha gratuita no importador já não gera um «falta ark-key» vermelho. `/voices/save` também valida `selectedVoiceId` (id da biblioteca / id `free:` válido / string vazia; qualquer outro valor é registrado no log e a seleção anterior é mantida). Os caracteres ilegais do id (incluindo os dois-pontos) são substituídos por `_` antes de virar nome de arquivo: no NTFS os dois-pontos separam fluxos de dados alternativos, e sem isso cada síntese vazava um arquivo de 0 bytes.

## 5. 配置

> 📖 [Ler esta seção no README principal](./README.md#5-配置)

## 5.1 蓝牙耳机注意事项（实测 2026-09-16）

> 📖 [Ler esta seção no README principal](./README.md#51-蓝牙耳机注意事项实测-2026-09-16)

## 6. 播放链路（为什么这样启动）

> 📖 [Ler esta seção no README principal](./README.md#6-播放链路为什么这样启动)

## 7. 部署（desktop   web）

> 📖 [Ler esta seção no README principal](./README.md#7-部署desktop-web)

## 8. 自检（可独立运行，不经 DSH）

> 📖 [Ler esta seção no README principal](./README.md#8-自检可独立运行不经-dsh)

## 9. 诊断接口与免凭据控制通道

> 📖 [Ler esta seção no README principal](./README.md#9-诊断接口与免凭据控制通道)

## 10. 卸载

> 📖 [Ler esta seção no README principal](./README.md#10-卸载)

## License

> 📖 [Ler esta seção no README principal](./README.md#license)
