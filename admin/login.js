'use strict';
/* Este archivo solo maneja el inicio de sesión.
   El código del panel (panel.js) el servidor solo lo entrega si ya hay sesión de administrador. */

window.APP = { csrf: '' };

const loginView = document.getElementById('loginView');
const panel = document.getElementById('panel');
const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');

function loadPanel() {
  loginView.hidden = true;
  panel.hidden = false;
  const s = document.createElement('script');
  s.src = '/admin/panel.js';
  s.onerror = () => { panel.hidden = true; loginView.hidden = false; };
  document.body.appendChild(s);
}

async function getCsrf() {
  const r = await fetch('/api/csrf', { credentials: 'same-origin' });
  window.APP.csrf = (await r.json()).csrf;
}

(async function start() {
  try {
    const me = await fetch('/api/admin/me', { credentials: 'same-origin' }).then((r) => r.json());
    if (me.admin) { window.APP.csrf = me.csrf; loadPanel(); return; }
    await getCsrf();
  } catch (e) { /* mostrar login igualmente */ }
  loginView.hidden = false;
})();

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  loginStatus.className = 'status';
  loginStatus.textContent = '';
  const btn = loginForm.querySelector('button');
  btn.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(loginForm).entries());
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.APP.csrf },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    window.APP.csrf = data.csrf;
    loginForm.reset();
    loadPanel();
  } catch (e) {
    loginStatus.classList.add('err');
    loginStatus.textContent = e.message;
    if (/no válida/i.test(e.message)) getCsrf();
  } finally {
    btn.disabled = false;
  }
});
