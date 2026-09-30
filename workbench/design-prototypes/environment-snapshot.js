const environmentSnapshot = {
  "capturedAt": "2026-09-14T05:43:27.685Z",
  "environmentId": "environment.macos/v1",
  "source": "environments/macos.json",
  "components": [
    {
      "id": "workspace",
      "name": "工作区文件",
      "description": "文件新增、修改、删除与内容摘要",
      "adapter": "evaldock.file-sensor",
      "binding": "attempt.workspace",
      "enabled": true,
      "capabilities": [
        "FILE_TYPE",
        "READ_ERRORS",
        "READ_ONLY",
        "SHA256",
        "SNAPSHOT_AFTER",
        "SNAPSHOT_BEFORE",
        "SNAPSHOT_POST_RESET",
        "STABLE_WINDOW",
        "SYMLINK_BOUNDARY"
      ]
    },
    {
      "id": "processes",
      "name": "进程",
      "description": "启动、退出、进程状态与父子关系",
      "adapter": "evaldock.macos-process-sensor",
      "binding": "target.uid.processes",
      "enabled": true,
      "capabilities": [
        "EXECUTABLE",
        "PROCESS_ID",
        "PROCESS_PARENT",
        "PROCESS_STATE",
        "READ_ERRORS",
        "READ_ONLY",
        "SNAPSHOT_AFTER",
        "SNAPSHOT_BEFORE",
        "SNAPSHOT_POST_RESET",
        "START_TIME",
        "USER_ID"
      ]
    },
    {
      "id": "desktop",
      "name": "桌面",
      "description": "前台应用、窗口与截图变化",
      "adapter": "evaldock.macos-desktop-sensor",
      "binding": "environment.desktop",
      "enabled": true,
      "capabilities": [
        "FRONTMOST_APPLICATION",
        "SCREENSHOT",
        "VISIBLE_APPLICATIONS",
        "WINDOW_TITLES"
      ]
    },
    {
      "id": "browser",
      "name": "浏览器",
      "description": "标签页、标题与 URL 变化",
      "adapter": "evaldock.macos-browser-sensor",
      "binding": "environment.browser",
      "enabled": true,
      "capabilities": [
        "ACTIVE_URL",
        "BROWSER_RUNNING",
        "TAB_TITLES",
        "TAB_URLS"
      ]
    },
    {
      "id": "database",
      "name": "数据库",
      "description": "可用性、表结构、查询摘要与服务状态",
      "adapter": "evaldock.database-sensor",
      "binding": "environment.database",
      "enabled": true,
      "capabilities": [
        "DATABASE_AVAILABILITY",
        "QUERY_DIGEST",
        "SCHEMA_STATE",
        "SERVICE_STATE"
      ]
    },
    {
      "id": "network",
      "name": "网络",
      "description": "监听端口与 TCP / UDP 连接",
      "adapter": "evaldock.macos-network-sensor",
      "binding": "environment.network",
      "enabled": true,
      "capabilities": [
        "LISTENING_PORTS",
        "TCP_ENDPOINTS",
        "UDP_ENDPOINTS"
      ]
    },
    {
      "id": "externalApi",
      "name": "外部 API",
      "description": "请求记录、响应状态与内容摘要",
      "adapter": "evaldock.external-api-sensor",
      "binding": "environment.external-api",
      "enabled": true,
      "capabilities": [
        "HTTP_STATUS",
        "MOCK_REQUEST_LOG",
        "RESPONSE_DIGEST",
        "STATE_ENDPOINT"
      ]
    },
    {
      "id": "clipboard",
      "name": "剪贴板",
      "description": "内容摘要与字节长度变化",
      "adapter": "evaldock.macos-clipboard-sensor",
      "binding": "environment.clipboard",
      "enabled": true,
      "capabilities": [
        "BYTE_LENGTH",
        "CONTENT_DIGEST",
        "READ_ONLY"
      ]
    },
    {
      "id": "application",
      "name": "应用程序",
      "description": "安装目录及运行应用变化",
      "adapter": "evaldock.macos-application-sensor",
      "binding": "environment.application",
      "enabled": true,
      "capabilities": [
        "APPLICATION_PATHS",
        "INSTALLED_APPLICATIONS",
        "RUNNING_APPLICATIONS"
      ]
    },
    {
      "id": "system",
      "name": "系统",
      "description": "系统版本、服务、时区与语言配置",
      "adapter": "evaldock.macos-system-sensor",
      "binding": "environment.system",
      "enabled": true,
      "capabilities": [
        "BOOT_TIME",
        "BREW_SERVICES",
        "LOCALE",
        "OS_VERSION",
        "TIMEZONE"
      ]
    }
  ]
};
