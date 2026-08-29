package httpapi

const adminConsoleHTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>U-Claw Admin</title>
  <style>
    :root {
      color-scheme: light;
      --blue: #1677ff;
      --green: #23a455;
      --red: #d92d20;
      --text: #1f2937;
      --muted: #667085;
      --line: #d9e2ef;
      --bg: #eef4fb;
      --panel: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    header {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      background: rgba(255,255,255,.94);
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 20px; }
    main { max-width: 1280px; margin: 22px auto; padding: 0 18px 32px; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 16px;
    }
    h2 { margin: 0 0 14px; font-size: 17px; }
    label { display: grid; gap: 6px; color: var(--muted); font-weight: 600; }
    input, select, textarea {
      width: 100%;
      min-height: 40px;
      border: 1px solid #cfd8e3;
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
      background: #fff;
      font: inherit;
    }
    textarea { resize: vertical; min-height: 40px; }
    button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.primary { background: var(--blue); color: #fff; }
    button.primary:hover { background: #0958d9; color: #fff; }
    button.secondary { background: #f4f8ff; color: var(--blue); border-color: #9ec9ff; }
    button.secondary:hover { background: #e6f1ff; color: #0958d9; }
    button.danger { background: #fff4f2; color: var(--red); border-color: #ffb8ad; }
    button.danger:hover { background: #ffe7e2; color: #b42318; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 12px; align-items: end; }
    .span-2 { grid-column: span 2; }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-12 { grid-column: span 12; }
    .toolbar { display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    .notice { margin-top: 12px; color: var(--muted); white-space: pre-wrap; }
    .notice.error { color: var(--red); }
    .codes { display: grid; gap: 8px; margin-top: 12px; }
    .code-line { display: flex; justify-content: space-between; gap: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fbff; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 12px; }
    .badge { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; background: #edf4ff; color: var(--blue); font-weight: 700; }
    .badge.bound { background: #ecfdf3; color: var(--green); }
    .badge.disabled, .badge.reissued { background: #fff1f0; color: var(--red); }
    .row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .empty { padding: 24px; color: var(--muted); text-align: center; }
    @media (max-width: 880px) {
      header { padding: 0 16px; }
      .span-2, .span-3, .span-4, .span-5, .span-6 { grid-column: span 12; }
      table { min-width: 980px; }
      .table-wrap { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>U-Claw 运营后台</h1>
    <span id="status">未连接</span>
  </header>
  <main>
    <section>
      <h2>访问令牌</h2>
      <div class="grid">
        <label class="span-6">Admin Token
          <input id="token" type="password" autocomplete="off" placeholder="输入服务器 ADMIN_TOKEN">
        </label>
        <div class="span-6 toolbar">
          <button class="secondary" id="saveToken">保存</button>
          <button class="secondary" id="clearToken">清除</button>
          <button class="primary" id="refresh">刷新列表</button>
        </div>
      </div>
    </section>

    <section>
      <h2>生成激活码</h2>
      <div class="grid">
        <label class="span-2">数量
          <input id="count" type="number" min="1" max="50" value="1">
        </label>
        <label class="span-3">批次
          <input id="batchName" placeholder="例如 2026-08 首批">
        </label>
        <label class="span-4">备注
          <input id="note" placeholder="渠道、订单或制盘备注">
        </label>
        <label class="span-3">操作人
          <input id="createdBy" placeholder="边城">
        </label>
        <div class="span-12 toolbar">
          <button class="primary" id="generate">生成</button>
        </div>
      </div>
      <div id="generated" class="codes"></div>
    </section>

    <section>
      <h2>激活码库存</h2>
      <div class="grid">
        <label class="span-3">状态
          <select id="statusFilter">
            <option value="">全部</option>
            <option value="unused">unused</option>
            <option value="bound">bound</option>
            <option value="disabled">disabled</option>
            <option value="reissued">reissued</option>
          </select>
        </label>
        <label class="span-2">条数
          <input id="limit" type="number" min="1" max="200" value="50">
        </label>
        <div class="span-7 toolbar">
          <button class="primary" id="load">查询</button>
        </div>
      </div>
      <p id="message" class="notice"></p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:70px">ID</th>
              <th style="width:110px">状态</th>
              <th style="width:150px">手机号</th>
              <th style="width:170px">New API 用户</th>
              <th>New API Base URL</th>
              <th style="width:150px">批次</th>
              <th style="width:180px">创建时间</th>
              <th style="width:160px">操作</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const tokenInput = $("token");
    const savedToken = localStorage.getItem("uclaw_admin_token") || "";
    tokenInput.value = savedToken;

    function token() {
      return tokenInput.value.trim();
    }
    function setStatus(text) {
      $("status").textContent = text;
    }
    function showMessage(text, isError = false) {
      const el = $("message");
      el.textContent = text || "";
      el.classList.toggle("error", Boolean(isError));
    }
    async function api(path, options = {}) {
      if (!token()) throw new Error("请先输入 Admin Token");
      const res = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token(),
          ...(options.headers || {})
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = data?.error?.message || ("HTTP " + res.status);
        throw new Error(message);
      }
      return data;
    }
    function fmtTime(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString();
    }
    function renderRows(codes) {
      const body = $("rows");
      body.innerHTML = "";
      if (!codes.length) {
        body.innerHTML = '<tr><td colspan="8" class="empty">暂无记录</td></tr>';
        return;
      }
      for (const item of codes) {
        const tr = document.createElement("tr");
        const newapi = item.newapiUsername ? item.newapiUsername + (item.newapiUserId ? " #" + item.newapiUserId : "") : "-";
        tr.innerHTML =
          "<td>" + item.id + "</td>" +
          '<td><span class="badge ' + item.status + '">' + item.status + "</span></td>" +
          "<td>" + (item.boundPhone || "-") + "</td>" +
          "<td>" + newapi + "</td>" +
          "<td>" + (item.newapiBaseUrl || "-") + "</td>" +
          "<td>" + (item.batchName || item.batchId || "-") + "</td>" +
          "<td>" + fmtTime(item.createdAt) + "</td>" +
          '<td><div class="row-actions"></div></td>';
        const actions = tr.querySelector(".row-actions");
        const disable = document.createElement("button");
        disable.className = "danger";
        disable.textContent = "禁用";
        disable.disabled = item.status !== "unused";
        disable.onclick = () => disableCode(item.id);
        const reissue = document.createElement("button");
        reissue.className = "secondary";
        reissue.textContent = "重发";
        reissue.disabled = item.status === "bound";
        reissue.onclick = () => reissueCode(item.id);
        actions.append(disable, reissue);
        body.appendChild(tr);
      }
    }
    async function loadCodes() {
      showMessage("");
      const params = new URLSearchParams();
      if ($("statusFilter").value) params.set("status", $("statusFilter").value);
      params.set("limit", $("limit").value || "50");
      const data = await api("/internal/admin/v1/activation-codes?" + params.toString());
      renderRows(data.codes || []);
      setStatus("已连接");
      showMessage("已加载 " + (data.codes || []).length + " 条");
    }
    async function generateCodes() {
      const payload = {
        count: Number($("count").value || 1),
        batchName: $("batchName").value,
        note: $("note").value,
        createdBy: $("createdBy").value
      };
      const data = await api("/internal/admin/v1/activation-codes/generate", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const wrap = $("generated");
      wrap.innerHTML = "";
      for (const item of data.codes || []) {
        const line = document.createElement("div");
        line.className = "code-line";
        line.innerHTML = "<strong>" + item.code + '</strong><button class="secondary">复制</button>';
        line.querySelector("button").onclick = () => navigator.clipboard.writeText(item.code);
        wrap.appendChild(line);
      }
      await loadCodes();
    }
    async function disableCode(id) {
      const reason = prompt("禁用原因", "manual-disable") || "";
      await api("/internal/admin/v1/activation-codes/" + id + "/disable", {
        method: "POST",
        body: JSON.stringify({ reason })
      });
      await loadCodes();
    }
    async function reissueCode(id) {
      if (!confirm("旧码会标记为 reissued，新码只显示这一次。继续？")) return;
      const data = await api("/internal/admin/v1/activation-codes/" + id + "/reissue", { method: "POST", body: "{}" });
      const wrap = $("generated");
      wrap.innerHTML = '<div class="code-line"><strong>' + data.code.code + '</strong><button class="secondary">复制</button></div>';
      wrap.querySelector("button").onclick = () => navigator.clipboard.writeText(data.code.code);
      await loadCodes();
    }
    $("saveToken").onclick = () => {
      localStorage.setItem("uclaw_admin_token", token());
      setStatus(token() ? "Token 已保存" : "未连接");
    };
    $("clearToken").onclick = () => {
      localStorage.removeItem("uclaw_admin_token");
      tokenInput.value = "";
      setStatus("未连接");
    };
    $("refresh").onclick = $("load").onclick = () => loadCodes().catch((err) => showMessage(err.message, true));
    $("generate").onclick = () => generateCodes().catch((err) => showMessage(err.message, true));
    if (savedToken) loadCodes().catch(() => setStatus("Token 待验证"));
  </script>
</body>
</html>`
