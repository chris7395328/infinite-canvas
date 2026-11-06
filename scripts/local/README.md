# Windows 本机部署与原浏览器数据

双击项目根目录的 `启动本机画布.cmd`。需要 Node.js、npm、Git for Windows（附带 OpenSSL）；首次需要联网安装与 Docker 相同的 Bun 1.3.13 和锁定依赖，在 `.runtime/local/builds/` 独立构建当前代码。之后未修改构建输入时直接启动，不使用旧的 `web/dist` 冒充新版本，也不删除原开发依赖。依赖缓存和旧构建会占本机磁盘，停止服务后可以自行清理不再使用的构建目录，不要删除浏览器备份或仍在用的构建。

## 原地址与旧数据

本启动器专用于原地址 **https://192.168.123.232:3001**。浏览器数据库按协议、主机、端口和用户配置隔离；普通 localhost 页面无法读取这个地址的 IndexedDB。群晖不用开机：Edge 的精确主机端口映射把旧地址连接到本机 `127.0.0.1:3001`，页面 URL 仍是旧地址。

首次必须自行保存并完全退出 Edge，包括后台进程。启动器不会强关、清理浏览器或修改系统 IP、hosts、全局代理。它使用原 `%LOCALAPPDATA%\Microsoft\Edge\User Data`，不新建空白配置。若有多个 Edge 用户，请切换到原来使用的用户；也可运行 `start-local-canvas.ps1 -EdgeProfile "Profile 1"` 指定原配置目录名。不要使用访客或 InPrivate。若页面空白，先核对用户配置，不能据此断定旧数据丢失，更不要清理浏览器。

打开前会在 Edge 完全退出的情况下，仅复制该地址对应的 IndexedDB leveldb/blob 目录到 `data/local-browser-backup/`，不会复制其他站点、读取或打印配置内容。备份成功后不重复覆盖；此文件级备份不是完整的浏览器备份，不包括 localStorage、其他分区或群晖任务文件。备份可能包含 API 配置和素材，只留在本机，禁止提交或分享。首次未找到标准目录时会提示，不能保证旧数据仍存在；实际读取需要原浏览器验收。

本机生成的 HTTPS 私钥位于 `.runtime/local/`，仅当前 Windows 用户和 SYSTEM 可访问。Edge 仅为这张证书的 SPKI 指纹设置证书错误例外，不使用全局 `--ignore-certificate-errors`，也不向系统信任库安装证书。此模式属于本机恢复启动方式，不是公网 HTTPS 方案。映射及证书例外只在这次 Edge 进程有效；完全退出后正常启动 Edge 不再使用它们。启用原地址代理的 VPN/浏览器扩展可能影响映射，若仍连接群晖请检查其对这个地址的代理规则。

## 功能与文件

- 构建同一套 `web/` 源码；通过同域 `/canvas-proxy` 使用同一个 `canvas-proxy`，包括各模型脚本、COS、私域素材库、腾讯 VOD、后台任务及错误详情。不会改写已有渠道或上传浏览器数据。
- 网页关闭后，只要本机 Node 进程运行且电脑未休眠，已接收任务仍继续；电脑关机或休眠不能继续计算或等待。旧群晖的运行中任务和仅在群晖暂存的文件不能从浏览器自动搬回。
- 新任务结果在 `task-data/local/`，采用既有固定24小时终态保留、领取不提前删除策略，不设应用层容量上限。网页画布和媒体仍在浏览器，不自动变成服务器数据库。
- 日志在 `.runtime/local/server.stdout.log`、`server.stderr.log`；日志、私钥、备份和任务目录均不提交 Git。
- 仅监听 `127.0.0.1`，不向局域网或公网开放。API 请求及渠道服务仍需正常联网。
- 浏览器打开后建议尽快再用画布自带导出功能备份重要项目和配置；配置导出包含密钥，妥善保管。

## 更新与停止

重新双击会检查服务身份及当前构建指纹，不能把其他占用3001端口的程序当成本项目。源码变化时自动构建；若旧服务运行中则提示，不强行中断生成。

在所有任务结束后，双击 `停止本机画布.cmd` 并输入 STOP。它核对记录的 PID、Node 路径及当前启动脚本，只停止这一个后台，不停止其他 Node 或 Edge、不删除素材；然后可以双击启动入口重开。不改 Compose，不推送 Docker 镜像，不修改现有 `start-infinite-canvas.ps1`。

只启动本机服务而暂不打开浏览器：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-local-canvas.ps1 -NoBrowser`。

实现依据：[Chromium 精确端口映射](https://chromium.googlesource.com/chromium/src/+/main/net/base/host_mapping_rules_unittest.cc)、[证书公钥指纹例外](https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/network_switches.cc)。Windows/Edge 政策可能禁止启动参数，需以实际浏览器验收为准。
