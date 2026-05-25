// Shared sign-in modal, surfaced to anon visitors who tap a "logged-in
// only" action (heart, "I've been here", review). Used by /place and
// /map; can be opened from anywhere a button is wired up. Sign-in routes
// through ?returnTo= so the user lands back on the page they started on.
//
// Usage:
//   window.OPM.signinPopover.openFor(anchorEl, { returnTo: "/place/123" });
//
// The element + styles are owned by this module — it injects them on
// first use so callers don't need any markup in their template.
//
// The name "signinPopover" is historical; this is now a centered modal
// with a blurred backdrop, not an anchor-positioned popover.

(function () {
    const NS = (window.OPM = window.OPM || {});
    if (NS.signinPopover) return;

    let backdropEl = null;
    let modalEl = null;
    let signInLink = null;

    function ensureDom() {
        if (modalEl) return;
        injectStyle();
        backdropEl = document.createElement("div");
        backdropEl.className = "opm-signin-backdrop";
        backdropEl.hidden = true;

        modalEl = document.createElement("div");
        modalEl.className = "opm-signin-modal";
        modalEl.setAttribute("role", "dialog");
        modalEl.setAttribute("aria-modal", "true");
        modalEl.setAttribute("aria-label", "Sign in to save");
        modalEl.hidden = true;
        modalEl.innerHTML = [
            '<strong class="opm-signin-modal__title">Save this spot</strong>',
            '<p class="opm-signin-modal__body">Sign in to keep a wishlist of pizzerias you want to try.</p>',
            '<div class="opm-signin-modal__actions">',
            '  <a class="opm-signin-modal__primary" href="/api/auth/google" data-signin-link>',
            '    <span class="material-symbols-rounded" aria-hidden="true">login</span>',
            '    Sign in now',
            '  </a>',
            '  <button type="button" class="opm-signin-modal__cancel" data-signin-pop-close>Maybe later</button>',
            '</div>',
        ].join("");

        document.body.appendChild(backdropEl);
        document.body.appendChild(modalEl);
        signInLink = modalEl.querySelector("[data-signin-link]");

        modalEl.querySelector("[data-signin-pop-close]").addEventListener("click", close);
        backdropEl.addEventListener("click", close);
        document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    }

    function injectStyle() {
        if (document.getElementById("opm-signin-pop-style")) return;
        const style = document.createElement("style");
        style.id = "opm-signin-pop-style";
        style.textContent = [
            ".opm-signin-backdrop{position:fixed;inset:0;z-index:1099;background:rgba(20,20,20,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:opm-signin-fade .15s ease-out}",
            ".opm-signin-backdrop[hidden]{display:none}",
            ".opm-signin-modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1100;background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:22px 24px 20px;width:min(320px,calc(100vw - 32px));font-family:inherit;animation:opm-signin-pop .18s ease-out}",
            ".opm-signin-modal[hidden]{display:none}",
            ".opm-signin-modal__title{display:block;font-size:18px;font-weight:700;margin-bottom:6px;text-align:center}",
            ".opm-signin-modal__body{margin:0 0 18px;font-size:14px;color:#555;line-height:1.45;text-align:center}",
            ".opm-signin-modal__actions{display:flex;flex-direction:column;gap:8px}",
            ".opm-signin-modal__primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent,#c9483a);color:#fff;padding:11px 16px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none}",
            ".opm-signin-modal__primary .material-symbols-rounded{font-size:18px}",
            ".opm-signin-modal__primary:hover{filter:brightness(.95)}",
            ".opm-signin-modal__cancel{background:transparent;border:none;color:var(--ink-mute,#888);padding:8px;cursor:pointer;font-family:inherit;font-size:13px}",
            ".opm-signin-modal__cancel:hover{color:#333}",
            "@keyframes opm-signin-fade{from{opacity:0}to{opacity:1}}",
            "@keyframes opm-signin-pop{from{opacity:0;transform:translate(-50%,-46%)}to{opacity:1;transform:translate(-50%,-50%)}}",
        ].join("\n");
        document.head.appendChild(style);
    }

    function openFor(_anchor, opts) {
        ensureDom();
        const returnTo = opts && opts.returnTo;
        signInLink.href = returnTo
            ? "/api/auth/google?returnTo=" + encodeURIComponent(returnTo)
            : "/api/auth/google";
        backdropEl.hidden = false;
        modalEl.hidden = false;
        document.body.style.overflow = "hidden";
    }

    function close() {
        if (!modalEl) return;
        modalEl.hidden = true;
        backdropEl.hidden = true;
        document.body.style.overflow = "";
    }

    NS.signinPopover = { openFor: openFor, close: close };
})();
