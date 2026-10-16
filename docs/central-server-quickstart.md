# MoreThanChat 中心服务器

正式版同时提供 Windows x64 ZIP 和 Linux x64 tar.gz，已包含 Node.js 24.12.0、服务代码与管理工具。解压即可使用，不需要克隆仓库、安装 npm 依赖或另找服务器安装文件。

## 启动

Linux：

```sh
tar -xzf MoreThanChat-central-server-0.4.0-linux-x64.tar.gz
cd MoreThanChat-central-server-0.4.0-linux-x64
./mtc-server.sh init --mode public --port 8787 --name "我的聊天服务器"
./start.sh
./mtc-server.sh status
```

Windows：解压服务器 ZIP，在该目录打开终端：

```bat
mtc-server.cmd init --mode public --port 8787 --name "我的聊天服务器"
start.cmd
mtc-server.cmd status
```

也可直接双击 `start.cmd`，或执行 `./start.sh`。首次自动生成 `server.config.json` 和随机管理员凭据 `admin-token`；默认监听 `0.0.0.0:8787`，使用白名单模式，空白名单拒绝用户连接。想开放测试请执行 `mode public`；私服则先 `whitelist add 用户UID`。重复启动不创建第二个服务。

客户端设置中心地址为 `http://服务器IP:8787`，放行相应防火墙端口。公网长期使用建议配置 HTTPS；随包 `deploy/Caddyfile.example` 可供反向代理参考。管理 CLI 在服务器本机运行，远程管理先 SSH 登录，不需要公开管理员入口。不要分享 `admin-token`。

## 配置与管理

下文以 Linux 为例，Windows 把 `./mtc-server.sh` 换成 `mtc-server.cmd`。

```sh
./mtc-server.sh setup                       # 交互配置；修改监听参数前先停止
./mtc-server.sh config show
./mtc-server.sh stop
./mtc-server.sh config set port 8787
./mtc-server.sh config set name "朋友的小站"
./mtc-server.sh start
./mtc-server.sh restart
./mtc-server.sh status
./mtc-server.sh logs --lines 100
./mtc-server.sh logs --follow                # Ctrl+C 只停止日志跟随，不停止服务
```

启动参数、数据路径与日志路径修改后在下一次启动生效。路径相对于配置文件所在目录；默认分别是 `data/` 和 `logs/`。所有命令支持 `--config /路径/server.config.json`，方便把程序与数据分开部署。`run` 是前台运行方式，适合 systemd 等进程管理器；`start` 在后台运行，关闭当前终端不会停止服务，但不会自动设置开机启动。

## 黑名单与白名单

```sh
./mtc-server.sh mode public                 # 黑名单模式：除黑名单外均可认证
./mtc-server.sh mode private                # 白名单模式：只有白名单可以认证
./mtc-server.sh whitelist list
./mtc-server.sh whitelist add usr_完整64位十六进制UID
./mtc-server.sh whitelist remove usr_完整64位十六进制UID
./mtc-server.sh blacklist list
./mtc-server.sh blacklist add usr_完整64位十六进制UID
./mtc-server.sh blacklist remove usr_完整64位十六进制UID
```

模式在线生效，保存在原数据库中，重启不回退。配置文件中的 `mode` 仅用于第一次创建数据库，当前模式请看 `status`。两份名单在切换模式后保留；加入一份名单会移出另一份，删除指定名单中的 UID 不会误改另一份名单。移除白名单后，在白名单模式不能连接；移除黑名单后，在黑名单模式可重新连接。不再获准的现有会话立即失效。

模式和名单管理不删除用户身份、好友、群或待投递消息，也不改变插件业务。日志记录服务生命周期及管理操作类型，不记录聊天正文、附件、管理员令牌。启动时超过 10 MiB 的旧日志会改名保留；日志和数据备份由服务器维护者管理。

## 更新与已有部署

停止旧服务，保留 `server.config.json`、`admin-token`、`data/`、`logs/`，再运行新目录里的管理工具并指定原配置路径。不要删除旧数据目录，也不要让新旧进程同时访问同一数据库。

旧版直接运行 `server.mjs` 的环境变量部署方式和 `central-access.mjs` / `central-status.mjs` 仍可用。升级已有 systemd 服务时，应保留原环境文件、凭据和数据路径，只更新程序目录；不要在原端口额外运行 `start`。模式以后由管理接口保存，旧环境文件中的初始模式不会覆盖它。可复制一份管理配置并指向现有端口、数据和凭据文件，用 CLI 管理名单和查看状态；原服务的日志仍通过 `journalctl -u more-than-chat -f` 查看。

GitHub 的每个正式版本都应同时包含客户端安装包、客户端 ZIP、两个中心服务器包及 `SHA256SUMS.txt`。只手动下载更新，不内置客户端自动升级。
