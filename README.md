起動
```bash
npm run dev
```

停止
```bash
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```
