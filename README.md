B4 へ
精読・詳細な和訳用なので，深堀の質問とかの機能はまだ実装してないです．
どんどん便利にしてね．

初回は，ローカルの好きなところで以下を実行
```bash
git clone https://github.com/Shunya-OMORI/handmade-readable.git
```
クローンされたリポジトリを VSCode で開いてください．
リポジトリのルート（handmade-readable ディレクトリを開いたすぐ中の階層）に
.env
という名前のファイルを作り，そこに
```
GEMINI_API_KEY=自分のAPIキー
```
を書き込んでください．

同様に，リポジトリのルートに papers という名前のフォルダを作り，
その中に論文の pdf をぶち込んでいってください．

起動前に依存関係を入れてください
```bash
npm install
```


起動方法
```bash
npm run dev
```

ブラウザや VSCode で http://127.0.0.1:5173 を開いてください。

停止方法
```bash
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

変更をシェアしてくれる場合
手元にある変更を一時退避
```bash
git stash save -u
```
github 上の最新の main ブランチをおろしてくる
```bash
git pull origin main
```
新しいブランチを最新の main から切るとともにそのブランチへ移動する
```bash
git checkout -b feat_hogehoge
```
退避していた変更を取り出す
```bash
git stash pop
```
変更をステージ
```bash
git add .
```
コミットを作成
```bash
git commit -m "[feat] hogehoge 機能の追加"
```
作ったブランチへコミットをプッシュ
```bash
git push origin feat_hogehoge
```

そこからは github 上でプルリクエストを作ってください（やり方は push すればわかるかもしれませんが，わからなければ調べたり聞いてください）．
https://github.com/Shunya-OMORI/handmade-readable

俺がコードレビューして問題なさそうなら適用します．