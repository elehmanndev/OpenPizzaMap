// Review modal (bottom-sheet on mobile, centred dialog on desktop) +
// star input. Talks to POST /api/places/:id/review and refreshes the
// place page's primary rating + community reviews list in place
// without a full reload.
(function () {
    "use strict";

    const modal = document.querySelector("[data-review-modal]");
    if (!modal) return;
    const placeId = modal.dataset.placeId;
    const placeName = modal.dataset.placeName;

    const submitBtn = modal.querySelector("[data-review-submit]");
    const errorEl = modal.querySelector("[data-review-error]");
    const commentEl = modal.querySelector("[data-review-comment]");
    const counterEl = modal.querySelector("[data-review-counter]");
    const form = modal.querySelector("[data-review-form]");
    const closeBtns = modal.querySelectorAll("[data-review-close]");

    // Build the 5-star inputs. Each star is a <button> with two hit zones:
    // left half = +0.5 of the previous star, right half = +1.0 (full).
    // value is held on the parent `.star-input` data-value, also fired as
    // a `change` event so the form state can pick it up.
    function buildStarInput(container) {
        container.innerHTML = "";
        container.dataset.value = container.dataset.value || "0";
        for (let i = 1; i <= 5; i++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "star-input__btn";
            btn.dataset.index = String(i);
            btn.setAttribute("aria-label", `${i} star${i === 1 ? "" : "s"}`);
            btn.innerHTML = `
                <span class="star-input__half star-input__half--left" data-half="0.5"></span>
                <span class="star-input__half star-input__half--right" data-half="1.0"></span>
                <span class="star-input__visual" aria-hidden="true">
                    <span class="star star--empty"></span>
                </span>
            `;
            container.appendChild(btn);
        }
        // Click delegated to halves.
        container.addEventListener("click", (ev) => {
            const half = ev.target.closest("[data-half]");
            if (!half) return;
            const btn = half.parentElement;
            const idx = Number(btn.dataset.index);
            const offset = half.dataset.half === "0.5" ? 0.5 : 1.0;
            const value = (idx - 1) + offset;
            container.dataset.value = String(value);
            renderStarValue(container, value);
            container.dispatchEvent(new CustomEvent("change", { detail: { value }, bubbles: true }));
        });
    }

    function renderStarValue(container, value) {
        const btns = container.querySelectorAll(".star-input__btn");
        btns.forEach((btn, i) => {
            const idx = i + 1;
            const visual = btn.querySelector(".star-input__visual");
            visual.innerHTML = "";
            const star = document.createElement("span");
            if (value >= idx) star.className = "star star--full";
            else if (value >= idx - 0.5) star.className = "star star--half";
            else star.className = "star star--empty";
            visual.appendChild(star);
        });
    }

    const starInputs = {};
    modal.querySelectorAll("[data-star-input]").forEach((el) => {
        starInputs[el.dataset.name] = el;
        buildStarInput(el);
    });

    // Price-range chips (added 2026-05-18 alongside the chatbot intake).
    // The hidden <input data-price-input value="…"> ships the
    // server-rendered current priceLevel so the chip pre-selects the
    // place's existing range; submitting updates it last-write-wins.
    const priceInput = modal.querySelector("[data-price-input]");
    const priceChips = modal.querySelectorAll("[data-price-chip]");
    function setPrice(v) {
        if (priceInput) priceInput.value = v == null ? "" : String(v);
        priceChips.forEach((chip) => {
            const on = chip.dataset.priceChip === String(v);
            chip.classList.toggle("is-active", on);
            chip.setAttribute("aria-pressed", String(on));
        });
    }
    if (priceInput && priceInput.value) setPrice(Number(priceInput.value));
    priceChips.forEach((chip) => {
        chip.addEventListener("click", () => {
            setPrice(Number(chip.dataset.priceChip));
            modal.dispatchEvent(new CustomEvent("change", { bubbles: true }));
        });
    });

    // Pre-fill from server-rendered existing review JSON, if any.
    const existingEl = document.getElementById("opm-existing-review");
    if (existingEl) {
        try {
            const data = JSON.parse(existingEl.textContent || "{}");
            for (const key of Object.keys(starInputs)) {
                if (data[key] != null) {
                    starInputs[key].dataset.value = String(data[key]);
                    renderStarValue(starInputs[key], Number(data[key]));
                }
            }
        } catch (_e) {}
    }

    function readValues() {
        const out = {};
        for (const key of Object.keys(starInputs)) {
            out[key] = Number(starInputs[key].dataset.value) || 0;
        }
        return out;
    }
    function allRated() {
        const v = readValues();
        return v.pizza > 0 && v.local > 0 && v.servicio > 0 && v.precio > 0;
    }
    function hasComment() {
        return !!(commentEl && commentEl.value.trim().length >= 4);
    }
    function updateSubmitState() {
        // Comment is now REQUIRED alongside the four star ratings —
        // server enforces the same min(4) so this is just UX.
        submitBtn.disabled = !(allRated() && hasComment());
    }
    modal.addEventListener("change", updateSubmitState);
    updateSubmitState();

    // Comment counter + submit-gate live update.
    function updateCounter() {
        const len = commentEl.value.length;
        counterEl.textContent = `${len} / 500`;
    }
    if (commentEl) {
        commentEl.addEventListener("input", () => {
            updateCounter();
            updateSubmitState();
        });
        updateCounter();
    }

    // Open / close.
    function openModal() {
        modal.hidden = false;
        // Focus first star button so keyboard users land in the right place.
        const firstBtn = modal.querySelector(".star-input__btn");
        if (firstBtn) firstBtn.focus();
        document.body.style.overflow = "hidden";
    }
    function closeModal() {
        modal.hidden = true;
        document.body.style.overflow = "";
        if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
    }
    closeBtns.forEach((b) => b.addEventListener("click", closeModal));
    document.addEventListener("keydown", (ev) => {
        if (!modal.hidden && ev.key === "Escape") closeModal();
    });

    // "He estado aquí" button.
    const openBtn = document.querySelector("[data-open-review]");
    const userIn = !!document.querySelector("body").dataset.userIn || true; // server-injected? fall through to fetch result for source-of-truth
    // We don't actually have a body data attr — derive userIn from the
    // backend by attempting the open and falling back. Simpler: hit /api/auth/me?
    // Pragmatic: attempt to open. If POST returns 401, redirect.
    if (openBtn) {
        openBtn.addEventListener("click", () => {
            openModal();
        });
    }

    // Submit.
    if (form) {
        form.addEventListener("submit", async (ev) => {
            ev.preventDefault();
            if (!allRated()) return;
            const values = readValues();
            const comment = commentEl ? commentEl.value.trim() : "";
            const priceLevelRaw = priceInput ? priceInput.value : "";
            const priceLevel = priceLevelRaw ? Number(priceLevelRaw) : undefined;
            submitBtn.disabled = true;
            const prevLabel = submitBtn.textContent;
            submitBtn.textContent = "Sending…";
            errorEl.hidden = true; errorEl.textContent = "";
            try {
                const body = { ...values, comment };
                if (priceLevel) body.priceLevel = priceLevel;
                const resp = await fetch(`/api/places/${placeId}/review`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                if (resp.status === 401) {
                    // Not logged in — bounce to /auth, preserve return path.
                    window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
                    return;
                }
                if (!resp.ok) {
                    const j = await resp.json().catch(() => ({}));
                    throw new Error(j.error || `HTTP ${resp.status}`);
                }
                const data = await resp.json();
                showToast("Thanks for the review!");
                closeModal();
                // Refresh the page so the new review + recomputed
                // opmRating + button label are in sync. Could update
                // in-place but a full reload is cheap and avoids drift.
                setTimeout(() => window.location.reload(), 400);
                // Update primary rating display in case reload is slow.
                const primary = document.querySelector("[data-place-rating]");
                if (primary && data.opmRating != null) primary.dataset.placeRating = String(data.opmRating);
            } catch (err) {
                errorEl.textContent = err.message || "Couldn't send your review.";
                errorEl.hidden = false;
                submitBtn.disabled = false;
                submitBtn.textContent = prevLabel;
            }
        });
    }

    // Toast.
    const toastEl = document.querySelector("[data-opm-toast]");
    function showToast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.hidden = false;
        toastEl.classList.add("is-shown");
        setTimeout(() => {
            toastEl.classList.remove("is-shown");
            setTimeout(() => { toastEl.hidden = true; }, 300);
        }, 1800);
    }

    // Relative-time refresh: server rendered Spanish via simple math; on the
    // client, override with Intl.RelativeTimeFormat using the user's locale.
    if ("RelativeTimeFormat" in Intl) {
        const rtf = new Intl.RelativeTimeFormat(navigator.language || "en", { numeric: "auto" });
        const fmt = (msAgo) => {
            const sec = Math.round(msAgo / 1000);
            const min = Math.round(sec / 60);
            const hr = Math.round(min / 60);
            const day = Math.round(hr / 24);
            const mo = Math.round(day / 30);
            const yr = Math.round(mo / 12);
            if (sec < 60) return rtf.format(-sec, "second");
            if (min < 60) return rtf.format(-min, "minute");
            if (hr < 24) return rtf.format(-hr, "hour");
            if (day < 30) return rtf.format(-day, "day");
            if (mo < 12) return rtf.format(-mo, "month");
            return rtf.format(-yr, "year");
        };
        document.querySelectorAll("[data-rel-time]").forEach((el) => {
            const dt = el.getAttribute("datetime");
            if (!dt) return;
            const ms = Date.now() - new Date(dt).getTime();
            if (Number.isFinite(ms)) el.textContent = fmt(ms);
        });
    }

    // Carousel chevron nav (desktop-only — hidden via CSS on mobile,
    // touch swipe is enough there). Each click scrolls by one card-
    // worth of width so scroll-snap lands on the next card boundary.
    (function setupCarouselNav() {
        const rail = document.querySelector("[data-reviews-rail]");
        if (!rail) return;
        const railList = rail.querySelector("[data-reviews-list]");
        const prevBtn = rail.querySelector("[data-rail-prev]");
        const nextBtn = rail.querySelector("[data-rail-next]");
        if (!railList || !prevBtn || !nextBtn) return;

        function stepPx() {
            const card = railList.querySelector(".opm-review");
            if (!card) return 240;
            // Card width + the list's column-gap so we land on the next
            // snap boundary in one click.
            const gap = parseFloat(getComputedStyle(railList).columnGap) || 16;
            return card.getBoundingClientRect().width + gap;
        }

        function update() {
            const max = railList.scrollWidth - railList.clientWidth;
            // Threshold = 8px to absorb scroll-snap micro-offsets at the
            // boundary (browsers sometimes settle scrollLeft 2-5px off
            // from the absolute edge after a snap).
            const atStart = railList.scrollLeft <= 8;
            const atEnd = railList.scrollLeft >= max - 8;
            const canScroll = max > 16;
            // Hide both chevrons entirely if there's nothing to scroll
            // (e.g., 1-2 reviews that fit without overflow on desktop).
            // Otherwise show them but disable when at the relevant end.
            prevBtn.hidden = !canScroll;
            nextBtn.hidden = !canScroll;
            prevBtn.disabled = atStart;
            nextBtn.disabled = atEnd;
        }

        prevBtn.addEventListener("click", () => {
            railList.scrollBy({ left: -stepPx(), behavior: "smooth" });
        });
        nextBtn.addEventListener("click", () => {
            railList.scrollBy({ left: stepPx(), behavior: "smooth" });
        });
        railList.addEventListener("scroll", update, { passive: true });
        window.addEventListener("resize", update);
        update();
    })();

    // "Ver más reviews" pagination.
    const list = document.querySelector("[data-reviews-list]");
    const moreBtn = document.querySelector("[data-load-more-reviews]");
    if (list && moreBtn) {
        moreBtn.addEventListener("click", async () => {
            const placeId = list.dataset.placeId;
            const loaded = Number(list.dataset.loadedCount) || 0;
            const total = Number(list.dataset.total) || 0;
            const pageSize = Number(list.dataset.pageSize) || 10;
            moreBtn.disabled = true;
            moreBtn.textContent = "Cargando…";
            try {
                const resp = await fetch(`/api/places/${placeId}/reviews?limit=${pageSize}&offset=${loaded}`);
                if (!resp.ok) throw new Error("Error");
                const data = await resp.json();
                for (const r of data.reviews) {
                    list.appendChild(renderReviewLi(r));
                }
                const newLoaded = loaded + data.reviews.length;
                list.dataset.loadedCount = String(newLoaded);
                if (newLoaded >= (data.total || total)) {
                    moreBtn.remove();
                } else {
                    moreBtn.disabled = false;
                    moreBtn.textContent = "Show more";
                }
            } catch (_e) {
                moreBtn.disabled = false;
                moreBtn.textContent = "Try again";
            }
        });
    }

    function starsHtml(value, sizeClass) {
        const value5 = Number(value);
        const cls = sizeClass || "stars--md";
        let html = `<span class="stars ${cls}" role="img" aria-label="${value5.toFixed(1)} out of 5">`;
        for (let i = 1; i <= 5; i++) {
            let kind;
            if (value5 >= i) kind = "full";
            else if (value5 >= i - 0.5) kind = "half";
            else kind = "empty";
            html += `<span class="star star--${kind}" aria-hidden="true"></span>`;
        }
        return html + "</span>";
    }

    function renderReviewLi(r) {
        const li = document.createElement("li");
        li.className = "opm-review";
        const userName = (r.userName || "user").replace(/[<>&]/g, "");
        const dt = new Date(r.createdAt);
        const iso = isNaN(dt) ? "" : dt.toISOString();
        let relText = "hace un momento";
        if (!isNaN(dt) && "RelativeTimeFormat" in Intl) {
            const rtf = new Intl.RelativeTimeFormat(navigator.language || "en", { numeric: "auto" });
            const ms = Date.now() - dt.getTime();
            const min = Math.round(ms / 60000), hr = Math.round(min / 60), day = Math.round(hr / 24);
            if (ms < 60000) relText = rtf.format(-Math.round(ms / 1000), "second");
            else if (min < 60) relText = rtf.format(-min, "minute");
            else if (hr < 24) relText = rtf.format(-hr, "hour");
            else relText = rtf.format(-day, "day");
        }
        const avg = (Number(r.pizza) + Number(r.local) + Number(r.servicio) + Number(r.precio)) / 4;
        const initial = userName.trim().charAt(0).toUpperCase() || "?";
        const safeInitial = initial.replace(/[<>&"]/g, "");
        const avatarHtml = r.userAvatar
            ? `<span class="opm-review__avatar opm-review__avatar--img"><img alt="" referrerpolicy="no-referrer" onerror="this.parentNode.outerHTML='<span class=&quot;opm-review__avatar&quot; aria-hidden=&quot;true&quot;>${safeInitial}</span>'" /></span>`
            : `<span class="opm-review__avatar" aria-hidden="true">${safeInitial}</span>`;
        li.innerHTML = `
            <div class="opm-review__head">
                <div class="opm-review__who">
                    ${avatarHtml}
                    <div class="opm-review__id">
                        <span class="opm-review__user"></span>
                        <time class="opm-review__time" datetime="${iso}"></time>
                    </div>
                </div>
                <div class="opm-review__badge" title="Average across Pizza, Setting, Service, Value (out of 5)" aria-label="${avg.toFixed(1)} out of 5">
                    <strong>${avg.toFixed(1)}</strong>
                </div>
            </div>
            ${r.comment ? `<blockquote class="opm-review__comment"></blockquote>` : ""}
        `;
        li.querySelector(".opm-review__user").textContent = userName;
        li.querySelector(".opm-review__time").textContent = relText;
        if (r.comment) li.querySelector(".opm-review__comment").textContent = r.comment;
        // Set the avatar <img> src AFTER the HTML is in the DOM so the
        // browser's resource loader picks it up (innerHTML assignment
        // doesn't fire load on already-attached <img> if the src is
        // baked in via a template literal that contains an inline
        // onerror handler — Chrome is finicky here).
        if (r.userAvatar) {
            const img = li.querySelector(".opm-review__avatar--img img");
            if (img) img.src = r.userAvatar;
        }
        return li;
    }
})();
