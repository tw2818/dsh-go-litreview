# dsh-go-litreview

DSH GO 手机端的**文献检索**原生插件：把 Sci-Hub、PubMed、OpenAlex 三个文献源合成一个面板。

检索框里填关键词或 DOI → 一次搜完三个源 → 命中列表里点某一条，会把「去取全文」的指令放进对话输入框，交给模型用同一批 MCP 工具读全文、下载 PDF、做总结。面板本身只负责找和递，不替模型干活。

## 功能

- **三个源合并检索**：Sci-Hub（命中即有 PDF）、PubMed（标题/作者/PMID）、OpenAlex（引用数/开放获取线索）
- **DOI 直取 PDF**：按 DOI 下载，存到手机存储 `/sdcard/Download/DSH-Go`
- **一键转交**：点中一条 → 指令进输入框 → 模型接着取全文、翻译、总结
- **原生界面**：输入框上方的「文献」按钮打开面板，状态条常驻显示当前命中情况

## 依赖

插件起三个 MCP 子进程，路径写死在 `lib/sources.js` 的 `SERVERS` 里：

| 源 | 进程 | 备注 |
| --- | --- | --- |
| Sci-Hub | `/usr/local/bin/python3` + `/root/.dsh/mcp/sci-hub-mcp-server/sci_hub_server.py` | 本机 Sci-Hub MCP |
| PubMed | `/opt/node/bin/node` + `/usr/local/lib/node_modules/@cyanheads/pubmed-mcp-server/dist/index.js` | PubMed MCP |
| OpenAlex | `/opt/python/bin/openalex-mcp` | MCP 限流时不返回，插件会自动走 REST 兜底 |

OpenAlex 的 API key 可选，从凭据库读 `OPENALEX_API_KEY`；没有也能用，只是额度小。

**换机器时**：改 `lib/sources.js` 里 `SERVERS` 的 `command` / `args` / `cwd` 指向你自己的 MCP 服务器即可，其余代码不用动。

## 安装

```bash
dsh plugin --profile web add github:tw2818/dsh-go-litreview
```

然后在 profile 的 `package.json` 里把 bundle 名加进 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": ["dsh-go-litreview", ...] } }
```

bundle 名和 `package.json` 的 `name` 保持一致（`dsh-go-litreview`）。最后**重启引擎**生效。

## 说明

- 插件不上传任何数据到第三方：检索请求直接发给上面三个源。
- 密钥不写进代码，只在请求时从凭据库读一次。

## 许可

MIT，见 [LICENSE](LICENSE)。
