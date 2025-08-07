# Model Creator 插件安装指南

## 开发环境安装

### 1. 安装Node.js
确保您的系统已安装Node.js (版本 16 或更高)

### 2. 安装依赖
```bash
npm install
```

### 3. 编译插件
```bash
npm run compile
```

### 4. 打包插件
```bash
npm run package
```

## 在VSCode中安装插件

### 方法1: 从VSIX文件安装
1. 运行 `npm run package` 生成 `.vsix` 文件
2. 在VSCode中按 `Ctrl+Shift+P`
3. 输入 "Extensions: Install from VSIX"
4. 选择生成的 `.vsix` 文件

### 方法2: 开发模式运行
1. 在VSCode中按 `F5` 启动调试
2. 这会打开一个新的VSCode窗口，其中包含您的插件

## 使用方法

1. 打开一个 `Config_*.h` 文件（如 `Config_PGEL.h`）
2. 右键点击文件或编辑器
3. 选择 "创建新机型"
4. 按照提示选择参考机型和输入新机型名称

## 测试插件

1. 打开 `test/Config_PGEL.h` 文件
2. 右键选择 "创建新机型"
3. 选择任意一个现有机型作为参考
4. 输入新机型名称（如 `PGEL_KFW72C_4_12K_3S_001`）
5. 查看文件是否正确插入了新配置

## 故障排除

### 编译错误
- 确保已安装所有依赖: `npm install`
- 检查TypeScript版本: `npx tsc --version`

### 插件不工作
- 确保文件名为 `Config_*.h` 格式
- 检查文件是否包含有效的机型定义
- 查看VSCode的输出面板中的错误信息

### 权限问题
- 确保对目标文件有写入权限
- 在Windows上可能需要以管理员身份运行VSCode
