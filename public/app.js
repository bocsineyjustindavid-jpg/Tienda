'use strict';
/* Lado del cliente. Todo el contenido dinámico se inserta con textContent / createElement
   (nunca con innerHTML) para evitar XSS. */

const state = { csrf: '', products: [], config: { storeName: '', whatsapp: '' } };

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

const money = (n) => 'Q' + Number(n).toFixed(2);

async function loadCsrf() {
  const r = await fetch('/api/csrf', { credentials: 'same-origin' });
  state.csrf = (await r.json()).csrf;
}

async function post(url, body, retry = true) {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
    body: JSON.stringify(body)
  });
  if (r.status === 403 && retry) { await loadCsrf(); return post(url, body, false); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'No se pudo enviar. Intenta de nuevo.');
  return data;
}

/* ---------- WhatsApp ---------- */
function waLink(message) {
  const n = state.config.whatsapp;
  if (!/^\d{8,15}$/.test(n)) return null;
  return 'https://wa.me/' + n + '?text=' + encodeURIComponent(message);
}

function setupWhatsApp() {
  const link = waLink('Hola, vi su tienda en línea y quisiera más información.');
  for (const id of ['#waMain', '#waFloat']) {
    const a = $(id);
    if (link) { a.href = link; a.hidden = false; }
    else if (id === '#waMain') { a.setAttribute('aria-disabled', 'true'); a.removeAttribute('href'); a.textContent = 'WhatsApp no disponible'; }
  }
}

/* ---------- Catálogo ---------- */
function stockBadge(stock) {
  if (stock <= 0) return h('span', { class: 'badge out' }, 'Agotado');
  if (stock <= 3) return h('span', { class: 'badge low' }, 'Últimas ' + stock + ' unidades');
  return h('span', { class: 'badge ok' }, 'Disponible · ' + stock + ' en existencia');
}

function productCard(p) {
  const img = p.image && /^\/uploads\/[a-f0-9]+\.(jpg|png|webp)$/.test(p.image)
    ? h('img', { src: p.image, alt: p.name, loading: 'lazy' })
    : h('span', { 'aria-hidden': 'true' }, p.name.charAt(0).toUpperCase());

  const out = p.stock <= 0;
  const wa = waLink('Hola, me interesa: ' + p.name + ' (' + money(p.price) + '). ¿Está disponible?');

  const actions = h('div', { class: 'actions' },
    h('button', {
      class: 'btn small', type: 'button', disabled: out,
      onclick: () => chooseProduct(p.id)
    }, out ? 'Sin existencia' : 'Comprar / Preguntar'),
    wa ? h('a', { class: 'btn small ghost', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp') : null
  );

  return h('article', { class: 'product' },
    h('div', { class: 'img' }, img),
    h('div', { class: 'body' },
      h('span', { class: 'cat' }, p.category),
      h('h3', {}, p.name),
      p.description ? h('p', { class: 'desc' }, p.description) : null,
      p.sizes ? h('p', { class: 'desc' }, 'Tallas: ' + p.sizes) : null,
      h('span', { class: 'price' }, money(p.price)),
      stockBadge(p.stock),
      actions
    )
  );
}

function renderCatalog() {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#category').value;
  const only = $('#onlyStock').checked;
  const list = state.products.filter((p) =>
    (!cat || p.category === cat) &&
    (!only || p.stock > 0) &&
    (!q || (p.name + ' ' + p.description + ' ' + p.category).toLowerCase().includes(q))
  );
  const grid = $('#grid');
  grid.replaceChildren(...list.map(productCard));
  $('#empty').hidden = list.length > 0;
}

function fillFilters() {
  const cats = [...new Set(state.products.map((p) => p.category))].sort();
  const sel = $('#category');
  sel.replaceChildren(h('option', { value: '' }, 'Todas las categorías'), ...cats.map((c) => h('option', { value: c }, c)));

  const ps = $('#productSelect');
  ps.replaceChildren(
    h('option', { value: '' }, '— Ninguna en particular —'),
    ...state.products.map((p) => h('option', { value: String(p.id) }, p.name + (p.stock <= 0 ? ' (agotado)' : '')))
  );
}

function chooseProduct(id) {
  const form = $('#contactForm');
  form.elements.product_id.value = String(id);
  form.elements.type.value = 'compra';
  $('#contacto').scrollIntoView({ behavior: 'smooth' });
  form.elements.name.focus({ preventScroll: true });
}

async function loadProducts() {
  const r = await fetch('/api/products', { credentials: 'same-origin' });
  state.products = await r.json();
  fillFilters();
  renderCatalog();
}

/* ---------- Reseñas ---------- */
async function loadReviews() {
  const r = await fetch('/api/reviews', { credentials: 'same-origin' });
  const list = await r.json();
  $('#reviews').replaceChildren(...list.map((rv) =>
    h('article', { class: 'review' },
      h('div', { class: 'stars', 'aria-label': rv.rating + ' de 5 estrellas' }, '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating)),
      h('p', {}, rv.comment),
      h('div', { class: 'who' }, rv.name)
    )
  ));
  $('#noReviews').hidden = list.length > 0;
}

/* ---------- Formularios ---------- */
function bindForm(formSel, statusSel, url, onOk) {
  const form = $(formSel);
  const status = $(statusSel);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.className = 'status';
    status.textContent = '';
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      const data = await post(url, body);
      status.classList.add('ok');
      status.textContent = onOk(data);
      form.reset();
    } catch (e) {
      status.classList.add('err');
      status.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- Inicio ---------- */
(async function init() {
  $('#year').textContent = new Date().getFullYear();
  try {
    const [cfg] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      loadCsrf()
    ]);
    state.config = cfg;
    if (cfg.storeName) {
      $('#brand').textContent = cfg.storeName;
      $('#footName').textContent = cfg.storeName;
      document.title = cfg.storeName;
    }
  } catch (e) { /* la página sigue funcionando sin config */ }

  setupWhatsApp();
  $('#search').addEventListener('input', renderCatalog);
  $('#category').addEventListener('change', renderCatalog);
  $('#onlyStock').addEventListener('change', renderCatalog);

  bindForm('#contactForm', '#contactStatus', '/api/messages',
    () => '¡Gracias! Recibimos tu mensaje y te responderemos pronto.');
  bindForm('#reviewForm', '#reviewStatus', '/api/reviews',
    () => '¡Gracias por tu reseña! Se publicará después de ser revisada.');

  await Promise.all([loadProducts().catch(() => {}), loadReviews().catch(() => {})]);
})();
