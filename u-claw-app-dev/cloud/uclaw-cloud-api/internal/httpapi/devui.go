package httpapi

import (
	"html/template"
	"net/http"

	"uclaw-cloud-api/internal/config"
)

// devAuthPageTemplate is an embedded local-only UI so the backend can be verified without a frontend build.
var devAuthPageTemplate = template.Must(template.New("dev-auth").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>U-Claw Auth 验收</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --line: #d9e3f2;
      --text: #111827;
      --muted: #64748b;
      --blue: #1677ff;
      --green: #14883e;
      --red: #c93434;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(960px, calc(100vw - 32px));
      margin: 48px auto;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
    }
    .badge {
      border: 1px solid var(--line);
      background: #eef5ff;
      color: #1d4ed8;
      padding: 8px 12px;
      border-radius: 6px;
      font-weight: 700;
      white-space: nowrap;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 0.85fr);
      gap: 16px;
      align-items: start;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      letter-spacing: 0;
    }
    label {
      display: block;
      margin: 14px 0 8px;
      color: #334155;
      font-weight: 700;
    }
    input {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      font-size: 15px;
      color: var(--text);
      background: #fff;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    button {
      height: 42px;
      border: 1px solid #9dc4ff;
      border-radius: 6px;
      padding: 0 16px;
      background: var(--blue);
      color: #fff;
      font-weight: 800;
      cursor: pointer;
    }
    button.secondary {
      background: #fff;
      color: #1d4ed8;
    }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .status {
      margin-top: 16px;
      min-height: 24px;
      color: var(--muted);
      font-size: 14px;
    }
    .status.ok { color: var(--green); }
    .status.err { color: var(--red); }
    dl {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 12px;
      margin: 0;
    }
    dt {
      color: var(--muted);
      font-weight: 700;
    }
    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    pre {
      min-height: 180px;
      margin: 16px 0 0;
      overflow: auto;
      background: #0f172a;
      color: #dbeafe;
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
      line-height: 1.5;
    }
    @media (max-width: 760px) {
      main { margin: 28px auto; }
      header { display: block; }
      .badge { display: inline-block; margin-top: 14px; }
      .layout { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; gap: 6px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>U-Claw Auth 验收</h1>
        <p class="subtitle">验证手机号验证码登录接口。此页面仅在非 production 环境开放。</p>
      </div>
      <div class="badge">env: {{.Env}}</div>
    </header>
    <div class="layout">
      <section>
        <h2>登录流程</h2>
        <label for="phone">手机号</label>
        <input id="phone" inputmode="tel" autocomplete="tel" value="13800138000">
        <label for="code">验证码</label>
        <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="发送后自动填入 devCode">
        <div class="actions">
          <button id="sendBtn" type="button">发送验证码</button>
          <button id="loginBtn" type="button" class="secondary">登录</button>
        </div>
        <div id="status" class="status">等待操作</div>
      </section>
      <section>
        <h2>登录结果</h2>
        <dl>
          <dt>用户</dt>
          <dd id="user">--</dd>
          <dt>Token</dt>
          <dd id="token">--</dd>
        </dl>
        <pre id="raw">{}</pre>
      </section>
    </div>
  </main>
  <script>
    const phone = document.querySelector('#phone');
    const code = document.querySelector('#code');
    const sendBtn = document.querySelector('#sendBtn');
    const loginBtn = document.querySelector('#loginBtn');
    const statusBox = document.querySelector('#status');
    const userBox = document.querySelector('#user');
    const tokenBox = document.querySelector('#token');
    const rawBox = document.querySelector('#raw');

    function setStatus(text, kind = '') {
      statusBox.className = 'status ' + kind;
      statusBox.textContent = text;
    }

    async function postJSON(path, payload) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      rawBox.textContent = JSON.stringify(data, null, 2);
      if (!res.ok) {
        throw new Error(data?.error?.message || res.statusText);
      }
      return data;
    }

    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      setStatus('发送中...');
      try {
        const data = await postJSON('/v1/auth/sms/send', { phone: phone.value, purpose: 'login' });
        if (data.devCode) code.value = data.devCode;
        setStatus('验证码已发送' + (data.devCode ? '，devCode 已填入' : ''), 'ok');
      } catch (err) {
        setStatus(err.message, 'err');
      } finally {
        sendBtn.disabled = false;
      }
    });

    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled = true;
      setStatus('登录中...');
      try {
        const data = await postJSON('/v1/auth/sms/login', { phone: phone.value, purpose: 'login', code: code.value });
        userBox.textContent = data.user.phone + ' (#' + data.user.id + ')';
        tokenBox.textContent = data.accessToken;
        setStatus('登录成功，access token 已签发', 'ok');
      } catch (err) {
        setStatus(err.message, 'err');
      } finally {
        loginBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`))

// writeDevAuthPage renders the local-only browser verification panel for SMS login.
func writeDevAuthPage(w http.ResponseWriter, cfg config.Config) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = devAuthPageTemplate.Execute(w, map[string]any{"Env": cfg.AppEnv})
}
