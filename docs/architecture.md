# webpin の仕組み

最終更新: 2026-08-25

## 方針

素の Node.js（CommonJS）だけで書く。`package.json` も `node_modules` も置かない。
WebSocket も自前で書いている（`lib/cdp.js`）。

## 全体の流れ

```
webpin
  │
  ├─ git ルートを探してプロジェクトを決める        lib/project.js
  ├─ パスから決定的にポートを決める（49152+）      lib/project.js
  ├─ php -S を裏で立てる（php があり、ライブ中継でなければ）
  │                                                lib/server.js
  ├─ HTTP サーバーを立てる                         lib/server.js
  │     配信する HTML の </body> 直前に
  │     <script src="/__webpin/overlay.js"> を差し込む
  └─ 専用プロファイルの Chrome を開く              bin/webpin
        （--remote-debugging-port=<port+2>）

ブラウザ                                            web/overlay.js
  │  クリック / ドラッグ / 書き換え
  ↓  POST /__webpin/{note,edit,shot,done,drop}
サーバー
  ├─ 逆引き: 画面のテキスト → ソースの file:line   lib/resolve.js
  ├─ 条件を満たせばソースを書き換え → build.js     lib/apply.js
  ├─ 範囲スクショ（CDP でタブを撮る）              lib/shot.js + lib/cdp.js
  └─ 指摘を追記                                    lib/store.js
        ~/.cache/webpin/<name>-<hash>/notes.jsonl

fs.watch → SSE(/__webpin/events) → location.reload()
```

## ファイルの役割

| ファイル | 役割 |
|---|---|
| `bin/webpin` | 引数の解釈、サブコマンド（notes / show / done / clear）、サーバー起動、Chrome 起動 |
| `lib/project.js` | git ルート検出、パスハッシュ、ポート導出、キャッシュディレクトリ |
| `lib/server.js` | 静的配信、PHP プロキシ、オーバーレイ注入、SSE、`/__webpin/*` API |
| `lib/live.js` | 本番サーバーへの中継（DB / ログインが要る PHP ページ用） |
| `lib/resolve.js` | **逆引き**。テキスト検索、生成物判定、候補のスコアリング |
| `lib/apply.js` | 自動書き換えの可否判定、文脈に合わせた再エスケープ、build.js の再実行 |
| `lib/store.js` | 指摘の追記と畳み込み（JSONL） |
| `lib/cdp.js` | 最小の WebSocket クライアント + Chrome DevTools Protocol |
| `lib/shot.js` | 範囲スクリーンショット |
| `web/overlay.js` | ブラウザ側の UI 全部（Shadow DOM、CSS も文字列で内包） |

## 逆引き（このツールの中核）

画面に見えているテキストから、編集すべきソースの行を求める。

### 1. クリック位置の「テキストノード」を取る

要素の `textContent` ではなく、`caretPositionFromPoint` で得た**個々のテキストノード**を使う。

これは `<p>あああ<br>いいい</p>` のようにタグを含む要素で効いてくる。`textContent` は
`あああいいい` になってソースのどこにも一致しないが、テキストノード単位なら `あああ` が
`content.js` の `'あああ<br>いいい'` の部分列として正しく当たり、`<br>` を壊さずに置換できる。
pandoc 由来の授業ノート（`<strong>` 混じり）も同じ理屈で救われる。

### 2. ソース候補を集める

- `data-i18n` 属性があれば**キーで直接引く**。`translations.js` の `"hero_p":` は
  `"en"` / `"ja"` のどちらのブロックにあるかまで判定する。テンプレートの
  `data-i18n="hero_p"` の行も候補になる
- それ以外はプロジェクト内の `.html/.php/.js/.json/.md/.css` を全文検索する。
  空白の入り方の違い（ソース側の改行・インデント）を吸収するため、
  空白を `\s+` に置き換えた正規表現で探す。HTML エスケープ形（`&amp;` など）でも探す

### 3. 生成物を落とす

生成された HTML には「自動生成」のマーカーが一切ない（実際のサイトで確認）。
そのため次のルールで判定する:

> `.html` であり、祖先に `build.js` があり、**その build.js のディレクトリに
> `template_*.html` が1つ以上あり**、自分自身が `template_*.html` でない → 生成物

`template_*.html` の存在まで見るのが要点。これがないと、アセットをコピーするだけの
build.js があるディレクトリ配下の HTML を全部誤判定する。

判定された生成物は**候補から消さずに、スコアを最低にして残す**。「ここにも同じ文字列がある」
という情報自体は AI にとって有用なため。

### 4. 順位を付ける

`*.json` / `*.md` > `*.js` > `template_*.html` > 普通の `.html` > `.php` > `.css` > 生成物。
これに**表示中のページとのパスの近さ**（共通する親ディレクトリの数）を足す。
`鈴木 義叶` のようにサイト中に散在する文字列で、見ているページの近くが上に来るようにするため。

## ライブ中継（DB / ログインが要る PHP ページ）

`webpin --live https://example.com` で、**手元で動かせない PHP を本番に任せる**。
DB が本番サーバーからしか繋がらない構成では、ローカルで再現する方法が無いため。

配信の振り分けは1つのルールだけ:

> `.php` に解決されるリクエストと、**手元に無いファイル**は本番へ。
> 手元にある静的ファイルはローカルから返す。

本番の HTML を見ながら、CSS / JS の編集結果はその場で反映されることになる。
ライブ中は PHP を本番が実行するので `php -S` は立てない
（PHP がリポジトリ内にセッションファイルを書き出すのを避ける意味もある）。

中継時に手を入れるヘッダ（`lib/live.js`）:

| ヘッダ | 何をするか | 理由 |
|---|---|---|
| `Set-Cookie` | `Domain=` と `Secure` を落とし、`SameSite=None` を `Lax` に | localhost にセッション Cookie を残すため。これが無いとログインが維持できない |
| `Origin` / `Referer` | 本番のオリジンに書き換え | Origin を見る CSRF 対策に弾かれないため |
| `Location` | 本番のオリジンを localhost に戻す | 中継の外に出てしまうため |
| `Accept-Encoding` | `identity` を要求 | gzip されると HTML にオーバーレイを差し込めない |
| CSP / HSTS / `X-Frame-Options` | 落とす | 注入したスクリプトを止めうる。HSTS が localhost に残ると面倒 |

設定（中継先）は**リポジトリではなくキャッシュ側**（`~/.cache/webpin/<...>/config.json`）に持つ。
リポジトリが丸ごと公開ディレクトリにコピーされる構成のサイトもあるため。

ライブ中のページに対する文字の書き換えは、**ソースは直るが画面は変わらない**
（見ているのは本番の HTML なので反映はデプロイ後）。誤解しないよう、
注入時に `window.__webpinLive` を立てて、オーバーレイのトーストでその旨を出す。

## 自動で書き換える条件

次を**すべて**満たすときだけファイルを書き換える。1つでも外れたら指摘として残す。

1. 生成物でないソース候補が1つに絞れる
2. そのファイル内での一致が1箇所だけ
3. 文字列が十分長い（ASCII 8文字以上 / 日本語 4文字以上）
4. 一致箇所が素直な文字列の中にある
   - `.html` / `.php` … `<` `>` を含まず、直前の非空白が `>`、直後が `<`
   - `.js` / `.json` … 単一のクォート文字列の中で、`\` や `${` を含まない
   - `.md` … 制限なし

書き込むときは形式に合わせて再エスケープする（HTML なら `& < >`、JS/JSON ならクォートと `\`）。

**バックアップは取らない。** プロジェクトは git 管理下にあり、指摘にも変更前後が残るため。

## 多言語ページの扱い

アプリ紹介ページは `pathname` に `/jp/` が含まれるかで言語が決まる（`assets/js/main.js`）。

- 日本語を直す → `translations.js` の `ja` だけを書き換える
- 英語を直す → `translations.js` の `en` **と** `template_*.html` の直書き英文を両方書き換える
  （テンプレート側は JS 実行前の初期表示と SEO の実体なので、放置すると古い文言が残る）

もう一方の言語は**機械的に上書きせず**、「訳し直す」という指摘を作って AI に渡す。

## 保存形式

`~/.cache/webpin/<プロジェクト名>-<sha1先頭10桁>/notes.jsonl`。

追記専用。`{"type":"note",...}` / `{"type":"done",...}` / `{"type":"drop",...}` を並べ、
読むときに畳んで現在の状態にする。サーバーと CLI（スキル）が同時に触っても壊れない。

スクリーンショットは同じディレクトリの `shots/<timestamp>.png`。

## スクリーンショット

**実際に開いているタブをそのまま撮る**。ヘッドレスで開き直す方式ではダイアログを開いた状態・
スクロール位置・スクロール連動アニメーションの適用後が再現できず、
「完成品を見てから指示する」という目的に合わないため。

Chrome の `--remote-debugging-port` に繋ぎ、`Page.captureScreenshot` に
`clip`（ページ座標系）と `captureBeyondViewport: true` を渡す。切り出しは Chrome 側がやる。

WebSocket は `net` + `crypto` で必要な部分だけ実装している（`lib/cdp.js`、約130行）。
撮影の直前にオーバーレイを `display:none` にして2フレーム待ち、写り込みを防ぐ。

CDP に繋がらないときは画像なしで続行し、矩形の座標と範囲内の要素一覧だけを記録する。
