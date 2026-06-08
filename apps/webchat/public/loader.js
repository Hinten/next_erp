// Embeddable loader for the Delfrance webchat widget.
//
// Usage on a tenant's page:
//   <script
//     src="https://webchat.example.com/loader.js"
//     data-tenant="<tenant-id>"
//     data-widget-url="https://webchat.example.com/"
//     async
//   ></script>
//
// Behavior:
// - data-tenant (required) and data-widget-url (optional; defaults to
//   the directory the loader was served from).
// - Injects a fixed-position iframe at the bottom-right with a trigger
//   button. Iframe loads <widgetUrl>?tenant=<tenant>.
// - postMessage protocol: widget posts {type:'unread',n} to update the
//   badge; host posts {type:'open' | 'close'} to toggle visibility.
(function () {
  var script = document.currentScript;
  var tenant = script && script.getAttribute('data-tenant');
  if (!tenant) {
    console.warn('[delfrance-webchat] data-tenant is required');
    return;
  }

  var widgetUrl =
    (script && script.getAttribute('data-widget-url')) || new URL('.', script.src).href;

  if (window.__delfranceWebchatMounted) return;
  window.__delfranceWebchatMounted = true;

  var open = false;

  var container = document.createElement('div');
  container.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483646;font-family:system-ui,sans-serif;';

  var trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute('aria-label', 'Abrir chat');
  trigger.style.cssText =
    'position:relative;display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#2563eb;color:#fff;border:0;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.18);font-size:24px;';
  trigger.textContent = '💬';

  var badge = document.createElement('span');
  badge.style.cssText =
    'position:absolute;top:-4px;right:-4px;background:#dc2626;color:#fff;border-radius:9999px;padding:2px 6px;font-size:11px;font-weight:600;display:none;';
  trigger.appendChild(badge);

  var frame = document.createElement('iframe');
  frame.src = widgetUrl + '?tenant=' + encodeURIComponent(tenant);
  frame.title = 'Atendimento';
  frame.style.cssText =
    'position:absolute;bottom:72px;right:0;width:360px;height:560px;max-height:calc(100vh - 96px);border:0;border-radius:12px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:none;';

  trigger.addEventListener('click', function () {
    open = !open;
    frame.style.display = open ? 'block' : 'none';
  });

  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'unread') {
      var n = Number(e.data.n) || 0;
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
    if (e.data.type === 'open') {
      open = true;
      frame.style.display = 'block';
    }
    if (e.data.type === 'close') {
      open = false;
      frame.style.display = 'none';
    }
  });

  container.appendChild(frame);
  container.appendChild(trigger);
  (document.body || document.documentElement).appendChild(container);
})();
