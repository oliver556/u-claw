package httpapi

const adminConsoleHTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>U-Claw Admin</title>
  <style>
    :root {
      --blue: #1677ff;
      --blue-dark: #0958d9;
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
    main { max-width: 1380px; margin: 22px auto; padding: 0 18px 32px; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 16px;
    }
    h2 { margin: 0 0 14px; font-size: 17px; }
    label { display: grid; gap: 6px; color: var(--muted); font-weight: 600; }
    input, select {
      width: 100%;
      min-height: 40px;
      border: 1px solid #cfd8e3;
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
      background: #fff;
      font: inherit;
    }
    button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { cursor: not-allowed; opacity: .48; }
    button.primary { background: var(--blue); color: #fff; }
    button.primary:hover { background: var(--blue-dark); color: #fff; }
    button.secondary { background: #f4f8ff; color: var(--blue); border-color: #9ec9ff; }
    button.secondary:hover { background: #e6f1ff; color: var(--blue-dark); }
    button.danger { background: #fff4f2; color: var(--red); border-color: #ffb8ad; }
    button.danger:hover { background: #ffe7e2; color: #b42318; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 12px; align-items: end; }
    .span-2 { grid-column: span 2; }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .toolbar { display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    .auth-panel { max-width: 520px; margin: 80px auto; }
    .hidden { display: none !important; }
    .notice { margin-top: 12px; color: var(--muted); white-space: pre-wrap; }
    .notice.error { color: var(--red); }
    .codes { display: grid; gap: 8px; margin-top: 12px; }
    .code-line { display: flex; justify-content: space-between; gap: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fbff; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fbfdff; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 12px; }
    .badge { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; background: #edf4ff; color: var(--blue); font-weight: 700; }
    .badge.bound { background: #ecfdf3; color: var(--green); }
    .badge.disabled, .badge.reissued { background: #fff1f0; color: var(--red); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); }
    .row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .empty { padding: 24px; color: var(--muted); text-align: center; }
    @media (max-width: 980px) {
      header { padding: 0 16px; }
      .span-2, .span-3, .span-4, .span-5, .span-6, .span-8 { grid-column: span 12; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      table { min-width: 1180px; }
      .table-wrap { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>U-Claw 运营后台</h1>
    <div>
      <span id="userLabel">未登录</span>
      <button class="secondary hidden" id="logout">退出</button>
    </div>
  </header>
  <main>
    <section id="authPanel" class="auth-panel">
      <h2 id="authTitle">登录</h2>
      <div class="grid">
        <label class="span-12">账号
          <input id="username" autocomplete="username" placeholder="admin">
        </label>
        <label class="span-12">密码
          <input id="password" type="password" autocomplete="current-password" placeholder="至少 8 位">
        </label>
        <label id="bootstrapWrap" class="span-12 hidden">初始化令牌
          <input id="bootstrapToken" type="password" autocomplete="off" placeholder="首次注册时填写 ADMIN_TOKEN">
        </label>
        <div class="span-12 toolbar">
          <button class="primary" id="login">登录</button>
          <button class="secondary hidden" id="register">首次注册</button>
        </div>
      </div>
      <p id="authMessage" class="notice"></p>
    </section>

    <div id="appPanel" class="hidden">
      <section>
        <div class="metric-grid">
          <div class="metric"><span class="muted">全部</span><strong id="mAll">0</strong></div>
          <div class="metric"><span class="muted">未激活</span><strong id="mUnused">0</strong></div>
          <div class="metric"><span class="muted">已绑定</span><strong id="mBound">0</strong></div>
          <div class="metric"><span class="muted">不可用</span><strong id="mClosed">0</strong></div>
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
        <h2>激活码列表</h2>
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
                <th style="width:180px">激活码</th>
                <th style="width:105px">状态</th>
                <th style="width:150px">激活账号</th>
                <th style="width:160px">New API 账号</th>
                <th>New API Base URL</th>
                <th style="width:155px">批次</th>
                <th style="width:165px">激活流程</th>
                <th style="width:170px">创建时间</th>
                <th style="width:160px">操作</th>
              </tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    let sessionToken = localStorage.getItem("uclaw_admin_session") || "";
    let username = localStorage.getItem("uclaw_admin_username") || "";

    function authHeader() {
      return { "Authorization": "Bearer " + sessionToken };
    }
    function setLoggedIn(name) {
      username = name || username;
      $("authPanel").classList.add("hidden");
      $("appPanel").classList.remove("hidden");
      $("logout").classList.remove("hidden");
      $("userLabel").textContent = username;
    }
    function setLoggedOut() {
      sessionToken = "";
      username = "";
      localStorage.removeItem("uclaw_admin_session");
      localStorage.removeItem("uclaw_admin_username");
      $("authPanel").classList.remove("hidden");
      $("appPanel").classList.add("hidden");
      $("logout").classList.add("hidden");
      $("userLabel").textContent = "未登录";
    }
    function showAuth(text, isError) {
      $("authMessage").textContent = text || "";
      $("authMessage").classList.toggle("error", Boolean(isError));
    }
    function showMessage(text, isError) {
      $("message").textContent = text || "";
      $("message").classList.toggle("error", Boolean(isError));
    }
    async function request(path, options) {
      const res = await fetch(path, options || {});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
      }
      return data;
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch]));
    }
    async function api(path, options) {
      if (!sessionToken) throw new Error("请先登录");
      const headers = { "Content-Type": "application/json", ...authHeader(), ...((options && options.headers) || {}) };
      return request(path, { ...(options || {}), headers });
    }
    async function init() {
      const setup = await request("/internal/admin/v1/auth/setup");
      $("register").classList.toggle("hidden", !setup.registrationOpen);
      $("bootstrapWrap").classList.toggle("hidden", !setup.registrationOpen);
      $("authTitle").textContent = setup.registrationOpen ? "首次注册管理员" : "管理员登录";
      if (sessionToken) {
        setLoggedIn(username || "admin");
        await loadCodes().catch((err) => {
          setLoggedOut();
          showAuth(err.message, true);
        });
      }
    }
    async function loginOrRegister(path) {
      const payload = { username: $("username").value, password: $("password").value };
      const headers = { "Content-Type": "application/json" };
      if (path.endsWith("/register") && $("bootstrapToken").value) {
        headers.Authorization = "Bearer " + $("bootstrapToken").value;
      }
      const data = await request(path, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      sessionToken = data.token;
      username = data.username;
      localStorage.setItem("uclaw_admin_session", sessionToken);
      localStorage.setItem("uclaw_admin_username", username);
      setLoggedIn(username);
      await loadCodes();
    }
    function fmtTime(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString();
    }
    function renderRows(codes) {
      $("mAll").textContent = codes.length;
      $("mUnused").textContent = codes.filter((x) => x.status === "unused").length;
      $("mBound").textContent = codes.filter((x) => x.status === "bound").length;
      $("mClosed").textContent = codes.filter((x) => x.status === "disabled" || x.status === "reissued").length;
      const body = $("rows");
      body.innerHTML = "";
      if (!codes.length) {
        body.innerHTML = '<tr><td colspan="10" class="empty">暂无记录</td></tr>';
        return;
      }
      for (const item of codes) {
        const tr = document.createElement("tr");
        const newapi = item.newapiUsername ? item.newapiUsername + (item.newapiUserId ? " #" + item.newapiUserId : "") : "-";
        const codeText = item.codeVisible && item.code ? item.code : (item.codeHint ? "****-" + item.codeHint : "旧码不可见");
        const activationText = item.latestActivationId ? item.latestActivationId : "-";
        const activationMeta = item.latestActivationStage ? '<div class="muted">' + esc(item.latestActivationStage) + (item.latestActivationCommit ? " · " + esc(fmtTime(item.latestActivationCommit)) : "") + "</div>" : "";
        tr.innerHTML =
          "<td>" + esc(item.id) + "</td>" +
          '<td class="mono">' + esc(codeText) + "</td>" +
          '<td><span class="badge ' + esc(item.status) + '">' + esc(item.status) + "</span></td>" +
          "<td>" + esc(item.boundPhone || "-") + (item.boundUserId ? '<div class="muted">U-Claw #' + esc(item.boundUserId) + "</div>" : "") + "</td>" +
          "<td>" + esc(newapi) + "</td>" +
          "<td>" + esc(item.newapiBaseUrl || "-") + "</td>" +
          "<td>" + esc(item.batchName || item.batchId || "-") + "</td>" +
          '<td><span class="mono">' + esc(activationText) + "</span>" + activationMeta + "</td>" +
          "<td>" + esc(fmtTime(item.createdAt)) + "</td>" +
          '<td><div class="row-actions"></div></td>';
        const actions = tr.querySelector(".row-actions");
        const copy = document.createElement("button");
        copy.className = "secondary";
        copy.textContent = "复制";
        copy.disabled = !item.code;
        copy.onclick = () => navigator.clipboard.writeText(item.code);
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
        actions.append(copy, disable, reissue);
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
      showMessage("已加载 " + (data.codes || []).length + " 条");
    }
    async function generateCodes() {
      const payload = {
        count: Number($("count").value || 1),
        batchName: $("batchName").value,
        note: $("note").value,
        createdBy: $("createdBy").value || username
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
        line.innerHTML = "<strong class='mono'>" + esc(item.code) + '</strong><button class="secondary">复制</button>';
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
      if (!confirm("旧码会标记为 reissued，新码会显示并进入列表。继续？")) return;
      const data = await api("/internal/admin/v1/activation-codes/" + id + "/reissue", { method: "POST", body: "{}" });
      const wrap = $("generated");
      wrap.innerHTML = '<div class="code-line"><strong class="mono">' + esc(data.code.code) + '</strong><button class="secondary">复制</button></div>';
      wrap.querySelector("button").onclick = () => navigator.clipboard.writeText(data.code.code);
      await loadCodes();
    }
    $("login").onclick = () => loginOrRegister("/internal/admin/v1/auth/login").catch((err) => showAuth(err.message, true));
    $("register").onclick = () => loginOrRegister("/internal/admin/v1/auth/register").catch((err) => showAuth(err.message, true));
    $("logout").onclick = setLoggedOut;
    $("load").onclick = () => loadCodes().catch((err) => showMessage(err.message, true));
    $("generate").onclick = () => generateCodes().catch((err) => showMessage(err.message, true));
    init().catch((err) => showAuth(err.message, true));
  </script>
</body>
</html>`
