# 双端标签发布

发布由父仓库 `AliceJump/ok-lang-hints` 统一协调。普通提交和手动运行不会发布；只有首次推送匹配版本的标签会运行 Release：

```text
vMAJOR.MINOR.PATCH
```

## 一次性配置

所有 Secret 都添加到父仓库：

**Settings → Secrets and variables → Actions → New repository secret**

### Visual Studio Marketplace

推荐配置 Visual Studio Marketplace 的 **Trusted Publishing/OIDC**，无需保存长期 Secret：

1. 进入 Visual Studio Marketplace 的 Publisher/扩展管理页面。
2. 为 `AliceJump.ok-lang-hints` 添加 Trusted Publishing policy。
3. GitHub 仓库填写 `AliceJump/ok-lang-hints`，工作流填写 `release.yml`，环境按 Marketplace 页面要求填写或留空。
4. 在父仓库 **Settings → Secrets and variables → Actions → Variables** 添加 `VSCE_USE_OIDC=true`。
5. 标签工作流已授予 `id-token: write`，未配置 `VSCE_PAT` 且该变量为 `true` 时会执行 `vsce publish --oidc`。

如暂时继续使用 PAT，则添加 Secret：`VSCE_PAT`

1. 打开 Azure DevOps 的 Personal Access Tokens 页面。
2. 新建 Token，Organization 选择 **All accessible organizations**。
3. 选择 **Custom defined**，展开所有权限，仅勾选 **Marketplace → Manage**。
4. 创建后立即复制 Token，保存为 `VSCE_PAT`。
5. 确保创建 Token 的账号是 Visual Studio Marketplace Publisher `AliceJump` 的成员。

目前仓库已经配置该 Secret，可作为 OIDC 配置完成前的回退。Microsoft 已宣布全局 PAT 将于 2026-12-01 退役，应尽快迁移到 Trusted Publishing/OIDC。

### JetBrains Marketplace 首次上架

第一次必须手动创建插件：

1. 登录 https://plugins.jetbrains.com/author/me 。
2. 选择 **Add new plugin**。
3. 在本地构建 ZIP：`cd jetbrains && ./gradlew buildPlugin`。
4. 上传 `build/distributions/ok-lang-hints-jetbrains-<version>.zip`。
5. 确认 Plugin XML ID 是 `com.alicejump.oklanghints`，完成许可、源码、问题反馈等资料并提交审核。

第一次创建成功之后，标签工作流才能通过 API 上传后续版本。

### JetBrains 发布 Token

Secret：`JETBRAINS_PUBLISH_TOKEN`

1. 打开 https://plugins.jetbrains.com/author/me/tokens 。
2. 选择 **Generate Token**，输入名称。
3. 立即复制只显示一次的永久 Token。
4. 保存为父仓库 Secret `JETBRAINS_PUBLISH_TOKEN`。

### JetBrains 签名密钥

Secrets：

- `JETBRAINS_PRIVATE_KEY`
- `JETBRAINS_PRIVATE_KEY_PASSWORD`
- `JETBRAINS_CERTIFICATE_CHAIN`

使用 OpenSSL 生成：

```bash
openssl genpkey -aes-256-cbc -algorithm RSA \
  -out private_encrypted.pem -pkeyopt rsa_keygen_bits:4096
openssl rsa -in private_encrypted.pem -out private.pem
openssl req -key private.pem -new -x509 -days 365 -out chain.crt
```

- `JETBRAINS_PRIVATE_KEY`：`private.pem` 的完整文本。
- `JETBRAINS_PRIVATE_KEY_PASSWORD`：第一条命令设置、第二条命令使用的密码。
- `JETBRAINS_CERTIFICATE_CHAIN`：`chain.crt` 的完整文本。

GitHub Secret 支持多行文本，可直接粘贴 PEM/CRT 全文；也可先 Base64 编码为单行。不要提交私钥、证书或密码。证书到期前需生成新证书并更新对应 Secrets。

## 每次发布

例如发布 `0.6.0`：

```bash
# 1. 同步 VS Code、lockfile、JetBrains 三处版本
npm run version:sync -- 0.6.0

# 2. 验证
npm test
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
cd ..

# 3. 先提交子仓库版本变更
cd jetbrains
git add .
git commit -m "chore(release): prepare v0.6.0"
git push origin main
cd ..

# 4. 再提交父仓库版本和子模块指针
npm run verify:version
git add package.json package-lock.json jetbrains
git commit -m "chore(release): prepare v0.6.0"
git push origin main

# 5. 唯一发布动作：创建并推送新标签
git tag -a v0.6.0 -m "Release v0.6.0"
git push origin v0.6.0
```

标签发布会依次：

1. 检出父仓库和固定的 JetBrains 子模块提交。
2. 校验三处版本与标签完全一致。
3. 测试并构建 VSIX。
4. 测试、验证、构建并按 Secret 签名 JetBrains ZIP。
5. 创建一个 GitHub Release，附带两个安装包。
6. 有 `VSCE_PAT` 时发布 Visual Studio Marketplace。
7. 有完整 JetBrains Token 和签名 Secrets 时发布 JetBrains Marketplace。

## 失败处理

- 不要移动或强制覆盖已经推送的标签。
- 标签构建失败时，修复后提升补丁版本，例如从 `0.6.0` 改为 `0.6.1`，再推送新标签。
- 标签和 GitHub Release 都不可复用；两个 Marketplace 也拒绝重复版本。
- 如果只缺 Marketplace Secret，GitHub Release 仍会创建并提供两个离线安装包。
