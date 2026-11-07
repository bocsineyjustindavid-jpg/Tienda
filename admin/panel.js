'use strict';
/* Panel de administración. Solo se entrega con sesión de administrador activa.
   Todo se pinta con createElement/textContent (sin innerHTML). */

(function () {
  const root = document.getElementById('panel');

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

  async function api(url, opts = {}) {
    const o = { method: 'GET', credentials: 'same-origin', headers: {}, ...opts };
    if (o.method !== 'GET') o.headers['X-CSRF-Token'] = window.APP.csrf;
    if (o.json !== undefined) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.json);
      delete o.json;
    }
    const r = await fetch(url, o);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { location.reload(); throw new Error('Sesión expirada.'); }
    if (!r.ok) throw new Error(data.error || 'Error inesperado.');
    return data;
  }

  const money = (n) => 'Q' + Number(n).toFixed(2);
  const when = (t) => new Date(t).toLocaleString('es-GT');
  const safeImg = (src) => (/^\/uploads\/[a-f0-9]+\.(jpg|png|webp)$/.test(src || '') ? src : null);

  function flash(el, msg, ok) {
    el.className = 'status ' + (ok ? 'ok' : 'err');
    el.textContent = msg;
  }

  /* ---------- Estructura ---------- */
  const content = h('div', {});
  const tabs = {};
  const views = { productos: viewProducts, mensajes: viewMessages, resenas: viewReviews, cuenta: viewAccount };
  const labels = { productos: 'Productos y estilos', mensajes: 'Mensajes', resenas: 'Reseñas', cuenta: 'Mi cuenta' };

  function show(name) {
    for (const k of Object.keys(tabs)) tabs[k].setAttribute('aria-selected', String(k === name));
    content.replaceChildren();
    views[name](content);
  }

  const tabBar = h('div', { class: 'tabs', role: 'tablist' },
    Object.keys(views).map((k) => {
      tabs[k] = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => show(k) }, labels[k]);
      return tabs[k];
    })
  );

  root.replaceChildren(
    h('div', { class: 'admin-head' },
      h('h1', {}, 'Panel de administración'),
      h('div', { class: 'row-actions' },
        h('a', { class: 'btn small ghost', href: '/', target: '_blank', rel: 'noopener' }, 'Ver tienda'),
        h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Cerrar sesión')
      )
    ),
    tabBar,
    content
  );

  async function logout() {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) { /* ignorar */ }
    location.reload();
  }

  /* ---------- Productos ---------- */
  async function viewProducts(box) {
    const status = h('p', { class: 'status', role: 'status' });
    const f = {
      id: h('input', { type: 'hidden', name: 'id' }),
      name: h('input', { name: 'name', required: true, maxlength: '100' }),
      category: h('input', { name: 'category', required: true, maxlength: '50', placeholder: 'Ej. Camisas, Vestidos, Pantalones' }),
      description: h('textarea', { name: 'description', rows: '3', maxlength: '600' }),
      price: h('input', { name: 'price', type: 'number', min: '0', step: '0.01', required: true }),
      stock: h('input', { name: 'stock', type: 'number', min: '0', step: '1', required: true, value: '0' }),
      sizes: h('input', { name: 'sizes', maxlength: '60', placeholder: 'Ej. S, M, L, XL' }),
      image: h('input', { name: 'image', type: 'file', accept: 'image/jpeg,image/png,image/webp' }),
      active: h('input', { name: 'active', type: 'checkbox', checked: true })
    };
    const title = h('h3', {}, 'Añadir nuevo estilo');
    const submitBtn = h('button', { class: 'btn', type: 'submit' }, 'Guardar');
    const cancelBtn = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: resetForm }, 'Cancelar edición');

    const field = (label, el) => h('label', {}, label, el);
    const form = h('form', { class: 'card form', novalidate: true },
      title, f.id,
      field('Nombre del estilo / prenda', f.name),
      field('Categoría', f.category),
      field('Descripción', f.description),
      field('Precio (Q)', f.price),
      field('Existencia (unidades)', f.stock),
      field('Tallas', f.sizes),
      field('Foto (JPG, PNG o WEBP, máx. 2 MB)', f.image),
      h('label', { class: 'check' }, f.active, ' Visible para clientes'),
      submitBtn, cancelBtn, status
    );

    function resetForm() {
      form.reset();
      f.id.value = '';
      f.active.checked = true;
      title.textContent = 'Añadir nuevo estilo';
      cancelBtn.hidden = true;
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const fd = new FormData();
      for (const k of ['name', 'category', 'description', 'price', 'stock', 'sizes']) fd.append(k, f[k].value);
      fd.append('active', f.active.checked ? '1' : '0');
      if (f.image.files[0]) fd.append('image', f.image.files[0]);
      const editing = f.id.value;
      submitBtn.disabled = true;
      try {
        await api(editing ? '/api/admin/products/' + encodeURIComponent(editing) : '/api/admin/products', {
          method: editing ? 'PUT' : 'POST', body: fd
        });
        flash(status, editing ? 'Producto actualizado.' : 'Estilo añadido.', true);
        resetForm();
        loadList();
      } catch (e) { flash(status, e.message, false); }
      finally { submitBtn.disabled = false; }
    });

    const tbody = h('tbody', {});
    const table = h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, ['Foto', 'Nombre', 'Categoría', 'Precio', 'Existencia', 'Estado', ''].map((t) => h('th', {}, t)))),
        tbody
      )
    );

    async function loadList() {
      const list = await api('/api/admin/products');
      tbody.replaceChildren(...list.map((p) => {
        const src = safeImg(p.image);
        return h('tr', {},
          h('td', {}, src ? h('img', { class: 'thumb', src, alt: '' }) : '—'),
          h('td', {}, p.name),
          h('td', {}, p.category),
          h('td', {}, money(p.price)),
          h('td', {}, String(p.stock)),
          h('td', {}, p.active ? 'Visible' : 'Oculto'),
          h('td', {}, h('div', { class: 'row-actions' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => edit(p) }, 'Editar'),
            h('button', { class: 'btn small danger', type: 'button', onclick: () => remove(p) }, 'Eliminar')
          ))
        );
      }));
      if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: '7' }, 'Aún no hay productos. Añade el primero.')));
    }

    function edit(p) {
      f.id.value = String(p.id);
      f.name.value = p.name; f.category.value = p.category; f.description.value = p.description;
      f.price.value = p.price; f.stock.value = p.stock; f.sizes.value = p.sizes; f.active.checked = !!p.active;
      f.image.value = '';
      title.textContent = 'Editando: ' + p.name;
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: 'smooth' });
    }

    async function remove(p) {
      if (!confirm('¿Eliminar "' + p.name + '"? Esta acción no se puede deshacer.')) return;
      try { await api('/api/admin/products/' + p.id, { method: 'DELETE' }); loadList(); }
      catch (e) { flash(status, e.message, false); }
    }

    box.append(h('div', { class: 'admin-grid' }, form, table));
    loadList().catch((e) => flash(status, e.message, false));
  }

  /* ---------- Mensajes ---------- */
  async function viewMessages(box) {
    const list = h('div', {});
    box.append(h('h2', {}, 'Mensajes de clientes'), list);
    async function load() {
      const msgs = await api('/api/admin/messages');
      list.replaceChildren(...msgs.map((m) =>
        h('article', { class: 'msg' + (m.is_read ? '' : ' unread') },
          h('div', {},
            h('span', { class: 'tag' }, m.type === 'compra' ? 'COMPRA' : 'DUDA'),
            h('strong', {}, m.name)
          ),
          h('div', { class: 'meta' },
            when(m.created_at),
            m.email ? ' · ' + m.email : '',
            m.phone ? ' · ' + m.phone : '',
            m.product_name ? ' · Prenda: ' + m.product_name : ''
          ),
          h('p', {}, m.message),
          h('div', { class: 'row-actions' },
            m.is_read ? null : h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await api('/api/admin/messages/' + m.id + '/read', { method: 'PATCH' }); load(); } }, 'Marcar leído'),
            h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (confirm('¿Eliminar este mensaje?')) { await api('/api/admin/messages/' + m.id, { method: 'DELETE' }); load(); } } }, 'Eliminar')
          )
        )
      ));
      if (!msgs.length) list.append(h('p', { class: 'muted' }, 'No hay mensajes todavía.'));
    }
    load().catch((e) => list.append(h('p', { class: 'status err' }, e.message)));
  }

  /* ---------- Reseñas ---------- */
  async function viewReviews(box) {
    const list = h('div', {});
    box.append(h('h2', {}, 'Reseñas (moderación)'), h('p', { class: 'muted' }, 'Solo las reseñas aprobadas se muestran a los clientes.'), list);
    async function load() {
      const items = await api('/api/admin/reviews');
      list.replaceChildren(...items.map((r) =>
        h('article', { class: 'msg' + (r.approved ? '' : ' unread') },
          h('div', {},
            h('span', { class: 'tag' }, r.approved ? 'PUBLICADA' : 'PENDIENTE'),
            h('strong', {}, r.name), ' · ',
            h('span', { class: 'stars' }, '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating))
          ),
          h('div', { class: 'meta' }, when(r.created_at)),
          h('p', {}, r.comment),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await api('/api/admin/reviews/' + r.id, { method: 'PATCH', json: { approved: !r.approved } }); load(); } }, r.approved ? 'Ocultar' : 'Aprobar y publicar'),
            h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (confirm('¿Eliminar esta reseña?')) { await api('/api/admin/reviews/' + r.id, { method: 'DELETE' }); load(); } } }, 'Eliminar')
          )
        )
      ));
      if (!items.length) list.append(h('p', { class: 'muted' }, 'No hay reseñas todavía.'));
    }
    load().catch((e) => list.append(h('p', { class: 'status err' }, e.message)));
  }

  /* ---------- Cuenta ---------- */
  function viewAccount(box) {
    const status = h('p', { class: 'status', role: 'status' });
    const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password', maxlength: '200' });
    const nw = h('input', { type: 'password', required: true, minlength: '12', autocomplete: 'new-password', maxlength: '200' });
    const form = h('form', { class: 'card form', novalidate: true },
      h('h3', {}, 'Cambiar contraseña'),
      h('label', {}, 'Contraseña actual', cur),
      h('label', {}, 'Nueva contraseña (12+ caracteres, con letras y números)', nw),
      h('button', { class: 'btn', type: 'submit' }, 'Actualizar'),
      status
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      try {
        await api('/api/admin/password', { method: 'POST', json: { current: cur.value, next: nw.value } });
        flash(status, 'Contraseña actualizada.', true);
        form.reset();
      } catch (e) { flash(status, e.message, false); }
    });
    box.append(form);
  }

  show('productos');
})();
