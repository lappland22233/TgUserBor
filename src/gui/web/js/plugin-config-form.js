/**
 * PluginConfigForm — Schema-driven configuration form renderer.
 * Renders form controls from a ConfigField[] schema, with real-time validation.
 * Falls back to JSON textarea mode when no schema is provided.
 */
(function () {
  'use strict';

  /** Render a form into `container` from schema + current values. */
  function render(container, schema, values) {
    if (!schema || !schema.length) {
      container.innerHTML = '<p class="plugin-config-no-schema">该插件未声明 configSchema，请使用 JSON 模式编辑。</p>';
      return;
    }

    const defaults = buildDefaults(schema);
    const merged = Object.assign({}, defaults, values || {});

    // Group fields by `group` (ungrouped → "通用")
    const groups = {};
    for (const f of schema) {
      const g = f.group || '通用';
      if (!groups[g]) groups[g] = [];
      groups[g].push(f);
    }

    let html = '';
    for (const [groupName, fields] of Object.entries(groups)) {
      html += `<fieldset class="plugin-config-group"><legend>${esc(groupName)}</legend>`;
      for (const f of fields) {
        html += renderField(f, merged[f.key]);
      }
      html += '</fieldset>';
    }
    container.innerHTML = html;

    // Bind change events for live validation
    container.addEventListener('input', (e) => {
      const wrap = e.target.closest('.plugin-config-field');
      if (wrap) validateField(wrap, schema.find((s) => s.key === wrap.dataset.key));
    });
    container.addEventListener('change', (e) => {
      const wrap = e.target.closest('.plugin-config-field');
      if (wrap) validateField(wrap, schema.find((s) => s.key === wrap.dataset.key));
    });
  }

  function renderField(field, value) {
    const id = `pcf-${field.key}`;
    const desc = field.description ? `<div class="pcf-desc">${esc(field.description)}</div>` : '';
    const err = `<div class="pcf-error" id="pcf-err-${field.key}" style="display:none;"></div>`;
    let control = '';

    switch (field.type) {
      case 'boolean':
        control = `
          <label class="pcf-switch">
            <input type="checkbox" id="${id}" data-key="${esc(field.key)}" ${value ? 'checked' : ''}>
            <span class="pcf-switch-slider"></span>
            <span class="pcf-switch-label">${esc(field.label)}</span>
          </label>`;
        break;

      case 'number':
        control = `
          <label class="pcf-label" for="${id}">${esc(field.label)}</label>
          <input type="number" class="form-input" id="${id}" data-key="${esc(field.key)}"
            value="${value != null ? esc(String(value)) : ''}"
            ${field.min != null ? `min="${field.min}"` : ''}
            ${field.max != null ? `max="${field.max}"` : ''}
            ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''}>`;
        break;

      case 'select':
        control = `
          <label class="pcf-label" for="${id}">${esc(field.label)}</label>
          <select class="form-select" id="${id}" data-key="${esc(field.key)}">
            ${(field.options || []).map((o) =>
              `<option value="${esc(String(o.value))}" ${String(value) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`
            ).join('')}
          </select>`;
        break;

      case 'multiselect':
        control = `
          <label class="pcf-label">${esc(field.label)}</label>
          <div class="pcf-multiselect" data-key="${esc(field.key)}">
            ${(field.options || []).map((o) => {
              const checked = Array.isArray(value) && value.some((v) => String(v) === String(o.value));
              return `<label class="pcf-check-item">
                <input type="checkbox" data-multi-value="${esc(String(o.value))}" ${checked ? 'checked' : ''}>
                <span>${esc(o.label)}</span>
              </label>`;
            }).join('')}
          </div>`;
        break;

      case 'textarea':
        control = `
          <label class="pcf-label" for="${id}">${esc(field.label)}</label>
          <textarea class="form-textarea" id="${id}" data-key="${esc(field.key)}"
            rows="3" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''}>${value != null ? esc(String(value)) : ''}</textarea>`;
        break;

      case 'color':
        control = `
          <label class="pcf-label" for="${id}">${esc(field.label)}</label>
          <input type="color" class="pcf-color" id="${id}" data-key="${esc(field.key)}"
            value="${value != null ? esc(String(value)) : '#007aff'}">`;
        break;

      case 'string':
      default:
        control = `
          <label class="pcf-label" for="${id}">${esc(field.label)}</label>
          <input type="text" class="form-input" id="${id}" data-key="${esc(field.key)}"
            value="${value != null ? esc(String(value)) : ''}"
            ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''}>`;
        break;
    }

    return `<div class="plugin-config-field" data-key="${esc(field.key)}" data-type="${esc(field.type)}">
      ${control}${desc}${err}
    </div>`;
  }

  /** Extract form values as a plain object. */
  function toJSON(container, schema) {
    const result = {};
    for (const field of schema) {
      const wrap = container.querySelector(`.plugin-config-field[data-key="${field.key}"]`);
      if (!wrap) continue;

      if (field.type === 'boolean') {
        const cb = wrap.querySelector('input[type="checkbox"]');
        result[field.key] = cb ? cb.checked : !!field.default;
      } else if (field.type === 'multiselect') {
        const boxes = wrap.querySelectorAll('input[type="checkbox"]');
        result[field.key] = Array.from(boxes).filter((b) => b.checked).map((b) => {
          const raw = b.dataset.multiValue;
          return isNaN(Number(raw)) ? raw : Number(raw);
        });
      } else if (field.type === 'number') {
        const inp = wrap.querySelector('input, textarea, select');
        const v = inp ? inp.value : '';
        result[field.key] = v === '' ? (field.default != null ? field.default : 0) : Number(v);
      } else {
        const inp = wrap.querySelector('input, textarea, select');
        result[field.key] = inp ? inp.value : '';
      }
    }
    return result;
  }

  /** Validate the entire form; returns true if valid. */
  function validate(container, schema) {
    let ok = true;
    for (const field of schema) {
      const wrap = container.querySelector(`.plugin-config-field[data-key="${field.key}"]`);
      if (wrap && !validateField(wrap, field)) ok = false;
    }
    return ok;
  }

  /** Validate a single field; updates UI and returns true if valid. */
  function validateField(wrap, field) {
    if (!field) return true;
    const errEl = wrap.querySelector('.pcf-error');
    let err = '';

    if (field.type === 'boolean') {
      // Booleans always valid
    } else if (field.type === 'multiselect') {
      const boxes = wrap.querySelectorAll('input[type="checkbox"]:checked');
      if (field.required && boxes.length === 0) err = '至少选择一项';
    } else {
      const inp = wrap.querySelector('input, textarea, select');
      const v = inp ? inp.value.trim() : '';
      if (field.required && !v) {
        err = '此字段为必填项';
      } else if (field.type === 'number' && v) {
        const n = Number(v);
        if (isNaN(n)) {
          err = '必须是数字';
        } else if (field.min != null && n < field.min) {
          err = `不能小于 ${field.min}`;
        } else if (field.max != null && n > field.max) {
          err = `不能大于 ${field.max}`;
        }
      } else if ((field.type === 'select') && v && field.options) {
        const valid = field.options.some((o) => String(o.value) === v);
        if (!valid) err = '无效选项';
      }
    }

    if (err) {
      if (errEl) { errEl.textContent = err; errEl.style.display = 'block'; }
      wrap.classList.add('pcf-invalid');
      return false;
    }
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    wrap.classList.remove('pcf-invalid');
    return true;
  }

  /** Build default values from schema. */
  function buildDefaults(schema) {
    const d = {};
    for (const f of schema) {
      if (f.default !== undefined) d[f.key] = f.default;
    }
    return d;
  }

  /** Reset form to schema defaults. */
  function resetToDefaults(container, schema) {
    if (!schema) return;
    for (const field of schema) {
      const wrap = container.querySelector(`.plugin-config-field[data-key="${field.key}"]`);
      if (!wrap) continue;
      const v = field.default;

      if (field.type === 'boolean') {
        const cb = wrap.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = !!v;
      } else if (field.type === 'multiselect') {
        const boxes = wrap.querySelectorAll('input[type="checkbox"]');
        boxes.forEach((b) => {
          const raw = b.dataset.multiValue;
          b.checked = Array.isArray(v) && v.some((x) => String(x) === raw);
        });
      } else {
        const inp = wrap.querySelector('input, textarea, select');
        if (inp) inp.value = v != null ? String(v) : '';
      }
    }
    // Clear errors
    container.querySelectorAll('.pcf-error').forEach((el) => { el.textContent = ''; el.style.display = 'none'; });
    container.querySelectorAll('.pcf-invalid').forEach((el) => el.classList.remove('pcf-invalid'));
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Expose globally
  window.PluginConfigForm = { render, toJSON, validate, resetToDefaults, buildDefaults };
})();
