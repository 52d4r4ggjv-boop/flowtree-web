# FlowTree 上线清单

## 1. Supabase

1. 新建项目并记录 Project URL。
2. 在 SQL Editor 执行 `supabase-schema.sql`。
3. Authentication > Providers 中启用 Email。
4. Authentication > URL Configuration 中设置正式域名。
5. 开发期可关闭 Confirm email；正式环境建议开启邮箱验证。
6. Project Settings > API 中复制 publishable key；旧项目也可使用 anon key。

## 2. 前端配置

编辑 `cloud-config.js`，只填写 Project URL 和 publishable/anon key。

这些值用于识别 Supabase 项目，不是管理员密钥。真正的数据保护依赖 `supabase-schema.sql` 中的 RLS 策略。

## 3. 部署

这是静态网站，可部署到 Netlify、Vercel、Cloudflare Pages 或对象存储静态托管。

发布目录就是当前 `flowtree-prototype` 目录，不需要构建命令。

部署后至少验证：

1. 新用户注册并完成邮箱验证。
2. 登录后创建任务和记录。
3. 刷新后数据仍存在。
4. 在另一个浏览器登录同一账户能读取数据。
5. 账户 A 无法读取账户 B 的数据。
6. 上传图片后，退出登录时无法直接读取私有文件。

## 4. 正式发布前

- 使用自有域名和 HTTPS。
- 在 Supabase Auth 中只保留实际使用的 Redirect URLs。
- 开启数据库备份并确认保留周期。
- 配置错误监控和隐私政策。
- 不要把 `service_role` key、OpenAI API key 或其他服务器密钥放进前端。
