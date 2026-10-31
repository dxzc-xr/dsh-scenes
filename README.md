# dsh-scenes

把「场景」做成一等公民的 [DeepSeek Harness][dsh] 插件：一个场景 = 一个独立工作目录 + 一份独立记忆 + 一套和其它场景交接的机制。

适合「一台机器上同时跑多个职责不同的常驻助手，彼此能派活」这种用法。

> 私有记忆直接复用姊妹项目 [dsh-memory](../dsh-memory) 的「项目记忆」机制（按 cwd 归一化落盘），不另造一套存储。

## 核心概念

| 概念 | 落地方式 |
|---|---|
| **场景** | 一个 DSH workspace（独立 cwd）。侧栏自然按场景分区 |
| **场景私有记忆** | dsh-memory 的项目记忆，按 cwd 归一化，天然互不混淆 |
| **交接** | 一个共享的交接队列文件 + `scene_handoff` / `scene_inbox`。被派单的场景在下一轮第一步自动收到，不打断当前对话 |
| **任务板** | 跨场景共享的待办列表，带依赖（`blocked_by`）与版本号（CAS 更新，防止两个场景互相覆盖） |

## 工具

| 工具 | 作用 |
|---|---|
| `scene_list` | 列出所有场景（id、名称、图标、工作目录、记忆条数、待处理交接数） |
| `scene_handoff` | 把一件事派给另一个场景：`to` + `text`，立即在对方会话里起一轮 |
| `scene_inbox` | 查看本场景收到、尚未处理完的交接 |
| `scene_task_create` | 新建共享任务（可指定 owner、`blocked_by` 依赖、`write_scopes` 写入范围） |
| `scene_task_list` | 按状态 / 归属 / 是否可开工过滤任务板 |
| `scene_task_get` | 读单条任务完整内容（含 revision，改之前先读） |
| `scene_task_update` | 认领 / 释放 / 指派 / 完成 / 重开 / 编辑 / 删除。必须带 `expected_revision`，版本不匹配会被拒绝 |

## 数据文件

```
$DSH_HOME/scenes.json              # 场景注册表（id、名称、cwd、图标、prompt）
$DSH_HOME/scenes/handoffs.json     # 交接队列
```

`$DSH_HOME` 默认 `~/.dsh`，可用环境变量覆盖；注册表路径还可用 `DSH_SCENES_REGISTRY` 单独指定。

## 只读数据接口

Node 半边给客户端暴露两个只读接口：

| 路由 | 内容 |
|---|---|
| `/dsh-scenes/list` | 场景列表 + 每个场景的记忆条数 |
| `/dsh-scenes/memory` | 记忆内容（侧栏预览用） |

客户端半边是 `client/client.js`（`dsh.client.platform = web`），提供场景切换与预览面板。

## 安装

```json
{
  "dependencies": {
    "dsh-scenes": "link:/绝对路径/dsh-scenes"
  }
}
```

`cordis.patch.yml` 负责把插件插进宿主：

```yaml
- insert:
    - id: dsh-scenes
      name: 'dsh-scenes'
```

本包在 profile 里以 `link:` 依赖形式存在，自身路径解析不到 `@deepseek-ai/*`，所以宿主模块一律运行时 import，失败时退回本地等价实现（与 dsh-memory 相同策略）。

## 已知坑

- **本插件只管 DSH 自己的注册表** `~/.dsh/scenes.json`。如果你还有别的系统（比如自建 Web 工作台）也在维护场景列表，删场景时两个地方都要改，否则界面上会残留一个点进去就报错的死场景。
- `scene_task_update` 的删除操作返回值文案可能仍显示旧状态，**以 `scene_task_list` 的实际结果为准**，不要只看返回文本。
- 场景的记忆注入有长度上限（`MAX_INJECT_CHARS` = 4000），交接条目上限 `MAX_HANDOFF_CHARS` = 2000 字。

## License

MIT

[dsh]: https://github.com/deepseek-ai
