# screen-control —— DSH 屏幕操作 Agent 预设

一个独立的 DSH **Agent 预设**（preset），让 Agent 直接操作真实桌面：截取真实屏幕、
叠加真实坐标网格、识图定位、**打红色准星校验落点**，通过后才模拟鼠标键盘，每轮结束清理全部截图。
每次输入之后，它必须**重新做一次全屏截图**确认最终状态；放大图只用于定位，不算确认。

<p align="center"><b>核心承诺：不允许出现"点偏点错"。</b></p>

---

## 它能做什么

十个原子能力（由预设内置的插件提供，**只对该预设的 Agent 可见**）：

| 能力 | 工具 | 保证 |
|---|---|---|
| 全屏截图 | `screen_capture` | GDI `BitBlt` 从屏幕 DC 取**合成后画面**（等效 PrtSc），非窗口句柄、非重绘。**它也是唯一的确认帧**：截图会清空"未确认输入"账本并指明它确认了哪次输入 |
| 叠加网格 | `screen_overlay_grid` | 每条线标注**真实桌面坐标**；短边 <1080 取 50px，否则 100px |
| 区域放大 | `screen_zoom` | 一个桌面像素变 N 个图像像素，且**不会被后续压缩缩回去**。**它只是定位用的放大镜**：只覆盖一个矩形，绝不作为判断屏幕状态或确认输入结果的依据 |
| 像素测量 | `screen_probe` | 从原始像素切分元素，返回**精确桌面中心 + 配色构成**（两轴都实测） |
| 压缩 | `screen_compress` | 长边 >1920 → 1280，否则 1600；已达标则不压 |
| 记录识图结果 | `screen_ask_ai` | 记录目标与图像像素坐标；**不调用第二个模型** |
| 坐标换算 | `screen_map_to_screen` | `desktop = image / scale + origin`，副屏负坐标保留符号 |
| **准星校验** | `screen_mark_verify` | 在将点击的位置画红十字并测量；**不可跳过** |
| 模拟输入 | `screen_do` | click/双击/右键/drag/scroll/key_type/key_press；前后 150–300ms 稳定间隔 |
| 清理 | `screen_cleanup_round` | 删除本轮全部图片并二次确认，残留即报错 |

---

## 安装

> **重要**：这是 DSH **预设**，必须放到 `${DSH_HOME:-%USERPROFILE%\.dsh}\.agent-presets\` 下才会被发现。
> `dsh plugin add` 装的是 profile 的 npm 依赖，**不会**把包安装成预设 —— 原因见下方"为什么不能只用 dsh plugin add"。

### 方式一：一键脚本（推荐）

下载本仓库后，在仓库根目录执行：

**Windows (PowerShell)**
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**Linux / macOS**
```bash
./install.sh
```

脚本做两件事：把 `preset/` 复制到 `.agent-presets/screen-control/`，然后校验文件齐全。
完成后**重启 DSH**，新开会话时在预设选择器里选「屏幕操作」。

### 方式二：手动复制

```powershell
# Windows
xcopy /E /I /Y preset "%USERPROFILE%\.dsh\.agent-presets\screen-control"
```
```bash
# Linux / macOS
cp -r preset "${DSH_HOME:-$HOME/.dsh}/.agent-presets/screen-control"
```

### 方式三：git clone + 脚本

```bash
git clone https://github.com/<你的用户名>/<仓库名>.git
cd <仓库名>
./install.sh          # 或 Windows 下 .\install.ps1
```

---

## 为什么不能只用 `dsh plugin add`

`dsh plugin --profile web add <包>` 的实际行为是**把参数转发给 profile 目录里的 pnpm**：

```
~/.dsh/profiles/web/  →  pnpm add <包>
```

它把包装进 `profiles/web/node_modules/`。而 DSH 的预设发现逻辑只扫描**配置好的预设根目录**
（默认是部署自带的 `presets/` 和用户目录下的 `.agent-presets/`），**不扫描 `node_modules`**。
所以 `dsh plugin add` 装上去了，预设选择器里也不会出现「屏幕操作」。

如果你的部署**确实**把预设根配置到了别处，把 `preset/` 的内容放到那个根下的 `screen-control/` 即可。

---

## 前置条件

| 项 | 要求 |
|---|---|
| DSH | 已安装并能正常启动（本预设基于 `0.1.5-rc.2` 开发） |
| 平台 | **Windows**（插件直接调用 Win32：`user32.dll` / `gdi32.dll` / `shcore.dll`） |
| 原生依赖 | `koffi` 与 `sharp` —— 二者随 DSH 一起安装，插件从**宿主安装位置**解析，无需你手动装 |
| 权限 | 与 DSH 进程同级。**以管理员运行的程序会被 UIPI 拦截**，插件会如实报错而非假装成功 |

---

## 使用

1. 重启 DSH
2. 新建会话，在预设选择器里选 **「屏幕操作」**
3. 直接用自然语言下达任务，例如：

```
打开B站
把浏览器窗口关掉
在这个网页搜索"xxx"，打开第一条结果
```

Agent 会自行走完这条流水线：

```
screen_capture → screen_overlay_grid → screen_compress
   → （小图标先 screen_probe 量，或 screen_zoom 放大看清）
   → screen_ask_ai → screen_map_to_screen
   → screen_mark_verify（画准星、你/它都能看到落点）
   → screen_do
   → screen_capture（**重新全屏截屏，确认点击后的最终状态**）
   → screen_cleanup_round
```

---

## 截图存放

**唯一写入位置**：

```
%USERPROFILE%\.dsh\.agent-presets\screen-control\screenshots\
```

命名 `r{轮次}_{阶段}_{时间戳}.png`。桌面、Temp、用户目录一律不写。
每轮结束由 `screen_cleanup_round` 删除并二次确认残留为 0。

---

## 安全设计（为什么不容易点错）

| 机制 | 作用 |
|---|---|
| **强制 Per-Monitor-V2 DPI 感知** | 采集、度量、合成坐标统一在**物理像素**空间。不做的话 175% 缩放下每次点击落到 57% 位置 |
| **准星校验不可跳过** | `screen_do` 拒绝没有新鲜校验的点击；校验是**一次性令牌**，连 `dry_run` 也消耗它 |
| **点击用已校验坐标** | 指针动作忽略传入坐标，只用 `screen_mark_verify` 记录的那个点 |
| **光标回读** | 按下前 `GetCursorPos` 复核；不在目标像素就拒绝，并回退 `SetCursorPos` 修正 |
| **指纹漂移检查** | 校验后、点击前重测目标处 16×16 亮度指纹；画面变了就拒绝 |
| **几何闸门** | 分辨率/DPI/显示器数量变化立即失效整轮，要求重新截图 |
| **贴边拒绝** | 距屏幕边缘过近的目标直接拒绝——被裁切的准星测不准中心 |
| **键盘无需坐标** | 按键发给焦点窗口，不需要坐标校验；但会报告**焦点窗口所属进程**供核对 |
| **点击后回报反应** | 报告目标处界面是否真的变化；"什么都没变"作为结果交出，不粉饰成功 |
| **会话隔离** | 预设是共享挂载，但回合状态按会话键控；一个会话的令牌与清理不影响另一个 |
| **输入后必须确认** | 每次 `screen_do` 投递输入后即记为"未确认"，只有**全屏** `screen_capture` 能清账；`screen_cleanup_round` 在未确认时直接拒绝结束本轮 |
| **放大图不算确认** | `screen_zoom` 是定位放大镜（只覆盖一个矩形），**永不清账**，既不能用于判断屏幕状态，也不能替代点击后的结果确认 |

---

## 已实测 / 未实测

**已实测**（真实任务，非单元测试）

- 完整任务链：打开B站 → 挑视频 → **两帧对比确认播放** → 滚轮翻评论 → 关闭窗口
- **两个分辨率下各跑通一次**（2560×1600 与 2560×1440，DPI 168 / 1.75x）
- 图像以 **image block** 投递到模型（非 base64 文本）
- 跨会话隔离、准星两轴测量、几何闸门、全部拒绝路径

**未实测**（诚实标注）

- **多显示器负坐标** —— 开发机只有单屏，`origin` 负值路径从未真实运行
- **高权限窗口（UIPI）** —— 从未遇到，报错路径未经验证
- **亮色网页上的 `screen_probe`** —— 已知会把整张卡片识别成一个块；这是边界，不是通用工具
- **输入后强制确认（v1.1.0 新增）** —— 逻辑已用桩化的 Win32 层跑过完整行为验证（点击 → 拒绝清理 → 全屏确认 → 放行 → `skip_confirmation` 留痕），但**尚未在真实桌面上跑过真实点击**；有问题请反馈

---

## 目录结构

```
.
├── README.md
├── LICENSE
├── package.json
├── SPEC.md              # 完整设计与实现说明
├── install.ps1
├── install.sh
├── 安装说明.txt          # 纯文本安装说明（含常见问题）
└── preset/              # ← 复制这个目录到 .agent-presets/screen-control/
    ├── agent.cordis.yml
    ├── preset.yml
    ├── SPEC.md
    └── screen-control-plugin/
        └── plugin/
            ├── index.mjs
            ├── deps.mjs
            ├── delivery.mjs
            ├── imaging.mjs
            ├── round.mjs
            ├── tools.mjs
            └── win32.mjs
```

---

## 许可

MIT
