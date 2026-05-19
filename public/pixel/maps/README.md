# pixel/maps/

v2.9.0 起, 这里存放跨端共享的 mapConfig 文件:
- `<bgId>.json` 一个背景一份, bgId 白名单: level1 / level2 / level3 / level3.5 / level4 / default
- serve.js 和 vite dev middleware 都会读写这里
- 入 git: 仓库自带的默认地图所有人 clone 即用
- 客户端通过 GET / PUT /api/pixel-maps/<bgId> 访问

旧版 (≤v2.8.x) 用 localStorage 存, 各设备各自一份, 桌面端配的图手机看不到.
v2.9.0 改 server-first + localStorage cache fallback 解决这个问题.
